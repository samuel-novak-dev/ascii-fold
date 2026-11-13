import { add, sub, mul, dot, cross, norm, dist } from "./vec.js";
import { buildGeometry, SHAPE_DEFAULT } from "./geometry.js";
import { parsePDB, parseStructure, readStructureFile } from "./parse.js";
import { fetchAFDB, describeAFDB } from "./afdb.js";
import KRAS_6GJ8 from "./data/kras-6gj8.js";
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";
import { surfaceMesh, meshAO, meshPoints, RES_BALL } from "./surface.js";
import { createGLView } from "./glview.js";
import { cartoonMesh } from "./cartoon.js";
import { sideChainMesh, ligandMesh, sideChainPoints, ligandPoints, ELEMENT_RGB, elementCss, ionRadius } from "./sticks.js";

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
// colour by chain: one colour per chain, in file order (repeating after ten)
export const CHAIN_COLOURS = ["#6495ed", "#ff7f50", "#20b2aa", "#db7093", "#ffa500", "#5f9ea0", "#c71585", "#a9a9a9", "#4682b4", "#cd5c5c"];
const MODES = new Set(["ss", "plddt", "chain"]);   // colours that depend on the residue
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
  perspective: 1, surface: false, glass: false, glassOpacity: 0.3, depth: 0.6, faces: false, sidechains: "none", ligands: true,
  spin: 0, motion: "turn", blendFrom: 0.4, blendTo: 0.6, interactive: true, background: true, palette: null,
  font: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
};

