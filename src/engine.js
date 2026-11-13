import { add, sub, mul, dot, cross, norm, dist } from "./vec.js";
import { buildGeometry, SHAPE_DEFAULT } from "./geometry.js";
import { parsePDB, parseStructure, readStructureFile } from "./parse.js";
import { fetchAFDB, describeAFDB } from "./afdb.js";
import KRAS_6GJ8 from "./data/kras-6gj8.js";
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";
import { surfaceMesh, meshAO, meshPoints, RES_BALL } from "./surface.js";
import { createGLView } from "./glview.js";
import { cartoonMesh } from "./cartoon.js";
import { sideChainMesh, ligandMesh, sideChainPoints, ligandPoints, ELEMENT_RGB, elementCss } from "./sticks.js";

// ---------------------------------------------------------------------------------------
// createAsciiFold(container, options) → view
//
// Renders a protein as spinning ASCII text that dissolves into a cartoon ribbon. The view
// fills `container` and follows its size. The cartoon (or surface) is drawn on one canvas and
// the text, glyphs placed on the model's 3D surfaces, on a second canvas laid over it; both share
// one projection, so they always line up.
// ---------------------------------------------------------------------------------------

export const PALETTES = {
  paper: { bg: "#F2ECDF", ink: "#1B1A18", H: "#D33A2C", E: "#1F63B0", C: "#C99410",
           P: ["#0053D6", "#65CBF3", "#D9B400", "#FF7D45"] },
  night: { bg: "#696969", ink: "#F2ECDF", H: "#D33A2C", E: "#1F63B0", C: "#EFB52E",
           P: ["#0053D6", "#65CBF3", "#FFDB13", "#FF7D45"] },
};
export const GLYPHS = { classic: " .,:;-=+*x#%@", blocks: " ·░░▒▒▓▓██", geo: " ·∙•◦○◎●◉■" };
// ChimeraX's basic colours (its Actions → Color menu), with ChimeraX's CSS values
export const COLOURS = [
  ["red", "#ff0000"], ["orange red", "#ff4500"], ["orange", "#ffa500"], ["yellow", "#ffff00"],
  ["green", "#008000"], ["forest green", "#228b22"], ["cyan", "#00ffff"], ["light sea green", "#20b2aa"],
  ["blue", "#0000ff"], ["cornflower blue", "#6495ed"], ["medium blue", "#0000cd"], ["purple", "#800080"],
  ["hot pink", "#ff69b4"], ["magenta", "#ff00ff"], ["white", "#ffffff"], ["light gray", "#d3d3d3"],
  ["gray", "#808080"], ["dark gray", "#a9a9a9"], ["dim gray", "#696969"], ["black", "#000000"],
];
// more CSS names (ChimeraX accepts these too), including the app's favourite swatches
const MORE_COLOURS = [["deep sky blue", "#00bfff"], ["light sky blue", "#87cefa"], ["steel blue", "#4682b4"], ["cadet blue", "#5f9ea0"],
  ["dark cyan", "#008b8b"], ["tomato", "#ff6347"], ["coral", "#ff7f50"], ["medium violet red", "#c71585"],
  ["pale violet red", "#db7093"], ["indian red", "#cd5c5c"], ["crimson", "#dc143c"]];
const COLOUR_HEX = Object.fromEntries([...COLOURS, ...MORE_COLOURS].map(([n, h]) => [n.replace(/\s+/g, ""), h]));
const ONE = { ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I", LEU: "L", LYS: "K",
  MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V", MSE: "M", SEC: "U", PYL: "O" };
/** "cornflower blue", "cornflowerblue", "#6495ed" or "6495ed" → "#6495ed"; anything else → null */
export function solidColour(v) {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase().replace(/\s+/g, "").replace("grey", "gray");
  if (COLOUR_HEX[k]) return COLOUR_HEX[k];
  const m = k.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/);
  return m ? "#" + (m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]) : null;
}
export const DETAIL = { xcoarse: 32, coarse: 46, medium: 64 };   // text rows; columns follow width
export const DEFAULTS = {
  theme: "paper", colour: "ss", layout: "lr", glyphs: "classic", detail: "medium",
  perspective: 1, surface: false, depth: 0.6, faces: false, sidechains: "none", ligands: true,
  spin: 0, blendFrom: 0.4, blendTo: 0.6, interactive: true, background: true, palette: null,
  font: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
};

const MAX_CELLS = 70000, ZMIN = 0.4, ZMAX = 10;
const LIGAND_CARBON = "#a9a9a9";   // a ligand's carbons, until recoloured ("dark gray"); an ion keeps its element's colour
const PERSP = 0.45;          // perspective 1 puts the camera R / 0.45 from the centre
const MAX_GLYPHS = 60000;    // 3D text: cap on surface glyphs, the spacing grows to fit
const GLYPH_SPRITE = 1.25;   // 3D text: sprite size in text rows (the glyph em is 0.8 of the sprite, so one row)
const ALONG = 0.8, AROUND = 0.7;   // 3D text: glyph spacing along the chain and across/around it, in text rows
const DS = 2;                 // 3D text: depth-buffer cells per text cell, each way
// Lighting, after ChimeraX's "lighting gentle": mostly ambient light with ambient occlusion,
// a little directional light and no highlights. Occlusion comes from the Cα density within AO_R of a
// point AO_OFF Å outside the surface, mapped per structure so its 10th–90th percentile spans 1…AO_MIN.
const AO_R = 9, AO_OFF = 2.2, AO_MIN = 0.15;
const G_AMB = 0.15, G_DIR = 0.27, G_AO = 0.58;
const SURF_SPACING = 0.75;   // surface: point spacing, in text rows
const SURFEL = 1.05;         // surface: disc radius, in point spacings (enough overlap to close the surface)
const DCELL = 32, SHADES = 24;   // disc atlas: px per disc, shade steps
const KNOCK = 0.68;          // 3D text: paper disc behind each glyph, in sprites, hides ink further back
const CELL = 64, FOGS = 6, FOG_MAX = 0.55;   // glyph atlas: px per sprite, depth-fog steps, fog at the back
const LIGHT = norm([-0.45, 0.55, 0.75]);   // key light, from the upper left front
// depth cue as in ChimeraX: nothing in the front half, rising to full strength at the back
// (dt: 0 at the back of the model, 1 at the front)
// Orientation is a rotation matrix (3×3, row-major) from model to view coordinates, turned like a
// trackball: every drag and the spin rotate about the screen's own axes, with no limits.
const rotMat = (y, x) => { const cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x); return [cy, 0, sy, sx * sy, cx, -sx * cy, -cx * sy, sx, cx * cy]; };
const matMul = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
const turn = (aboutY, aboutX, M) => {   // rotate about the screen's vertical, then horizontal axis; re-orthonormalise
  const T = matMul(rotMat(0, aboutX), matMul(rotMat(aboutY, 0), M));
  const r0 = norm(T.slice(0, 3)), r1 = norm(sub(T.slice(3, 6), mul(r0, dot(T.slice(3, 6), r0))));
  return [...r0, ...r1, ...cross(r0, r1)];
};
const HOME = rotMat(0.6, -0.35);
const clamp01 = v => Math.max(0, Math.min(1, +v || 0));
const fogOf = dt => Math.max(0, Math.min(1, (0.5 - dt) / 0.5));
const hex = h => { h = h.trim().replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a))); return t * t * (3 - 2 * t); };

export function createAsciiFold(container, options = {}) {
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const o = { ...DEFAULTS, ...(reduceMotion && options.spin === undefined ? { spin: 0 } : {}), ...options };
  let shape = { ...SHAPE_DEFAULT, ...(options.shape || {}) };
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach(fn => fn(d));

  // ---------- DOM ----------
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const root = document.createElement("div");
  root.className = "ascii-fold";
  root.style.cssText = "position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none;touch-action:none;";
  const inner = document.createElement("div");
  inner.style.cssText = "position:relative;width:max-content;";
  const rib = document.createElement("canvas");
  rib.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
  rib.setAttribute("aria-hidden", "true");
  const txt = document.createElement("canvas");
  txt.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
  txt.setAttribute("aria-hidden", "true");
  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;line-height:1;font-weight:700;left:-9999px;top:0;";
  inner.append(rib, txt);
  root.append(inner, probe);
  container.append(root);
  root.setAttribute("role", "img");

  const rctx = rib.getContext("2d"), tctx = txt.getContext("2d");
  const mask = document.createElement("canvas"), mctx = mask.getContext("2d");

  // ---------- state ----------
  let G = null, lastParsed = null, info = null;
  let COLS = 112, ROWS = 64, cw = 8, lh = 13, aspect = 0.6;
  let Rm = HOME.slice(), zoom = 1, panX = 0, panY = 0;
  let mimg, HASH, zbuf, lbuf, cbuf, fcol, dbuf, lastGrid = [];
  let PAL = null, SOLID = null, ramp = GLYPHS.classic;
  let geomId = 0, txtDirty = false, fontEpoch = 0, surfBalls = null;
  const ovr = new Map();   // residue index → colour ("ss", "plddt", or css) set from the sequence
  let ovrVer = 0, ctab = null;
  const is3D = () => o.layout !== "ribbon";   // is any text shown

  function alloc() {
    mask.width = COLS; mask.height = ROWS;
    mimg = mctx.createImageData(COLS, ROWS);
    const n = COLS * ROWS;
    HASH = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; HASH[i] = x - Math.floor(x); }
    zbuf = new Float32Array(n); lbuf = new Float32Array(n); cbuf = new Float32Array(n);
    fcol = new Float32Array(COLS); dbuf = new Float32Array(n * DS * DS);
  }

  function applyStyle() {
    const p = { ...PALETTES[o.theme] || PALETTES.paper, ...(o.palette || {}) };
    PAL = { paper: hex(p.bg), ink: hex(p.ink), H: hex(p.H), E: hex(p.E), C: hex(p.C), P: p.P.map(hex), css: p };
    const sc = o.colour === "ss" || o.colour === "plddt" ? null : solidColour(o.colour);
    SOLID = sc ? { css: sc, rgb: hex(sc) } : null;
    probe.style.fontFamily = o.font;
    root.style.background = o.background ? p.bg : "transparent";
    ramp = GLYPHS[o.glyphs] || (typeof o.glyphs === "string" && o.glyphs.length > 2 ? o.glyphs : GLYPHS.classic);
    root.style.cursor = o.interactive ? "grab" : "default";
  }

  function fit() {
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) return;
    probe.style.fontSize = "100px";
    const ratio = probe.getBoundingClientRect().width / 10 / 100 || 0.6;
    let rows = typeof o.detail === "number" ? o.detail : (DETAIL[o.detail] || DETAIL.medium), fs = H / rows;
    while (rows > 16 && rows * Math.floor(W / (fs * ratio)) > MAX_CELLS) { rows -= 2; fs = H / rows; }
    probe.style.fontSize = fs + "px";
    cw = probe.getBoundingClientRect().width / 10 || fs * ratio; lh = fs; aspect = cw / lh;
    const cols = Math.max(16, Math.floor(W / cw));
    if (cols !== COLS || rows !== ROWS || !HASH) { COLS = cols; ROWS = rows; alloc(); }
    const dpr = window.devicePixelRatio || 1;
    // the text and model canvases set the box size
    inner.style.width = rib.style.width = txt.style.width = COLS * cw + "px";
    inner.style.height = rib.style.height = txt.style.height = ROWS * lh + "px";
    rib.width = txt.width = Math.round(COLS * cw * dpr); rib.height = txt.height = Math.round(ROWS * lh * dpr);
  }

  // ---------- colour ----------
  const rgb = a => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
  function shadeCol(base, s, cue, hi = 1) {
    const lit = 0.25 + 0.75 * s;
    let c = base.map(v => v * (0.5 + 0.5 * lit) + (255 - v) * 0.28 * hi * Math.pow(s, 3));
    const fog = fogOf(cue) * 0.6;
    return rgb(c.map((v, i) => v * (1 - fog) + PAL.paper[i] * fog));
  }
  // colour: "ss", "plddt" (falls back to ss without pLDDT) or one solid colour (a ChimeraX name or hex)
  // Every residue gets one colour: the overall mode (SS, pLDDT or one colour) unless the sequence
  // panel recoloured it. colours() turns that into a short list of distinct colours plus each
  // residue's index into it, which the text, ribbon and surface all draw from.
  const colourMode = () => o.colour === "plddt" ? (G && G.hasB ? "plddt" : "ss") : SOLID ? "solid" : "ss";   // "plddt": the B-factor column
  function colours() {
    const mode = colourMode(), css = PAL.css;
    const key = [mode, css.H, css.E, css.C, css.P.join(), SOLID && SOLID.css, ovrVer, geomId].join("|");
    if (ctab && ctab.key === key) return ctab;
    const list = [], idx = new Map(), rc = new Uint8Array(G.N);
    const add = c => { if (!idx.has(c)) { idx.set(c, list.length); list.push({ css: c, rgb: hex(c) }); } return idx.get(c); };
    const byMode = (m, i) => m === "plddt" && G.hasB ? css.P[G.pkRes[i]] : m === "solid" ? SOLID.css : css[G.ssRes[i]];
    for (let i = 0; i < G.N; i++) {
      const v = ovr.get(i);
      rc[i] = add(v === undefined ? byMode(mode, i) : v === "ss" || v === "plddt" ? byMode(v, i) : v);
    }
    return ctab = { key, list, rc };
  }
  const baseOf = q => { const t = colours(); return t.list[t.rc[q.res]].rgb; };

  // ---------- view helpers ----------
  const fitR = () => G.R + (o.surface ? 4 : 0);   // the surface reaches past the chain
  const baseScale = () => G ? Math.min((COLS * 0.5 - 2) / fitR(), (ROWS * 0.5 - 1) / (fitR() * aspect)) : 1;
  function zoomAt(factor, cx = COLS / 2, cy = ROWS / 2) {
    const z2 = Math.max(ZMIN, Math.min(ZMAX, zoom * factor));
    if (z2 === zoom) return;
    const S1 = baseScale() * zoom, S2 = baseScale() * z2, ox = COLS / 2, oy = ROWS / 2;
    const ax = (cx - ox) / S1 - panX, ay = (oy - cy) / (S1 * aspect) - panY;
    panX = (cx - ox) / S2 - ax; panY = (oy - cy) / (S2 * aspect) - ay;
    zoom = z2; emit("zoom", zoom);
  }
  function panBy(dxPx, dyPx) { const S = baseScale() * zoom; panX += dxPx / cw / S; panY -= dyPx / lh / (S * aspect); }
  function cellAt(x, y) { const r = inner.getBoundingClientRect(); return [(x - r.left) / cw, (y - r.top) / lh]; }
  function resetView(rotation = false) { zoom = 1; panX = 0; panY = 0; if (rotation) Rm = HOME.slice(); emit("zoom", zoom); }
  const asciiAmount = u => o.layout === "ascii" ? 1 : o.layout === "ribbon" ? 0 : 1 - smooth(o.blendFrom, o.blendTo, o.layout === "lr" ? u : 1 - u);

  // ---------- frame ----------
  let lastBox = null;   // protein extent in cells, for cropped exports
  function render(grid = false) {   // grid: also fill the character grid, for Copy text
    if (!G || !HASH) return;
    const pts = G.pts, R = fitR();
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = Rm;
    const rot = v => [m0 * v[0] + m1 * v[1] + m2 * v[2], m3 * v[0] + m4 * v[1] + m5 * v[2], m6 * v[0] + m7 * v[1] + m8 * v[2]];
    const S = baseScale() * zoom, ox = COLS / 2, oy = ROWS / 2;
    // perspective: points nearer the camera (larger z) are drawn larger; pan stays a screen-space shift
    const kz = Math.max(0, Math.min(1, +o.perspective || 0)) * PERSP / R, scl = z => 1 / Math.max(0.3, 1 - kz * z);
    const left = Math.max(0, ox + (panX - R) * S), right = Math.min(COLS, ox + (panX + R) * S), span = Math.max(1, right - left);
    lastBox = { x0: left, x1: right, y0: Math.max(0, oy - (panY + R) * S * aspect), y1: Math.min(ROWS, oy - (panY - R) * S * aspect) };
    for (let i = 0; i < COLS; i++) fcol[i] = asciiAmount((i + 0.5 - left) / span);

    // lighting, after ChimeraX's "lighting gentle": mostly ambient occlusion, a little key light (diff = n·L)
    const AO = aoInfo();
    const lit = (d, ao) => G_AMB + G_DIR * d + G_AO * ao;
    const sh = (col, d, ao, cue, k = 1) => shadeCol(col, lit(d, ao) * k, cue, 0.2);
    const aoMid = k => (AO.C[k] + AO.C[k + 1]) / 2;

    // Copy text: splat spheres along the spline into a z-buffered character grid
    const space = is3D(), P = new Array(pts.length);
    for (let k = 0; k < pts.length; k++) P[k] = rot(pts[k].p);
    if (grid) zbuf.fill(-1e9);
    const SL = splatList();    // spline points, or atoms / residue balls for the surface
    for (let k = 0; k < SL.length && grid; k++) {
      const q = SL[k], v = SL === pts ? P[k] : rot(q.p), r = q.r;
      const sc = scl(v[2]), px = ox + (v[0] * sc + panX) * S, py = oy - (v[1] * sc + panY) * S * aspect, rx = r * S * sc, ry = rx * aspect;
      const i0 = Math.max(0, Math.floor(px - rx)), i1 = Math.min(COLS - 1, Math.ceil(px + rx));
      const j0 = Math.max(0, Math.floor(py - ry)), j1 = Math.min(ROWS - 1, Math.ceil(py + ry));
      for (let j = j0; j <= j1; j++) {
        const dy = (j + 0.5 - py) / ry;
        for (let i = i0; i <= i1; i++) {
          const dx = (i + 0.5 - px) / rx, d2 = dx * dx + dy * dy;
          if (d2 >= 1) continue;
          const nz = Math.sqrt(1 - d2), zf = v[2] + r * nz, c = j * COLS + i;
          if (zf <= zbuf[c]) continue;
          zbuf[c] = zf;
          const diff = Math.max(0, dx * LIGHT[0] - dy * LIGHT[1] + nz * LIGHT[2]);
          lbuf[c] = lit(diff, SL === pts ? AO.C[k] : AO.Res[q.res]);
          cbuf[c] = Math.max(0, Math.min(1, 0.55 + 0.45 * (zf + R) / (2 * R)));
        }
      }
    }

    // the mask that hands cells over to the ribbon. 3D glyphs carry their own paper discs, so
    // there the ribbon just fades in under them instead of being punched full of cell holes.
    const md = mimg.data;
    for (let j = 0, c = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++, c++) {
      const f = fcol[i];
      md[c * 4 + 3] = space ? Math.round(Math.min(1, (1 - f) * 2) * 255) : HASH[c] < f * 1.04 && f > 0.001 ? 0 : 255;
    }

    // ribbon: painter's algorithm in the same projection
    const dpr = rib.width / (COLS * cw);
    const kpx = S * aspect * lh * dpr, OX = ox * cw * dpr, OY = oy * lh * dpr;
    const X = v => OX + (v[0] * scl(v[2]) + panX) * kpx, Y = v => OY - (v[1] * scl(v[2]) + panY) * kpx;
    const polys = [];
    const gl3d = o.layout !== "ascii" && !!view3d();   // the model goes through WebGL when it can
    if (o.layout !== "ascii" && !o.surface && !gl3d) {   // fallback: the cartoon painted in 2D
      const SN = new Array(pts.length), NN = new Array(pts.length);
      for (let k = 0; k < pts.length; k++) { SN[k] = rot(pts[k].side); NN[k] = rot(pts[k].nrm); }
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        if (a.gap) continue;
        const A = P[k], B = P[k + 1], zc = (A[2] + B[2]) / 2, cue = Math.max(0, Math.min(1, (zc + R) / (2 * R)));
        if (a.kind === "C" || a.wOut === 0) {
          polys.push({ z: zc, line: [X(A), Y(A), X(B), Y(B)], w: 2 * shape.coilR * kpx * scl(zc), c: sh(baseOf(a), 0.55, aoMid(k), cue) });
          continue;
        }
        const wa = a.wOut, wb = (b.res === a.res || b.kind === a.kind) ? b.wIn : 0.04;
        const Ta = a.th, Tb = b.kind === a.kind ? b.th : a.th;
        const sa = SN[k], sb = SN[k + 1], na = NN[k], nb = NN[k + 1];
        const c1 = add(A, mul(sa, wa)), c2 = add(A, mul(sa, -wa)), c3 = add(B, mul(sb, -wb)), c4 = add(B, mul(sb, wb));
        const nf = norm(add(na, nb)), col = baseOf(a);
        const aoF = nf[2] >= 0 ? (AO.P[k] + AO.P[k + 1]) / 2 : (AO.M[k] + AO.M[k + 1]) / 2;   // the face we see
        // helices and strands are flat strips: one shade across the whole width of each segment
        polys.push({ z: zc, q: [c1, c2, c3, c4], c: sh(col, Math.abs(dot(nf, LIGHT)), aoF, cue) });
        if (Math.abs(nf[2]) < 0.9 && Ta > 0.02) {
          for (const sg of [1, -1]) {
            const ea = add(A, mul(sa, sg * wa)), eb = add(B, mul(sb, sg * wb));
            const e = [add(ea, mul(na, Ta)), add(ea, mul(na, -Ta)), add(eb, mul(nb, -Tb)), add(eb, mul(nb, Tb))];
            const s = Math.abs(dot(mul(norm(add(sa, sb)), sg), LIGHT));
            polys.push({ z: zc + sg * 0.01 * (sa[2] + sb[2]), q: e, c: sh(col, s, aoMid(k), cue * 0.95, 0.7) });
          }
        }
      }
      polys.sort((p, q) => p.z - q.z);
    }
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.clearRect(0, 0, rib.width, rib.height);
    rctx.lineJoin = "round"; rctx.lineCap = "round";
    for (const p of polys) {
      if (p.line) {
        rctx.strokeStyle = p.c; rctx.lineWidth = p.w;
        rctx.beginPath(); rctx.moveTo(p.line[0], p.line[1]); rctx.lineTo(p.line[2], p.line[3]); rctx.stroke();
      } else {
        rctx.fillStyle = p.c; rctx.strokeStyle = p.c; rctx.lineWidth = 0.8 * dpr;
        rctx.beginPath(); rctx.moveTo(X(p.q[0]), Y(p.q[0]));
        for (let m = 1; m < 4; m++) rctx.lineTo(X(p.q[m]), Y(p.q[m]));
        rctx.closePath(); rctx.fill(); rctx.stroke();
      }
    }
    if (o.layout !== "ascii" && (o.surface || gl3d)) drawModel({ Rm, kz, scl, kpx, OX, OY, R, lit, dpr });
    mctx.putImageData(mimg, 0, 0);
    rctx.globalCompositeOperation = "destination-in";
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(mask, 0, 0, rib.width, rib.height);
    rctx.globalCompositeOperation = "source-over";

    if (space) drawText3D({ Rm, S, kz, scl, kpx, OX, OY, dpr, R, lit });
    else if (txtDirty) { tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, txt.width, txt.height); txtDirty = false; }
  }

  // ---------- Copy text: the whole protein as plain characters ----------
  // Spheres along the chain are splatted into the cell grid (render(true)); each covered cell gets a
  // glyph from the ramp by its light and depth, the layout's text/model split aside.
  function buildChars() {
    const night = o.theme === "night", n = ramp.length - 1, rows = [];
    for (let j = 0; j < ROWS; j++) {
      let line = "";
      for (let i = 0; i < COLS; i++) {
        const c = j * COLS + i;
        if (zbuf[c] <= -1e8) { line += " "; continue; }
        const light = lbuf[c], cue = cbuf[c];
        const v = night ? light * cue : (0.42 + 0.58 * (1 - light)) * (0.25 + 0.75 * cue) * 1.1;
        line += ramp[Math.max(1, Math.min(n, Math.round(Math.min(1, v) * n)))];
      }
      rows.push(line.replace(/\s+$/, ""));
    }
    while (rows.length && !rows[0]) rows.shift();
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    lastGrid = rows;
  }

  // ---------- ambient occlusion ----------
  let aoState = null;
  function aoInfo() {
    if (aoState && aoState.id === geomId) return aoState;
    const ca = G.ca, grid = new Map(), cellOf = v => Math.floor(v / AO_R) + 128;
    const keyOf = (x, y, z) => (x * 256 + y) * 256 + z;
    ca.forEach((p, i) => { const k = keyOf(cellOf(p[0]), cellOf(p[1]), cellOf(p[2])); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const dens = (x, y, z) => {   // Σ (1 − d/AO_R)² over Cα within AO_R
      const gx = cellOf(x), gy = cellOf(y), gz = cellOf(z);
      let s = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const list = grid.get(keyOf(gx + a, gy + b, gz + c)); if (!list) continue;
        for (const j of list) {
          const p = ca[j], d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
          if (d < AO_R) s += (1 - d / AO_R) ** 2;
        }
      }
      return s;
    };
    // per spline point: at the chain and just off both faces of the band (±nrm)
    const pts = G.pts, np = pts.length, C = new Float32Array(np), Pf = new Float32Array(np), M = new Float32Array(np);
    for (let k = 0; k < np; k++) {
      const p = pts[k].p, n = pts[k].nrm;
      C[k] = dens(p[0], p[1], p[2]);
      Pf[k] = dens(p[0] + n[0] * AO_OFF, p[1] + n[1] * AO_OFF, p[2] + n[2] * AO_OFF);
      M[k] = dens(p[0] - n[0] * AO_OFF, p[1] - n[1] * AO_OFF, p[2] - n[2] * AO_OFF);
    }
    const all = Float32Array.from([...C, ...Pf, ...M]).sort();
    const lo = all[Math.floor(all.length * 0.1)], hi = Math.max(lo + 1e-3, all[Math.floor(all.length * 0.9)]);
    const map = d => AO_MIN + (1 - AO_MIN) * Math.max(0, Math.min(1, 1 - (d - lo) / (hi - lo)));
    for (const arr of [C, Pf, M]) for (let k = 0; k < np; k++) arr[k] = map(arr[k]);
    const Res = Float32Array.from(G.ca, p => map(dens(p[0], p[1], p[2])));   // per residue, for Copy text over the surface
    return aoState = { id: geomId, dens, map, C, P: Pf, M, Res };
  }
  function surfaceAO(sf) {   // per glyph: on the surface, the mesh's own ambient occlusion
    const { dens, map } = aoInfo(), out = new Float32Array(sf.n), P = sf.P, N = sf.N;
    let i = 0;
    if (sf.kind === "surface") { const ao = meshAO(mesh()); for (; i < sf.n0; i++) out[i] = AO_MIN + (1 - AO_MIN) * ao[sf.vix[i]]; }
    for (let i3 = i * 3; i < sf.n; i++, i3 += 3)   // cartoon, sticks and ligands: Cα density just outside, same scale as the ribbon
      out[i] = map(dens(P[i3] + N[i3] * AO_OFF, P[i3 + 1] + N[i3 + 1] * AO_OFF, P[i3 + 2] + N[i3 + 2] * AO_OFF));
    return out;
  }

  // ---------- 3D text: glyphs printed on the cartoon's own surfaces ----------
  // The text takes the ribbon's shape: helices are twisting bands and strands flat arrows, with
  // glyphs on both faces and along the edges; loops are thin tubes. Glyphs sit about one spacing apart. Each frame they're rotated with the model, dropped
  // when they face away or a nearer surface covers them, sized by perspective, fogged by depth,
  // laid in the surface's tangent plane (so they foreshorten as it turns away) and drawn back to
  // front.
  let gstat = null, surf = null, atlas = null, atlasKey = "";

  // How the ribbon draws segment k → k+1: a tube, or a band with half-widths and half-thicknesses
  // at both ends (the same numbers the cartoon uses, so text and ribbon line up exactly)
  function segShape(k) {
    const a = G.pts[k], b = G.pts[k + 1];
    if (a.kind === "C" || a.wOut === 0) return { tube: true, r: shape.coilR, ss: "C" };
    return { tube: false, ss: a.kind, wa: a.wOut, wb: (b.res === a.res || b.kind === a.kind) ? b.wIn : 0.04,
             ha: a.th, hb: b.kind === a.kind ? b.th : a.th };
  }

  function textStep() {   // glyph spacing in Å: one text row at the current zoom level
    if (!gstat || gstat.id !== geomId) {   // glyph count ≈ A2 / (ALONG·AROUND·step²) + A1 / (ALONG·step)
      let A2 = 0, A1 = 0; const p = G.pts;
      for (let k = 0; k < p.length - 1; k++) {
        if (p[k].gap) continue;
        const L = dist(p[k].p, p[k + 1].p), g = segShape(k);
        if (g.tube) A2 += 2 * Math.PI * g.r * L; else { A2 += 2 * (g.wa + g.wb) * L; A1 += 2 * L; }
      }
      gstat = { id: geomId, A2, A1 };
    }
    const count = s => gstat.A2 / (ALONG * AROUND * s * s) + gstat.A1 / (ALONG * s);
    // re-sample in half-octave zoom steps (not the surface: it is slower to build, its glyphs just grow)
    const lvl = o.surface ? 1 : Math.pow(2, Math.round(Math.log2(Math.max(1, zoom)) * 2) / 2);
    let step = 1 / Math.max(1e-6, baseScale() * aspect * lvl);
    if (!o.surface && count(step) > MAX_GLYPHS) step *= Math.sqrt(count(step) / MAX_GLYPHS);
    if (o.surface) step = Math.pow(2, Math.round(Math.log2(step) * 4) / 4);   // quarter-octave steps: resizing doesn't rebuild it every frame
    return +step.toPrecision(3);
  }

  // Copy text over the surface splats atoms (or residue balls) instead of the spline
  function splatList() {
    if (!o.surface) return G.pts;
    if (!surfBalls || surfBalls.id !== geomId) {
      const A = G.atoms, list = A.sideChains   // every heavy atom at its radius, or one soft ball per residue
        ? Array.from(A.R, (r, i) => ({ p: [A.P[i * 3], A.P[i * 3 + 1], A.P[i * 3 + 2]], r: r * 1.15, res: A.res[i] }))
        : G.ca.map((p, i) => ({ p, r: RES_BALL, res: i }));
      surfBalls = { id: geomId, list };
    }
    return surfBalls.list;
  }

  // The points glyphs (and surface discs) sit on: the cartoon's bands and tubes, or the surface,
  // then the side-chain sticks and the ligands when they're shown. own: 0 the chain (res is a
  // residue), 1 a side chain (res is its residue), 2 a ligand (res is the ligand); el: element code.
  function surface(step) {
    const kind = o.surface ? "surface" : "cartoon", sc = o.surface ? null : scShow, lig = !!o.ligands && G.ligands.length > 0;
    const xkey = (sc ? scKey() : "") + "|" + lig;
    if (surf && surf.id === geomId && surf.step === step && surf.kind === kind && surf.xkey === xkey) return surf;
    let spacing = step * SURF_SPACING, Pp, Nn, res, vix = null;
    if (o.surface) {   // evenly spaced vertices of the surface mesh
      const m = mesh();
      let ms = meshPoints(m, spacing);
      if (ms.n > MAX_GLYPHS) { spacing *= Math.sqrt(ms.n / MAX_GLYPHS); ms = meshPoints(m, spacing); }
      ({ P: Pp, N: Nn, res, vix } = ms);
    } else ({ Pp, Nn, res } = cartoonPoints(step));
    const n0 = res.length, da = step * ALONG, dr = step * AROUND, parts = [];
    if (sc) parts.push([1, sideChainPoints(G, sc === "all" ? () => true : r => sc.has(r), da, dr)]);
    if (lig) parts.push([2, ligandPoints(G, da, dr)]);
    const n = parts.reduce((t, [, q]) => t + q.n, n0);
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), R = new Uint32Array(n), own = new Uint8Array(n), el = new Uint8Array(n);
    P.set(Pp); N.set(Nn); R.set(res);
    let at = n0;
    for (const [w, q] of parts) { P.set(q.P, at * 3); N.set(q.N, at * 3); R.set(q.res, at); el.set(q.el, at); own.fill(w, at, at + q.n); at += q.n; }
    const hash = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; hash[i] = x - Math.floor(x); }
    const els = [...new Set(el)].filter(Boolean).sort((a, b) => a - b);
    surf = { id: geomId, step, kind, xkey, spacing, n0, n, P, N, res: R, own, el, els, vix, hash,
             ix: new Uint32Array(n), wn: new Float32Array(n * 3), zs: new Float32Array(n), tx: new Float32Array(n), ty: new Float32Array(n),
             tm: new Float32Array(n * 4), tg: new Uint16Array(n), tr: new Uint16Array(n), tk: new Float32Array(n), ord: new Uint32Array(n) };
    return surf;
  }

  function cartoonPoints(step) {
    const pts = G.pts, da = step * ALONG, dr = step * AROUND;
    const Pp = [], Nn = [], res = [];
    const put = (c, n, sgn, d1, off1, d2, off2, ri) => {   // c + d1·off1 + d2·off2, normal n·sgn, residue ri
      Pp.push(c[0] + d1[0] * off1 + d2[0] * off2, c[1] + d1[1] * off1 + d2[1] * off2, c[2] + d1[2] * off1 + d2[2] * off2);
      Nn.push(n[0] * sgn, n[1] * sgn, n[2] * sgn); res.push(ri);
    };
    let acc = 0, next = 0, row = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1], L = dist(a.p, b.p);
      if (a.gap) { acc += L; next = acc + da * 0.5; continue; }
      const g = segShape(k), ri = a.res;
      while (next <= acc + L) {
        const t = L > 1e-6 ? (next - acc) / L : 0, u = 1 - t;
        const c = add(mul(a.p, u), mul(b.p, t));
        const e1 = norm(add(mul(a.side, u), mul(b.side, t))), e2 = norm(add(mul(a.nrm, u), mul(b.nrm, t)));
        if (g.tube) {           // ring around a loop
          const m = Math.max(4, Math.round(2 * Math.PI * g.r / dr)), off = (row & 1) * 0.5;
          for (let j = 0; j < m; j++) {
            const th = 2 * Math.PI * (j + off) / m, n = add(mul(e1, Math.cos(th)), mul(e2, Math.sin(th)));
            put(c, n, 1, n, g.r, e2, 0, ri);
          }
        } else {                // a row across the band, on both faces, plus one glyph on each edge
          const w = g.wa * u + g.wb * t, h = g.ha * u + g.hb * t;
          const m = Math.max(1, Math.round(2 * w / dr)), gap = 2 * w / m, off = m > 1 ? ((row & 1) ? 0.25 : -0.25) : 0;
          for (let j = 0; j < m; j++) {
            const s = -w + gap * (j + 0.5 + off);
            put(c, e2, 1, e1, s, e2, h, ri); put(c, e2, -1, e1, s, e2, -h, ri);
          }
          if (w > 0.3 * dr) { put(c, e1, 1, e1, w, e2, 0, ri); put(c, e1, -1, e1, -w, e2, 0, ri); }
        }
        row++; next += da;
      }
      acc += L;
    }
    return { Pp, Nn, res };
  }

  // ---------- the model in 3D: the cartoon or surface mesh, drawn with WebGL ----------
  let meshState = null, cartState = null, glv;   // glv: WebGL renderer; undefined until tried, null if unavailable
  function mesh() {
    if (!meshState || meshState.id !== geomId) meshState = { id: geomId, m: surfaceMesh(G), colKey: "", aoOn: false };
    return meshState.m;
  }
  function cartMesh() {
    if (!cartState || cartState.id !== geomId) cartState = { id: geomId, m: cartoonMesh(G, shape), colKey: "", aoOn: false };
    return cartState.m;
  }
  // side chains: null (none), "all", or a Set of residue indices; drawn with the cartoon, not the surface
  let scShow = null, stickState = null;
  const setSideChains = w => { scShow = w === "all" ? "all" : (w && typeof w !== "string") ? new Set(w) : null; };
  setSideChains(o.sidechains);
  const scKey = () => scShow === "all" ? "all" : [...scShow].sort((a, b) => a - b).join(",");
  function stickMesh() {
    if (!scShow || o.surface) return null;
    const key = geomId + "|" + scKey();
    if (!stickState || stickState.key !== key)
      stickState = { key, m: sideChainMesh(G, scShow === "all" ? () => true : r => scShow.has(r)), colKey: "" };
    return stickState.m.nv ? stickState.m : null;
  }
  // ligands and ions: drawn with the cartoon and with the surface; each has a colour for its carbons
  let ligState = null, ligVer = 0;
  const ligOvr = new Map();   // ligand index → css
  function ligMesh() {
    if (!o.ligands || !G.ligands.length) return null;
    if (!ligState || ligState.id !== geomId) ligState = { id: geomId, m: ligandMesh(G), colKey: "" };
    return ligState.m.nv ? ligState.m : null;
  }
  const ligColours = () => G ? G.ligands.map((l, i) => ligOvr.get(i) || (l.ion ? elementCss(l.el[0]) : LIGAND_CARBON)) : [];
  function view3d() {
    if (glv === undefined) { try { glv = createGLView(); } catch { glv = null; } }
    return glv;
  }
  function drawModel(F) {
    const v = view3d();
    if (!v) { if (o.surface) drawSurfels(F); return; }   // no WebGL: the 2D ribbon was drawn already
    const name = o.surface ? "surface" : "cartoon", m = o.surface ? mesh() : cartMesh(), st = o.surface ? meshState : cartState, t = colours();
    if (v.mesh(name) !== m) { v.setMesh(name, m); st.colKey = ""; st.aoOn = false; }
    if (st.colKey !== t.key) {           // per-vertex colour from its residue
      const rgb = new Uint8Array(m.nv * 3);
      for (let i = 0; i < m.nv; i++) { const c = t.list[t.rc[m.res[i]]].rgb; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
      v.setColours(name, rgb); st.colKey = t.key;
    }
    if (!st.aoOn) { if (o.surface) v.setAO(name, meshAO(m)); st.aoOn = true; }   // the cartoon is shaded by depth instead
    const names = [name], sm = o.surface ? null : stickMesh();
    if (sm) {   // side chains: carbons in the residue's colour, N / O / S by element
      if (v.mesh("sticks") !== sm) { v.setMesh("sticks", sm); stickState.colKey = ""; }
      if (stickState.colKey !== t.key) {
        const rgb = new Uint8Array(sm.nv * 3);
        for (let i = 0; i < sm.nv; i++) { const c = ELEMENT_RGB[sm.el[i]] || t.list[t.rc[sm.res[i]]].rgb; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
        v.setColours("sticks", rgb); stickState.colKey = t.key;
      }
      names.push("sticks");
    }
    const lm = ligMesh();
    if (lm) {   // ligands: carbons (and ions) in the ligand's colour, the rest by element
      if (v.mesh("ligands") !== lm) { v.setMesh("ligands", lm); ligState.colKey = ""; }
      if (ligState.colKey !== ligVer) {
        const lc = ligColours().map(hex), rgb = new Uint8Array(lm.nv * 3);
        for (let i = 0; i < lm.nv; i++) { const c = ELEMENT_RGB[lm.el[i]] || lc[lm.res[i]]; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
        v.setColours("ligands", rgb); ligState.colKey = ligVer;
      }
      names.push("ligands");
    }
    const M = F.Rm, cam = F.kz > 0 ? 1 / F.kz : 0;
    // the model's nearest and farthest distance from the camera in this view (every 3rd vertex is plenty)
    let dn = Infinity, df = -Infinity;
    for (const mm of [m, sm, lm].filter(Boolean)) {
      const P = mm.P;
      for (let i = 0; i < mm.nv; i += 3) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const vx = M[0] * x + M[1] * y + M[2] * z, vy = M[3] * x + M[4] * y + M[5] * z, vz = M[6] * x + M[7] * y + M[8] * z;
        const d = cam ? Math.hypot(vx, vy, cam - vz) : -vz;
        if (d < dn) dn = d; if (d > df) df = d;
      }
    }
    const c = v.render({ W: rib.width, H: rib.height, rot: [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]],   // column-major
      kz: F.kz, kpx: F.kpx, R: F.R, pan: [panX, panY], O: [F.OX, F.OY], key: LIGHT,
      bg: PAL.paper.map(x => x / 255), ink: [0.08, 0.08, 0.08], edge: Math.max(1, 1.25 * F.dpr), mode: o.surface ? 0 : 1,
      depth: 0.9 * clamp01(o.depth), fog: Math.min(1, 1.25 * clamp01(o.depth)), faces: !!o.faces, drange: [dn, df] }, names);   // depth: the Depth slider
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.drawImage(c, 0, 0);
  }

  // ---------- fallback without WebGL: shaded discs on the surface points, drawn back to front ----------
  let discs = null, discsKey = "";
  function discAtlas(hi) {   // one disc per colour × fog step × shade step
    const t = colours(), cols = t.list.map(c => c.rgb);
    const key = [t.key, PAL.css.bg, hi].join("|");
    if (discs && discsKey === key) return discs;
    discs = discs || document.createElement("canvas");
    discs.width = SHADES * DCELL; discs.height = cols.length * FOGS * DCELL;
    const x = discs.getContext("2d");
    x.clearRect(0, 0, discs.width, discs.height);
    cols.forEach((c, ci) => {
      for (let fl = 0; fl < FOGS; fl++) for (let sl = 0; sl < SHADES; sl++) {
        x.fillStyle = shadeCol(c, sl / (SHADES - 1), 0.5 * (1 - fl / (FOGS - 1)), hi);   // the cue whose fog is step fl
        x.beginPath(); x.arc(sl * DCELL + DCELL / 2, (ci * FOGS + fl) * DCELL + DCELL / 2, DCELL / 2 - 0.5, 0, 2 * Math.PI); x.fill();
      }
    });
    discsKey = key;
    return discs;
  }

  function drawSurfels(F) {
    const { kz, scl, kpx, OX, OY, R, lit } = F, [m0, m1, m2, m3, m4, m5, m6, m7, m8] = F.Rm;
    const sf = surface(textStep());
    if (!sf.ao) sf.ao = surfaceAO(sf);
    const { n0: n, P: SP, N: SN, res, zs, tx, ty, tg, tr, tk, ord } = sf;   // shares buffers with the 3D text, which runs after
    const W = rib.width, H = rib.height, rc = colours().rc, d0 = 2 * SURFEL * sf.spacing * kpx;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let a = SN[i3], b = SN[i3 + 1], c = SN[i3 + 2];   // rotate the normal (w) and the position (v)
      const wx = m0 * a + m1 * b + m2 * c, wy = m3 * a + m4 * b + m5 * c, wz = m6 * a + m7 * b + m8 * c;
      a = SP[i3]; b = SP[i3 + 1]; c = SP[i3 + 2];
      const vx = m0 * a + m1 * b + m2 * c, vy = m3 * a + m4 * b + m5 * c, vz = m6 * a + m7 * b + m8 * c;
      if (wz - kz * (wx * vx + wy * vy + wz * vz) <= 0) continue;              // back side: covered by the front
      const sc = scl(vz), X = OX + (vx * sc + panX) * kpx, Y = OY - (vy * sc + panY) * kpx, d = d0 * sc;
      if (X < -d || Y < -d || X > W + d || Y > H + d) continue;
      const diff = Math.max(0, wx * LIGHT[0] + wy * LIGHT[1] + wz * LIGHT[2]);
      const s = Math.max(0, Math.min(1, lit(diff, sf.ao[i])));
      const dt = Math.max(0, Math.min(1, (vz + R) / (2 * R)));
      zs[cnt] = vz; tx[cnt] = X; ty[cnt] = Y; tk[cnt] = d;
      tg[cnt] = Math.round(s * (SHADES - 1));
      tr[cnt] = rc[res[i]] * FOGS + Math.round(fogOf(dt) * (FOGS - 1));
      cnt++;
    }
    const order = ord.subarray(0, cnt);
    for (let k = 0; k < cnt; k++) order[k] = k;
    order.sort((p, q) => zs[p] - zs[q]);
    const A = discAtlas(0.2);
    for (let q = 0; q < cnt; q++) {
      const k = order[q], d = tk[k];
      rctx.setTransform(d, 0, 0, d, tx[k], ty[k]);
      rctx.drawImage(A, tg[k] * DCELL, tr[k] * DCELL, DCELL, DCELL, -0.5, -0.5, 1, 1);
    }
    rctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // The text's colours: the residues' (colours()), then the element colours on the sticks and each
  // ligand's own colour. pal.of(own, el, res) picks a glyph's. On paper, the palest element colours
  // (sulfur's yellow, magnesium's green …) are darkened to stay legible as thin glyphs.
  let tpal = null;
  const css6 = c => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  function legible(c) {
    if (o.theme === "night") return c;
    const L = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return L > 0.55 ? c.map(v => v * 0.55 / L) : c;
  }
  function textPalette(sf) {
    const t = colours(), lc = ligColours(), key = [t.key, o.theme, sf.els.join(), lc.join()].join("|");
    if (tpal && tpal.key === key) return tpal;
    const list = t.list.map(c => c.css), idx = new Map(list.map((c, i) => [c, i]));
    const put = c => { if (!idx.has(c)) { idx.set(c, list.length); list.push(c); } return idx.get(c); };
    const elIdx = new Int32Array(ELEMENT_RGB.length);
    for (const e of sf.els) elIdx[e] = put(css6(legible(ELEMENT_RGB[e])));
    const ligIdx = lc.map((c, i) => put(G.ligands[i].ion && !ligOvr.has(i) ? css6(legible(hex(c))) : c)), rc = t.rc;
    return tpal = { key, list, of: (w, e, r) => e ? elIdx[e] : w === 2 ? ligIdx[r] : rc[r] };
  }

  // One sprite per glyph × colour × fog step; the blank glyph's slot holds the paper disc.
  function glyphAtlas(pal) {
    const css = PAL.css, cols = pal.list;
    const key = [pal.key, css.bg, ramp, o.font, fontEpoch].join("|");
    if (atlas && atlasKey === key) return atlas;
    atlas = atlas || document.createElement("canvas");
    atlas.width = ramp.length * CELL; atlas.height = cols.length * FOGS * CELL;
    const x = atlas.getContext("2d");
    x.clearRect(0, 0, atlas.width, atlas.height);
    x.fillStyle = css.bg; x.beginPath(); x.arc(CELL / 2, CELL / 2, CELL / 2 - 1, 0, 2 * Math.PI); x.fill();
    x.font = `700 ${Math.round(CELL * 0.8)}px ${o.font}`; x.textAlign = "center"; x.textBaseline = "middle";
    cols.forEach((c, ci) => {
      const base = hex(c);
      for (let fl = 0; fl < FOGS; fl++) {
        const fog = fl / (FOGS - 1) * FOG_MAX;
        x.fillStyle = rgb(base.map((v, i) => v * (1 - fog) + PAL.paper[i] * fog));
        for (let g = 1; g < ramp.length; g++) x.fillText(ramp[g], g * CELL + CELL / 2, (ci * FOGS + fl) * CELL + CELL / 2);
      }
    });
    atlasKey = key;
    return atlas;
  }

  function drawText3D(F) {
    const { kz, scl, kpx, OX, OY, dpr, R, lit } = F, [m0, m1, m2, m3, m4, m5, m6, m7, m8] = F.Rm;
    const step = textStep(), sf = surface(step);
    if (!sf.ao) sf.ao = surfaceAO(sf);
    const { n, P: SP, N: SN, res, own, el, hash, ix, wn, zs, tx, ty, tm, tg, tr, tk, ord } = sf, pal = textPalette(sf);
    const cwp = cw * dpr, lhp = lh * dpr, size0 = step * GLYPH_SPRITE * kpx;
    const DW = COLS * DS, DH = ROWS * DS, ux = cwp / DS, uy = lhp / DS, W = COLS * cwp, H = ROWS * lhp;
    const spA = step * Math.max(ALONG, AROUND), rad0 = 0.6 * spA * kpx;   // neighbour spacing (Å), splat radius (px)
    const night = o.theme === "night", nr = ramp.length - 1;

    // pass 1: rotate, drop back faces and off-screen glyphs, splat the rest into a depth buffer.
    // The buffer holds the nearest text surface everywhere, so pass 2 can tell a glyph that is
    // covered by a nearer band or tube from one that merely sits on a curved surface.
    dbuf.fill(-1e9);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let a = SN[i3], b = SN[i3 + 1], c = SN[i3 + 2];   // rotate the normal (w) and the position (v)
      const wx = m0 * a + m1 * b + m2 * c, wy = m3 * a + m4 * b + m5 * c, wz = m6 * a + m7 * b + m8 * c;
      a = SP[i3]; b = SP[i3 + 1]; c = SP[i3 + 2];
      const vx = m0 * a + m1 * b + m2 * c, vy = m3 * a + m4 * b + m5 * c, vz = m6 * a + m7 * b + m8 * c;
      if (wz - kz * (wx * vx + wy * vy + wz * vz) <= 0.02) continue;          // faces away from the camera
      const sc = scl(vz), X = OX + (vx * sc + panX) * kpx, Y = OY - (vy * sc + panY) * kpx;
      if (X < -cwp || Y < -lhp || X > W + cwp || Y > H + lhp) continue;
      ix[m] = i; zs[m] = vz; tx[m] = X; ty[m] = Y; wn[m * 3] = wx; wn[m * 3 + 1] = wy; wn[m * 3 + 2] = wz; m++;
      const gx = X / ux, gy = Y / uy, rx = rad0 * sc / ux, ry = rad0 * sc / uy;
      const i0 = Math.max(0, Math.ceil(gx - rx - 0.5)), i1 = Math.min(DW - 1, Math.floor(gx + rx - 0.5));
      const j0 = Math.max(0, Math.ceil(gy - ry - 0.5)), j1 = Math.min(DH - 1, Math.floor(gy + ry - 0.5));
      for (let j = j0; j <= j1; j++) {
        const dy = (j + 0.5 - gy) / ry;
        for (let k = i0; k <= i1; k++) {
          const dx = (k + 0.5 - gx) / rx;
          if (dx * dx + dy * dy <= 1 && vz > dbuf[j * DW + k]) dbuf[j * DW + k] = vz;
        }
      }
      const fx = Math.floor(gx), fy = Math.floor(gy);                          // always cover its own cell
      if (fx >= 0 && fy >= 0 && fx < DW && fy < DH && vz > dbuf[fy * DW + fx]) dbuf[fy * DW + fx] = vz;
    }

    // pass 2: keep the glyphs on the nearest surface, shade, orient (compacted in place: cnt ≤ q)
    let cnt = 0;
    for (let q = 0; q < m; q++) {
      const i = ix[q], vz = zs[q], X = tx[q], Y = ty[q], wx = wn[q * 3], wy = wn[q * 3 + 1], wz = wn[q * 3 + 2];
      const ci = Math.floor(X / cwp), cj = Math.floor(Y / lhp);
      if (ci < 0 || cj < 0 || ci >= COLS || cj >= ROWS) continue;
      const f = fcol[ci];
      if (!(f > 0.001 && hash[i] < f * 1.04)) continue;                      // handed to the ribbon
      // covered? Allow for the surface's own tilt across one splat radius.
      const slope = Math.min(4, Math.sqrt(Math.max(0, 1 - wz * wz)) / Math.max(0.2, wz));
      if (dbuf[Math.floor(Y / uy) * DW + Math.floor(X / ux)] > vz + 0.15 + slope * 0.6 * spA) continue;
      // light → glyph, depth → fog step
      const diff = Math.max(0, wx * LIGHT[0] + wy * LIGHT[1] + wz * LIGHT[2]);
      const light = lit(diff, sf.ao[i]);
      const dt = Math.max(0, Math.min(1, (vz + R) / (2 * R))), cue = 0.55 + 0.45 * dt;
      let v = night ? (0.3 + 0.7 * light) * cue : (0.5 + 0.55 * (1 - light)) * (0.7 + 0.3 * cue) * 1.1;   // fog does most of the depth
      v = Math.min(1, v) * (0.45 + 0.55 * f);
      // glyph axes in the tangent plane, kept as upright as the surface allows
      let ax, ay, bx, by;
      const uu = 1 - wy * wy, rr = 1 - wx * wx;
      if (uu >= rr) {            // up = screen-up projected onto the plane, right = up × n
        const il = 1 / Math.sqrt(Math.max(1e-9, uu)), px = -wx * wy * il, py = uu * il, pz = -wz * wy * il;
        ax = py * wz - pz * wy; ay = -(pz * wx - px * wz); bx = -px; by = py;
      } else {                   // right = screen-right projected onto the plane, up = n × right
        const il = 1 / Math.sqrt(Math.max(1e-9, rr)), px = rr * il, py = -wy * wx * il, pz = -wz * wx * il;
        ax = px; ay = -py; bx = -(wy * pz - wz * py); by = wz * px - wx * pz;
      }
      const s = size0 * scl(vz), k4 = cnt * 4;
      zs[cnt] = vz; tx[cnt] = X; ty[cnt] = Y;
      tm[k4] = ax * s; tm[k4 + 1] = ay * s; tm[k4 + 2] = bx * s; tm[k4 + 3] = by * s;
      tg[cnt] = Math.max(1, Math.min(nr, Math.round(v * nr)));
      tk[cnt] = s * KNOCK * f * f;          // the paper disc shrinks away where the ribbon takes over
      tr[cnt] = pal.of(own[i], el[i], res[i]) * FOGS + Math.round(fogOf(dt) * (FOGS - 1));
      cnt++;
    }
    const order = ord.subarray(0, cnt);
    for (let k = 0; k < cnt; k++) order[k] = k;
    order.sort((p, q) => zs[p] - zs[q]);                                       // back to front
    const A = glyphAtlas(pal), knock = o.background;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, txt.width, txt.height);
    for (let q = 0; q < cnt; q++) {
      const k = order[q], X = tx[k], Y = ty[k], k4 = k * 4, d = tk[k];
      if (knock && d > 0.5) { tctx.setTransform(d, 0, 0, d, X, Y); tctx.drawImage(A, 0, 0, CELL, CELL, -0.5, -0.5, 1, 1); }
      tctx.setTransform(tm[k4], tm[k4 + 1], tm[k4 + 2], tm[k4 + 3], X, Y);
      tctx.drawImage(A, tg[k] * CELL, tr[k] * CELL, CELL, CELL, -0.5, -0.5, 1, 1);
    }
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    txtDirty = true;
  }

  // ---------- animation (paused while off-screen) ----------
  let raf = 0, prev = performance.now(), visible = true, dragging = false, destroyed = false, capturing = false;
  function loop(t) {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, (t - prev) / 1000); prev = t;
    if (capturing) { raf = 0; return; }
    if (!dragging && o.spin) Rm = turn(o.spin * dt * 1.6, 0, Rm);
    render();
    if (visible) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf && visible && !destroyed) { prev = performance.now(); raf = requestAnimationFrame(loop); } };
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); kick(); }) : null;
  if (io) io.observe(root);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { fit(); kick(); }) : null;
  if (ro) ro.observe(root); else window.addEventListener("resize", fit);
  // a web font arriving changes the cell metrics and the 3D glyph sprites
  const onFonts = () => { if (destroyed) return; fontEpoch++; fit(); kick(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onFonts);
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", onFonts);

  // ---------- interaction: drag rotate · shift/alt/right-drag pan · wheel/pinch zoom · dblclick reset ----------
  const ptrs = new Map();
  let pinch = null, panning = false, lx = 0, ly = 0;
  root.addEventListener("contextmenu", e => { if (o.interactive) e.preventDefault(); });
  root.addEventListener("pointerdown", e => {
    if (!o.interactive) return;
    root.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    } else { dragging = true; panning = e.shiftKey || e.altKey || e.button === 2; lx = e.clientX; ly = e.clientY; root.style.cursor = "grabbing"; }
  });
  root.addEventListener("pointermove", e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      panBy(m[0] - pinch.m[0], m[1] - pinch.m[1]);
      zoomAt(d / Math.max(1, pinch.d), ...cellAt(m[0], m[1]));
      pinch = { d, m };
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (panning) panBy(dx, dy);
    else Rm = turn(dx * 0.008, dy * 0.008, Rm);
  });
  const endPtr = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) { dragging = false; root.style.cursor = o.interactive ? "grab" : "default"; }
    else if (ptrs.size === 1) { const [p] = ptrs.values(); lx = p[0]; ly = p[1]; panning = false; }
  };
  root.addEventListener("pointerup", endPtr);
  root.addEventListener("pointercancel", endPtr);
  root.addEventListener("wheel", e => {
    if (!o.interactive) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-dy * 0.001), ...cellAt(e.clientX, e.clientY));
  }, { passive: false });
  root.addEventListener("dblclick", () => { if (o.interactive) resetView(); });

  // ---------- export helpers ----------
  function cropBox(crop) {
    let x0 = 0, x1 = COLS, y0 = 0, y1 = ROWS;
    if (crop && lastBox) {
      x0 = Math.max(0, Math.floor(lastBox.x0) - 1); x1 = Math.min(COLS, Math.ceil(lastBox.x1) + 1);
      y0 = Math.max(0, Math.floor(lastBox.y0) - 1); y1 = Math.min(ROWS, Math.ceil(lastBox.y1) + 1);
    }
    return { i0: x0, i1: x1, j0: y0, j1: y1, w: (x1 - x0) * cw, h: (y1 - y0) * lh };
  }
  function composeFrame(ctx, box, scale, pad) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = PAL.css.bg; ctx.fillRect(0, 0, box.w + pad * 2, box.h + pad * 2);
    const dpr = rib.width / (COLS * cw);
    ctx.drawImage(rib, box.i0 * cw * dpr, box.j0 * lh * dpr, box.w * dpr, box.h * dpr, pad, pad, box.w, box.h);
    ctx.drawImage(txt, box.i0 * cw * dpr, box.j0 * lh * dpr, box.w * dpr, box.h * dpr, pad, pad, box.w, box.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------- public API ----------
  let loadToken = 0, aborter = null;
  function setStructure(parsed, meta = {}) {
    G = buildGeometry(parsed, shape); geomId++;
    ovr.clear(); ovrVer++; ligOvr.clear(); ligVer++;
    lastParsed = parsed;
    info = { title: meta.title || parsed.title || "Structure", sub: meta.sub || "", residues: G.N, meanPlddt: G.hasPlddt ? G.meanP : null, meanB: G.hasB ? G.meanP : null,
             hasPlddt: G.hasPlddt, hasB: G.hasB, ligands: G.ligands.length, fromAFDB: G.fromAFDB || !!meta.entryUrl, ssFromGeometry: G.ssAuto, chain: parsed.chain, entryUrl: meta.entryUrl || null, acc: meta.acc || null };
    root.setAttribute("aria-label", `${info.title}: rotating protein structure drawn as text and ribbon`);
    resetView(true);
    emit("load", info);
    kick();
    return info;
  }

  const api = {
    get options() { return { ...o, shape: { ...shape } }; },
    get info() { return info; },
    get zoom() { return zoom; },
    get element() { return root; },
    /** Update any display option (see DEFAULTS). */
    set(opts = {}) {
      const needsFit = "detail" in opts && opts.detail !== o.detail;
      Object.assign(o, opts);
      if ("sidechains" in opts) setSideChains(opts.sidechains);
      if (opts.shape) api.setShape(opts.shape);
      applyStyle();
      if (needsFit) fit();
      kick();
      return api;
    },
    /** Update ribbon shape parameters (see SHAPE_DEFAULT); rebuilds geometry. */
    setShape(partial = {}) {
      shape = { ...shape, ...partial };
      if (lastParsed) { G = buildGeometry(lastParsed, shape); geomId++; }
      kick();
      return api;
    },
    resetShape() { return api.setShape(SHAPE_DEFAULT); },
    setStructure,
    loadText(text, meta) { loadToken++; return setStructure(parseStructure(text), meta); },
    async loadFile(file) {
      const token = ++loadToken;
      const { parsed, afId } = await readStructureFile(file);
      if (token !== loadToken) return null;
      return setStructure(parsed, {
        title: afId ? afId.acc : file.name.replace(/\.(pdb|cif|mmcif|ent)(\.gz)?$/i, ""),
        sub: [afId ? `AF-${afId.acc}-F${afId.frag}` : (parsed.title || "local file"), `chain ${parsed.chain}`].join(" · "),
      });
    },
    /** Fetch a model from AlphaFold DB by UniProt accession. Rejects with AFDBError. */
    async loadAccession(acc) {
      const token = ++loadToken;
      if (aborter) aborter.abort();
      aborter = typeof AbortController === "function" ? new AbortController() : null;
      const { parsed, meta, entryUrl, acc: a } = await fetchAFDB(acc, { signal: aborter && aborter.signal });
      if (token !== loadToken) return null;
      return setStructure(parsed, { ...describeAFDB(meta, a), entryUrl, acc: a });
    },
    loadDefault() { loadToken++; return setStructure(parsePDB(KRAS_6GJ8), { title: "KRAS G12D", sub: "PDB 6GJ8 · chain A" }); },
    zoomBy(f) { zoomAt(f); kick(); return api; },
    /** Set the viewing angle in radians (y = spin axis, x = tilt). */
    setRotation(y, x = -0.35) { Rm = rotMat(y, x); kick(); return api; },
    /** The current orientation as a 3×3 row-major rotation matrix (model → view). */
    get rotation() { return { matrix: Rm.slice() }; },
    resetView() { resetView(); kick(); return api; },
    /** Current frame as plain text (the flat character grid, also in 3D mode). */
    text() {
      if (G && HASH) { render(true); buildChars(); }
      return lastGrid.join("\n");
    },
    /** Current frame (ribbon + text) as a PNG data URL. crop: trim to the protein. */
    snapshot({ scale = 2, pad = 40, crop = true } = {}) {
      const box = cropBox(crop), c = document.createElement("canvas");
      c.width = Math.round((box.w + pad * 2) * scale); c.height = Math.round((box.h + pad * 2) * scale);
      composeFrame(c.getContext("2d"), box, scale, pad);
      return c.toDataURL("image/png");
    },
    /**
     * Record one full turn as an animated GIF. Each frame is rendered at an exact angle,
     * so the loop is seamless. Resolves to a Blob (image/gif).
     *   frames: frames per turn · delay: ms per frame · width: output px · onProgress(0..1) · signal: AbortSignal
     */
    async recordGif({ frames = 60, delay = 50, width = 720, pad = 24, crop = true, onProgress, signal } = {}) {
      if (!G) throw new Error("Nothing loaded");
      if (capturing) throw new Error("Already recording");
      capturing = true;
      const R0 = Rm.slice(), tick = () => new Promise(r => setTimeout(r, 0));
      try {
        render();
        const box = cropBox(crop), scale = width / (box.w + pad * 2);
        const W = Math.round(width), H = Math.round((box.h + pad * 2) * scale);
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const frameAt = i => { Rm = turn((2 * Math.PI * i) / frames, 0, R0); render(); composeFrame(ctx, box, scale, pad); return ctx.getImageData(0, 0, W, H).data; };
        // one shared palette from a few spread-out frames keeps colours from flickering
        const picks = [0, 0.25, 0.5, 0.75].map(f => Math.floor(f * frames));
        const sample = new Uint8ClampedArray(W * H * 4 * picks.length);
        picks.forEach((i, k) => sample.set(frameAt(i), k * W * H * 4));
        const palette = quantize(sample, 256);
        const gif = GIFEncoder();
        for (let i = 0; i < frames; i++) {
          if (signal && signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
          gif.writeFrame(applyPalette(frameAt(i), palette), W, H, { palette, delay, repeat: 0 });
          if (onProgress) onProgress((i + 1) / frames);
          await tick();
        }
        gif.finish();
        return new Blob([gif.bytes()], { type: "image/gif" });
      } finally {
        Rm = R0; capturing = false; render(); kick();
      }
    },
    palette() { return { ...PAL.css }; },
    /** Residues for a sequence view: [{ i, num, name, aa, ss }]. */
    residues() { return G ? G.resName.map((name, i) => ({ i, num: G.resNum[i], name, aa: ONE[name] || "X", ss: G.ssRes[i] })) : []; },
    /** Each residue's current colour (css), after any per-residue colours. */
    residueColours() { if (!G) return []; const t = colours(); return Array.from(t.rc, c => t.list[c].css); },
    /** Colour residues (indices) by "ss", "plddt", a colour name or hex; null returns them to the overall colour. */
    colourResidues(indices, colour) {
      const c = colour == null ? null : colour === "ss" || colour === "plddt" ? colour : solidColour(colour);
      if (colour != null && !c) throw new Error(`Unknown colour: ${colour}`);
      for (const i of indices) if (c === null) ovr.delete(i); else ovr.set(i, c);
      ovrVer++; kick(); emit("colour"); return api;
    },
    /** Show side chains as sticks: "all", an array of residue indices, or null for none. */
    showSideChains(which) { setSideChains(which); kick(); return api; },
    /** Ligands and ions near the chain: [{ i, name, num, chain, ion, atoms }]. Shown unless set({ ligands: false }). */
    ligands() { return G ? G.ligands.map((l, i) => ({ i, name: l.name, num: l.num, chain: l.chain, ion: l.ion, atoms: l.P.length })) : []; },
    /** Each ligand's current colour (css): its carbons', or an ion's. */
    ligandColours() { return ligColours(); },
    /** Colour ligands (indices) with a colour name or hex; null (or "ss" / "plddt") returns them to their own colour. */
    colourLigands(indices, colour) {
      const c = colour == null || colour === "ss" || colour === "plddt" ? null : solidColour(colour);
      if (colour != null && colour !== "ss" && colour !== "plddt" && !c) throw new Error(`Unknown colour: ${colour}`);
      for (const i of indices) if (c === null) ligOvr.delete(i); else ligOvr.set(i, c);
      ligVer++; kick(); emit("colour"); return api;
    },
    /** Drop all per-residue and per-ligand colours. */
    clearResidueColours() { ovr.clear(); ovrVer++; ligOvr.clear(); ligVer++; kick(); emit("colour"); return api; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = listeners[ev].filter(f => f !== fn); }; },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect(); if (ro) ro.disconnect(); else window.removeEventListener("resize", fit);
      if (aborter) aborter.abort();
      if (document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener("loadingdone", onFonts);
      root.remove();
    },
  };

  applyStyle();
  fit();
  kick();
  return api;
}