const MAX_CELLS = 70000, ZMIN = 0.4, ZMAX = 10;
const SPIN = 1.6;            // turn speed in rad/s at spin 1
const ROCK = 0.5;            // rock: swing ±0.5 rad (≈29°) about the screen's vertical axis
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
    const sc = MODES.has(o.colour) ? null : solidColour(o.colour);
    SOLID = sc ? { css: sc, rgb: hex(sc) } : null;
    probe.style.fontFamily = o.font;
    root.style.background = o.background ? p.bg : "transparent";
    ramp = GLYPHS[o.glyphs] || (typeof o.glyphs === "string" && o.glyphs.length > 2 ? o.glyphs : GLYPHS.classic);
    root.style.cursor = o.interactive ? "grab" : "default";
  }

  let renderScale = 1, vectorText = false, noKnock = false;   // set only while exporting
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
    const dpr = (window.devicePixelRatio || 1) * renderScale;   // renderScale > 1 only while taking a large snapshot
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
  const colourMode = () => o.colour === "plddt" ? (G && G.hasB ? "plddt" : "ss") : o.colour === "chain" ? "chain" : SOLID ? "solid" : "ss";   // "plddt": the B-factor column
  // a chain's colour follows its place among all the file's chains, so hiding one doesn't recolour the rest
  const chainColour = id => { const k = lastParsed && lastParsed.chains ? lastParsed.chains.findIndex(c => c.id === id) : 0; return CHAIN_COLOURS[Math.max(0, k) % CHAIN_COLOURS.length]; };
  function colours() {
    const mode = colourMode(), css = PAL.css;
    const key = [mode, css.H, css.E, css.C, css.P.join(), SOLID && SOLID.css, ovrVer, geomId].join("|");
    if (ctab && ctab.key === key) return ctab;
    const list = [], idx = new Map(), rc = new Uint8Array(G.N);
    const add = c => { if (!idx.has(c)) { idx.set(c, list.length); list.push({ css: c, rgb: hex(c) }); } return idx.get(c); };
    const byMode = (m, i) => m === "plddt" && G.hasB ? css.P[G.pkRes[i]] : m === "solid" ? SOLID.css : m === "chain" ? chainColour(G.resChain[i]) : css[G.ssRes[i]];
    for (let i = 0; i < G.N; i++) {
      const v = ovr.get(i);
      rc[i] = add(v === undefined ? byMode(mode, i) : MODES.has(v) ? byMode(v, i) : v);
    }
    return ctab = { key, list, rc };
  }
  const baseOf = q => { const t = colours(); return t.list[t.rc[q.res]].rgb; };

  // ---------- view helpers ----------
  const fitR = () => G.R + (o.surface || o.glass ? 4 : 0);   // the surface reaches past the chain
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
    if (labels.size) { drawLabels({ Rm, scl, kpx, OX, OY, dpr }); txtDirty = true; }
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
    const upload = (slot, mm, ms, ao) => {   // mesh, per-vertex colour from its residue, and (surface only) ambient occlusion
      if (v.mesh(slot) !== mm) { v.setMesh(slot, mm); ms.colKey = ""; ms.aoOn = false; }
      if (ms.colKey !== t.key) {
        const rgb = new Uint8Array(mm.nv * 3);
        for (let i = 0; i < mm.nv; i++) { const c = t.list[t.rc[mm.res[i]]].rgb; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
        v.setColours(slot, rgb); ms.colKey = t.key;
      }
      if (!ms.aoOn) { if (ao) v.setAO(slot, meshAO(mm)); ms.aoOn = true; }   // the cartoon is shaded by depth instead
    };
    upload(name, m, st, o.surface);
    const glass = !o.surface && o.glass;   // the see-through surface over the cartoon
    if (glass) upload("surface", mesh(), meshState, true);
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
      depth: 0.9 * clamp01(o.depth), fog: Math.min(1, 1.25 * clamp01(o.depth)), faces: !!o.faces, drange: [dn, df],   // depth: the Depth slider
      glass: glass ? "surface" : null, glassAlpha: clamp01(o.glassOpacity) }, names);
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
    const knock = o.background && !noKnock;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, txt.width, txt.height);
    if (vectorText) {   // a large snapshot: real text instead of atlas sprites, sharp at any size
      const rows = pal.list.flatMap(c => { const b = hex(c); return Array.from({ length: FOGS }, (_, fl) => { const f = fl / (FOGS - 1) * FOG_MAX; return rgb(b.map((v, i) => v * (1 - f) + PAL.paper[i] * f)); }); });
      tctx.font = `700 100px ${o.font}`; tctx.textAlign = "center"; tctx.textBaseline = "middle";
      for (let q = 0; q < cnt; q++) {
        const k = order[q], X = tx[k], Y = ty[k], k4 = k * 4, d = tk[k];
        if (knock && d > 0.5) { tctx.setTransform(d, 0, 0, d, X, Y); tctx.fillStyle = PAL.css.bg; tctx.beginPath(); tctx.arc(0, 0, 0.5 - 1 / CELL, 0, 2 * Math.PI); tctx.fill(); }
        tctx.setTransform(tm[k4] / 125, tm[k4 + 1] / 125, tm[k4 + 2] / 125, tm[k4 + 3] / 125, X, Y);   // atlas glyphs are 0.8 of a sprite: 100 px / 125
        tctx.fillStyle = rows[tr[k]]; tctx.fillText(ramp[tg[k]], 0, 0);
      }
    } else {
      const A = glyphAtlas(pal);
      for (let q = 0; q < cnt; q++) {
        const k = order[q], X = tx[k], Y = ty[k], k4 = k * 4, d = tk[k];
        if (knock && d > 0.5) { tctx.setTransform(d, 0, 0, d, X, Y); tctx.drawImage(A, 0, 0, CELL, CELL, -0.5, -0.5, 1, 1); }
        tctx.setTransform(tm[k4], tm[k4 + 1], tm[k4 + 2], tm[k4 + 3], X, Y);
        tctx.drawImage(A, tg[k] * CELL, tr[k] * CELL, CELL, CELL, -0.5, -0.5, 1, 1);
      }
    }
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    txtDirty = true;
  }

  // ---------- labels: pinned to residues and ligands, kept by chain + number so they survive chain changes ----------
  const labels = new Map();   // key ("r" + chain:num, or "l" + chain:num:name) → true, in the order they were added
  let labelIdx = null;
  function labelTargets() {   // key → { kind, i } in the current geometry
    if (labelIdx && labelIdx.id === geomId) return labelIdx.map;
    const map = new Map();
    G.resName.forEach((_, i) => map.set("r" + resKey(G, i), { kind: "residue", i }));
    G.ligands.forEach((l, i) => map.set("l" + ligKey(l), { kind: "ligand", i }));
    labelIdx = { id: geomId, map };
    return map;
  }
  const labelKey = (kind, i) => kind === "ligand" ? "l" + ligKey(G.ligands[i]) : "r" + resKey(G, i);
  function labelText(kind, i) {
    const multi = G.chains.length > 1;
    if (kind === "ligand") { const l = G.ligands[i]; return l.name + (multi ? ` (${l.chain})` : ""); }
    return (ONE[G.resName[i]] || "X") + G.resNum[i] + (multi ? ` (${G.resChain[i]})` : "");
  }
  // where a label's leader line starts: a shown side chain's tip, a surface residue's outermost atom,
  // a ligand's centre, or the residue's point on the cartoon
  function labelAnchor(kind, i) {
    if (kind === "ligand") { const P = G.ligands[i].P; return mul(P.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / P.length); }
    const A = G.atoms, side = !o.surface && scShow && (scShow === "all" || scShow.has(i));
    if (o.surface || side) {
      let best = null, bd = -1;
      const ca = G.anchor[i] || G.ca[i];
      for (let a = 0; a < A.n; a++) {
        if (A.res[a] !== i) continue;
        const p = [A.P[a * 3], A.P[a * 3 + 1], A.P[a * 3 + 2]], d = o.surface ? Math.hypot(...p) : dist(p, ca);
        if (d > bd) { bd = d; best = p; }
      }
      if (best) return best;
    }
    return G.anchor[i] || G.ca[i];
  }
  function drawLabels(F) {
    const { scl, kpx, OX, OY, dpr } = F, M = F.Rm, targets = labelTargets(), ink = PAL.css.ink, bg = PAL.css.bg;
    const proj = p => { const vx = M[0] * p[0] + M[1] * p[1] + M[2] * p[2], vy = M[3] * p[0] + M[4] * p[1] + M[5] * p[2], vz = M[6] * p[0] + M[7] * p[1] + M[8] * p[2], sc = scl(vz);
      return [OX + (vx * sc + panX) * kpx, OY - (vy * sc + panY) * kpx]; };
    const [cx, cy] = proj([0, 0, 0]), lead = 26 * dpr, fs = 12.5 * dpr;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.font = `700 ${fs}px ${o.font}`; tctx.textBaseline = "middle"; tctx.lineJoin = "round";
    for (const key of labels.keys()) {
      const t = targets.get(key); if (!t) continue;   // its chain is hidden
      const [ax, ay] = proj(labelAnchor(t.kind, t.i));
      let dx = ax - cx, dy = ay - cy; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      if (dl < 1) { dx = 0.7; dy = -0.7; }
      const lx = ax + dx * lead, ly = ay + dy * lead, right = dx >= 0, text = labelText(t.kind, t.i);
      tctx.strokeStyle = bg; tctx.lineWidth = 3.2 * dpr; tctx.beginPath(); tctx.moveTo(ax, ay); tctx.lineTo(lx, ly); tctx.stroke();
      tctx.strokeStyle = ink; tctx.lineWidth = 1.1 * dpr; tctx.beginPath(); tctx.moveTo(ax, ay); tctx.lineTo(lx, ly); tctx.stroke();
      tctx.fillStyle = ink; tctx.beginPath(); tctx.arc(ax, ay, 2.2 * dpr, 0, 2 * Math.PI); tctx.fill();
      tctx.textAlign = right ? "left" : "right";
      const tx0 = lx + (right ? 4 : -4) * dpr;
      tctx.strokeStyle = bg; tctx.lineWidth = 4 * dpr; tctx.strokeText(text, tx0, ly);
      tctx.fillText(text, tx0, ly);
    }
  }

  // What's under a point on screen: the front-most residue (its cartoon, side chain or surface atoms)
  // or ligand. Returns { kind: "residue" | "ligand", i } or null.
  function pickAt(clientX, clientY) {
    if (!G || !inner) return null;
    const rect = inner.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top;
    const R = fitR(), S = baseScale() * zoom, kz = clamp01(o.perspective) * PERSP / R, M = Rm;
    const kpx = S * aspect * lh, OX = COLS / 2 * cw, OY = ROWS / 2 * lh;
    let best = null, near = null;
    const test = (px, py, pz, rad, kind, i) => {
      const vx = M[0] * px + M[1] * py + M[2] * pz, vy = M[3] * px + M[4] * py + M[5] * pz, vz = M[6] * px + M[7] * py + M[8] * pz;
      const sc = 1 / Math.max(0.3, 1 - kz * vz), d = Math.hypot(OX + (vx * sc + panX) * kpx - x, OY - (vy * sc + panY) * kpx - y);
      if (d <= Math.max(3, rad * sc * kpx)) { if (!best || vz > best.z) best = { kind, i, z: vz }; }
      else if (d < 10 && (!near || d < near.d)) near = { kind, i, d };
    };
    const A = G.atoms;
    if (o.surface) for (let a = 0; a < A.n; a++) test(A.P[a * 3], A.P[a * 3 + 1], A.P[a * 3 + 2], A.R[a], "residue", A.res[a]);
    else {
      for (const q of G.pts) if (!q.gap) test(q.p[0], q.p[1], q.p[2], Math.max(1.1, q.wOut || 0, shape.coilR), "residue", q.res);
      if (scShow) for (let a = 0; a < A.n; a++) {
        const r = A.res[a];
        if ((scShow === "all" || scShow.has(r)) && !["N", "C", "O", "CA"].includes(A.name[a])) test(A.P[a * 3], A.P[a * 3 + 1], A.P[a * 3 + 2], 0.6, "residue", r);
      }
    }
    if (o.ligands) G.ligands.forEach((l, li) => l.P.forEach(p => test(p[0], p[1], p[2], l.ion ? ionRadius(l.el[0]) : 0.7, "ligand", li)));
    const hit = best || near;
    return hit ? { kind: hit.kind, i: hit.i } : null;
  }

  // ---------- animation (paused while off-screen) ----------
  let raf = 0, prev = performance.now(), visible = true, dragging = false, destroyed = false, capturing = false, rockPh = 0;
  // one seamless loop: a full turn, or one swing out and back. angleAt(f): the angle at f (0–1) of it
  const loopSeconds = () => (o.motion === "rock" ? 2 * Math.PI * ROCK : 2 * Math.PI) / (SPIN * Math.max(0.1, o.spin || 0));
  const angleAt = f => o.motion === "rock" ? ROCK * Math.sin(2 * Math.PI * f) : 2 * Math.PI * f;
  function loop(t) {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, (t - prev) / 1000); prev = t;
    if (capturing) { raf = 0; return; }
    if (!dragging && o.spin) {
      if (o.motion === "rock") {   // swing ±ROCK, as fast at the middle as a turn at this speed
        const a0 = Math.sin(rockPh); rockPh = (rockPh + o.spin * SPIN / ROCK * dt) % (2 * Math.PI);
        Rm = turn(ROCK * (Math.sin(rockPh) - a0), 0, Rm);
      } else Rm = turn(o.spin * dt * SPIN, 0, Rm);
    }
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
  // a click that isn't a drag reports what's under it ("pick"), unless it turns out to be a double-click
  let downAt = null, pickTimer = 0;
  root.addEventListener("pointerdown", e => { downAt = e.button === 0 && !e.shiftKey && !e.altKey ? [e.clientX, e.clientY] : null; }, true);
  root.addEventListener("click", e => {
    if (!o.interactive || !downAt || e.detail > 1 || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const x = e.clientX, y = e.clientY;
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => { const hit = pickAt(x, y); emit("pick", hit); }, 260);
  });
  root.addEventListener("dblclick", () => { clearTimeout(pickTimer); if (o.interactive) resetView(); });

  // ---------- export helpers ----------
  function cropBox(crop) {
    let x0 = 0, x1 = COLS, y0 = 0, y1 = ROWS;
    if (crop && lastBox) {
      x0 = Math.max(0, Math.floor(lastBox.x0) - 1); x1 = Math.min(COLS, Math.ceil(lastBox.x1) + 1);
      y0 = Math.max(0, Math.floor(lastBox.y0) - 1); y1 = Math.min(ROWS, Math.ceil(lastBox.y1) + 1);
    }
    return { i0: x0, i1: x1, j0: y0, j1: y1, w: (x1 - x0) * cw, h: (y1 - y0) * lh };
  }
  function composeFrame(ctx, box, scale, pad, transparent = false) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (transparent) ctx.clearRect(0, 0, box.w + pad * 2, box.h + pad * 2);
    else { ctx.fillStyle = PAL.css.bg; ctx.fillRect(0, 0, box.w + pad * 2, box.h + pad * 2); }
    const dpr = rib.width / (COLS * cw);
    ctx.drawImage(rib, box.i0 * cw * dpr, box.j0 * lh * dpr, box.w * dpr, box.h * dpr, pad, pad, box.w, box.h);
    ctx.drawImage(txt, box.i0 * cw * dpr, box.j0 * lh * dpr, box.w * dpr, box.h * dpr, pad, pad, box.w, box.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------- chains: which of the file's protein chains are drawn ----------
  let chainSel = null;   // null: all of them
  const MANY = 6000;     // residues: above this only the first chain is drawn at first
  function shownParsed(p) {
    if (!chainSel || !p.chains || p.chains.every(c => chainSel.has(c.id))) return p;
    const keep = p.rows.map(r => chainSel.has(r.chain));
    return { ...p, rows: p.rows.filter((_, i) => keep[i]), ss: p.ss && p.ss.filter((_, i) => keep[i]),
             ligands: (p.ligands || []).filter(l => !l.near || l.near.some(c => chainSel.has(c))) };
  }
  // Rebuild after the shown chains change: per-residue and per-ligand colours and side-chain picks
  // follow their residues (chain + number), not their old positions.
  const resKey = (g, i) => g.resChain[i] + ":" + g.resNum[i];
  const ligKey = l => l.chain + ":" + l.num + ":" + l.name;
  // Colours of residues and ligands in hidden chains wait in `stash` until their chain is back.
  const stash = new Map();
  function rebuild() {
    const old = G;
    G = buildGeometry(shownParsed(lastParsed), shape); geomId++;
    if (!old) return;
    for (const [i, c] of ovr) stash.set("r" + resKey(old, i), c);
    for (const [i, c] of ligOvr) stash.set("l" + ligKey(old.ligands[i]), c);
    ovr.clear(); ligOvr.clear(); ovrVer++; ligVer++;
    G.resName.forEach((_, i) => { const k = "r" + resKey(G, i); if (stash.has(k)) { ovr.set(i, stash.get(k)); stash.delete(k); } });
    G.ligands.forEach((l, i) => { const k = "l" + ligKey(l); if (stash.has(k)) { ligOvr.set(i, stash.get(k)); stash.delete(k); } });
    const at = new Map(G.resName.map((_, i) => [resKey(G, i), i]));
    if (scShow && scShow !== "all") scShow = new Set([...scShow].map(i => at.get(resKey(old, i))).filter(j => j !== undefined));
  }

  const chainLabel = p => { const c = (p.chains || []).map(c => c.id); return c.length > 1 ? `chains ${c.join(", ")}` : `chain ${p.chain}`; };

  // ---------- public API ----------
  let loadToken = 0, aborter = null;
  function setStructure(parsed, meta = {}) {
    lastParsed = parsed;
    const total = parsed.rows.length, chains = parsed.chains || [];
    chainSel = chains.length > 1 && total > MANY ? new Set([chains[0].id]) : null;
    G = null; rebuild();
    ovr.clear(); ovrVer++; ligOvr.clear(); ligVer++; stash.clear(); labels.clear();
    info = { title: meta.title || parsed.title || "Structure", sub: meta.sub || "", residues: G.N, meanPlddt: G.hasPlddt ? G.meanP : null, meanB: G.hasB ? G.meanP : null,
             hasPlddt: G.hasPlddt, hasB: G.hasB, ligands: G.ligands.length, fromAFDB: G.fromAFDB || !!meta.entryUrl, ssFromGeometry: G.ssAuto, chain: parsed.chain, chains: chains.map(c => c.id), entryUrl: meta.entryUrl || null, acc: meta.acc || null };
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
      if (lastParsed) { G = buildGeometry(shownParsed(lastParsed), shape); geomId++; }
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
        sub: [afId ? `AF-${afId.acc}-F${afId.frag}` : (parsed.title || "local file"), chainLabel(parsed)].join(" · "),
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
    /**
     * Current frame (model + text) as a PNG data URL, rendered afresh at `scale` output pixels per
     * screen pixel (up to what the GPU allows), with the text drawn as real glyphs so it stays sharp.
     * crop: trim to the protein · transparent: no background (and no paper discs under the glyphs).
     */
    snapshot({ scale = 2, pad = 40, crop = true, transparent = false } = {}) {
      const dpr = window.devicePixelRatio || 1, v = view3d();
      let rs = Math.max(1, scale / dpr);
      const W = root.clientWidth * dpr, H = root.clientHeight * dpr, lim = v ? v.maxSize : 8192;
      rs = Math.min(rs, lim / W, lim / H, Math.sqrt(64e6 / (W * H)));   // the GPU's limit, and ~64 Mpx
      renderScale = Math.max(1, rs); vectorText = true; noKnock = transparent;
      try {
        fit(); render();
        const box = cropBox(crop), c = document.createElement("canvas");
        c.width = Math.round((box.w + pad * 2) * scale); c.height = Math.round((box.h + pad * 2) * scale);
        composeFrame(c.getContext("2d"), box, scale, pad, transparent);
        return c.toDataURL("image/png");
      } finally {
        renderScale = 1; vectorText = false; noKnock = false; fit(); render();
      }
    },
    /** Seconds in one loop of the motion (a turn, or a rock out and back) at the current spin speed. */
    loopSeconds,
    /**
     * Record one loop of the motion (a full turn, or one rock) as an animated GIF. Each frame is
     * rendered at an exact angle, so the loop is seamless. Resolves to a Blob (image/gif).
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
        const frameAt = i => { Rm = turn(angleAt(i / frames), 0, R0); render(); composeFrame(ctx, box, scale, pad); return ctx.getImageData(0, 0, W, H).data; };
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
    /**
     * Record one loop of the motion as a video (WebM, or MP4 where that's all the browser records).
     * Frames are rendered at exact angles and paced in real time, so it takes as long as the loop.
     * Resolves to a Blob; its type says which format.
     */
    async recordVideo({ fps = 30, width = 1080, pad = 24, crop = true, onProgress, signal } = {}) {
      if (!G) throw new Error("Nothing loaded");
      if (capturing) throw new Error("Already recording");
      const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1", "video/mp4"];
      const type = typeof MediaRecorder === "function" && types.find(t => MediaRecorder.isTypeSupported(t));
      if (!type) throw new Error("this browser can't record video; try the GIF");
      capturing = true;
      const R0 = Rm.slice();
      try {
        render();
        const box = cropBox(crop), scale = width / (box.w + pad * 2);
        const W = Math.round(width / 2) * 2, H = Math.round((box.h + pad * 2) * scale / 2) * 2;   // even sizes, for the encoders
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const ctx = c.getContext("2d"), stream = c.captureStream(0), track = stream.getVideoTracks()[0];
        const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(W * H * fps * 0.25) });
        const chunks = [], done = new Promise(r => { rec.onstop = r; });
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        const frames = Math.max(12, Math.round(loopSeconds() * fps)), t0 = performance.now();
        rec.start();
        for (let i = 0; i < frames; i++) {   // the next frame would be the first again: the loop is seamless
          if (signal && signal.aborted) { rec.stop(); await done; throw new DOMException("Recording cancelled", "AbortError"); }
          Rm = turn(angleAt(i / frames), 0, R0); render(); composeFrame(ctx, box, scale, pad);
          if (track.requestFrame) track.requestFrame();
          if (onProgress) onProgress(i / frames);
          const wait = t0 + (i + 1) * 1000 / fps - performance.now();
          await new Promise(r => setTimeout(r, Math.max(0, wait)));
        }
        rec.stop(); await done;
        return new Blob(chunks, { type: type.split(";")[0] });
      } finally {
        Rm = R0; capturing = false; render(); kick();
      }
    },
    palette() { return { ...PAL.css }; },
    /** Residues for a sequence view: [{ i, num, name, aa, ss }]. */
    residues() { return G ? G.resName.map((name, i) => ({ i, num: G.resNum[i], chain: G.resChain[i], name, aa: ONE[name] || "X", ss: G.ssRes[i] })) : []; },
    /** The file's protein chains: [{ id, n (residues), shown, colour (its colour when colouring by chain) }]. */
    chains() { return lastParsed ? (lastParsed.chains || []).map(c => ({ id: c.id, n: c.n, shown: !chainSel || chainSel.has(c.id), colour: chainColour(c.id) })) : []; },
    /** Draw only these chains (ids; null or empty: all). Colours and side chains stay with their residues. */
    showChains(ids) {
      if (!lastParsed) return api;
      const all = (lastParsed.chains || []).map(c => c.id), want = ids && ids.length ? all.filter(c => ids.includes(c)) : all;
      chainSel = want.length && want.length < all.length ? new Set(want) : null;
      rebuild(); kick(); emit("chains", api.chains()); return api;
    },
    /** Each residue's current colour (css), after any per-residue colours. */
    residueColours() { if (!G) return []; const t = colours(); return Array.from(t.rc, c => t.list[c].css); },
    /** Colour residues (indices) by "ss", "plddt", a colour name or hex; null returns them to the overall colour. */
    colourResidues(indices, colour) {
      const c = colour == null ? null : MODES.has(colour) ? colour : solidColour(colour);
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
    /** Colour ligands (indices) with a colour name or hex; null (or "ss" / "plddt" / "chain") returns them to their own colour. */
    colourLigands(indices, colour) {
      const c = colour == null || MODES.has(colour) ? null : solidColour(colour);
      if (colour != null && !MODES.has(colour) && !c) throw new Error(`Unknown colour: ${colour}`);
      for (const i of indices) if (c === null) ligOvr.delete(i); else ligOvr.set(i, c);
      ligVer++; kick(); emit("colour"); return api;
    },
    /** Labels pinned in the view: [{ kind: "residue" | "ligand", i, text }] (those in hidden chains left out). */
    labels() {
      if (!G) return [];
      const t = labelTargets();
      return [...labels.keys()].map(k => t.get(k)).filter(Boolean).map(({ kind, i }) => ({ kind, i, text: labelText(kind, i) }));
    },
    /** Pin a label on a residue or ligand (kind "residue" | "ligand", index), or take it off (on: false). Omit on to toggle. */
    label(kind, i, on) {
      if (!G) return api;
      const k = labelKey(kind, i), has = labels.has(k);
      if (on === undefined ? has : !on) labels.delete(k); else if (!has) labels.set(k, true);
      kick(); emit("labels", api.labels()); return api;
    },
    /** What's at a point on screen (client px): { kind, i } or null. Clicks report it as the "pick" event. */
    pick(x, y) { return pickAt(x, y); },
    clearLabels() { labels.clear(); kick(); emit("labels", []); return api; },
    /**
     * The whole view as plain data (JSON-safe): display options, shape, orientation, zoom and pan,
     * shown chains, per-residue and per-ligand colours, side chains and labels. Residues and ligands
     * are named by chain and number, so a view can be applied to the same structure loaded again.
     */
    getView() {
      if (!G) return null;
      const keep = ["theme", "colour", "layout", "glyphs", "detail", "perspective", "surface", "glass", "glassOpacity", "depth",
        "faces", "ligands", "spin", "motion"];
      return {
        format: "ascii-fold-view", version: 1,
        structure: { title: info && info.title, residues: lastParsed.rows.length, chains: (lastParsed.chains || []).map(c => c.id) },
        options: Object.fromEntries(keep.map(k => [k, o[k]])), shape: { ...shape },
        rotation: Rm.slice(), zoom, pan: [panX, panY],
        chains: chainSel ? [...chainSel] : null,
        residueColours: [...[...ovr].map(([i, c]) => [resKey(G, i), c]), ...[...stash].filter(([k]) => k[0] === "r").map(([k, c]) => [k.slice(1), c])],
        ligandColours: [...[...ligOvr].map(([i, c]) => [ligKey(G.ligands[i]), c]), ...[...stash].filter(([k]) => k[0] === "l").map(([k, c]) => [k.slice(1), c])],
        sideChains: scShow === "all" ? "all" : scShow ? [...scShow].map(i => resKey(G, i)) : null,
        labels: [...labels.keys()],
      };
    },
    /**
     * Apply a view from getView(). Residues, ligands and labels the loaded structure doesn't have are
     * skipped; returns how many of each were matched and missed.
     */
    setView(v) {
      if (!v || v.format !== "ascii-fold-view") throw new Error("not an ascii-fold view file");
      if (!G) throw new Error("load a structure first");
      if (v.options) api.set(v.options);
      if (v.shape) api.setShape(v.shape);
      if (lastParsed.chains && lastParsed.chains.length > 1) api.showChains(v.chains || null);
      const at = new Map(G.resName.map((_, i) => [resKey(G, i), i])), lat = new Map(G.ligands.map((l, i) => [ligKey(l), i]));
      const known = new Set(lastParsed.rows.map(r => r.chain + ":" + r.num)), lknown = new Set((lastParsed.ligands || []).map(ligKey));
      const tally = { residues: 0, ligands: 0, missed: 0 };
      ovr.clear(); ligOvr.clear(); stash.clear();
      for (const [k, c] of v.residueColours || []) {
        if (at.has(k)) { ovr.set(at.get(k), c); tally.residues++; } else if (known.has(k)) stash.set("r" + k, c); else tally.missed++;
      }
      for (const [k, c] of v.ligandColours || []) {
        if (lat.has(k)) { ligOvr.set(lat.get(k), c); tally.ligands++; } else if (lknown.has(k)) stash.set("l" + k, c); else tally.missed++;
      }
      ovrVer++; ligVer++;
      setSideChains(v.sideChains === "all" ? "all" : Array.isArray(v.sideChains) ? v.sideChains.map(k => at.get(k)).filter(i => i !== undefined) : null);
      labels.clear();
      for (const k of v.labels || []) if (known.has(k.slice(1)) || lknown.has(k.slice(1))) labels.set(k, true); else tally.missed++;
      if (Array.isArray(v.rotation) && v.rotation.length === 9 && v.rotation.every(Number.isFinite)) Rm = v.rotation.slice();
      if (Number.isFinite(v.zoom)) zoom = Math.max(ZMIN, Math.min(ZMAX, v.zoom));
      if (Array.isArray(v.pan)) [panX, panY] = v.pan.map(x => +x || 0);
      kick(); emit("zoom", zoom); emit("colour"); emit("labels", api.labels());
      return tally;
    },
    /** Drop all per-residue and per-ligand colours. */
    clearResidueColours() { ovr.clear(); ovrVer++; ligOvr.clear(); ligVer++; stash.clear(); kick(); emit("colour"); return api; },
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
