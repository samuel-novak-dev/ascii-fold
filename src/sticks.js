// Atoms as sticks, the way ChimeraX shows them: 0.2 Å sticks with a ball of the same radius at
// every atom, each half-bond in its own atom's colour. Carbon takes its owner's colour (the
// residue's, or the ligand's); other elements take ChimeraX's element colours. Bonds come from
// distances, so any file works.
//
// sideChainMesh: each side chain hangs from the cartoon. Its Cα is drawn at the residue's point on
// the cartoon (for an idealised helix up to ~1 Å from the real one), so the sticks grow out of the ribbon.
// ligandMesh: every ligand as sticks, and every ion as one larger ball in the ligand's colour.
// sideChainPoints / ligandPoints walk the same atoms and bonds but return points on the sticks'
// and balls' surfaces (with normals), for the 3D text to print glyphs on.

import { add, sub, mul, norm, cross, dist } from "./vec.js";

// ChimeraX's element colours (Jmol's). Code 0 is carbon, which takes its owner's colour.
const ELEMENT_COLOURS = {
  N: [48, 80, 248], O: [255, 13, 13], S: [255, 255, 48], SE: [255, 161, 0], P: [255, 128, 0], F: [144, 224, 80],
  CL: [31, 240, 31], BR: [166, 41, 41], I: [148, 0, 148], B: [255, 181, 181], SI: [240, 200, 160], AS: [189, 128, 227],
  FE: [224, 102, 51], MG: [138, 255, 0], ZN: [125, 128, 176], CA: [61, 255, 0], NA: [171, 92, 242], K: [143, 64, 212],
  MN: [156, 122, 199], CU: [200, 128, 51], CO: [240, 144, 160], NI: [80, 208, 80], CD: [255, 217, 143], HG: [184, 184, 208],
  LI: [204, 128, 255], SR: [0, 255, 0], BA: [0, 201, 0], RB: [112, 46, 176], CS: [87, 23, 143], PT: [208, 208, 224],
  AU: [255, 209, 35], AG: [192, 192, 192], MO: [84, 181, 181], W: [33, 148, 214], V: [166, 166, 171], RU: [36, 143, 143],
};
const OTHER = [255, 20, 147];   // anything else: deep pink, as in ChimeraX
const ELEMENTS = Object.keys(ELEMENT_COLOURS);
/** RGB per element code; null at code 0 (carbon: the owner's colour). */
export const ELEMENT_RGB = [null, ...ELEMENTS.map(e => ELEMENT_COLOURS[e]), OTHER];
const code = el => el === "C" ? 0 : ELEMENT_COLOURS[el] ? ELEMENTS.indexOf(el) + 1 : ELEMENT_RGB.length - 1;
/** css colour of an element, for an ion's default colour */
export const elementCss = el => { const c = ELEMENT_COLOURS[el] || OTHER; return "#" + c.map(v => v.toString(16).padStart(2, "0")).join(""); };

const COV = { C: 0.76, N: 0.71, O: 0.66, S: 1.05, SE: 1.2, P: 1.07, F: 0.57, CL: 1.02, BR: 1.2, I: 1.39, B: 0.84, SI: 1.11,
  AS: 1.19, FE: 1.32, ZN: 1.22, CU: 1.32, CO: 1.26, NI: 1.24, MN: 1.39, MG: 1.41 };   // covalent radii, Å
const bonded = (p, ep, q, eq) => dist(p, q) <= (COV[ep] || 0.76) + (COV[eq] || 0.76) + 0.45;
// van der Waals radii of common ions (Bondi, and similar for the metals Bondi lacks); an ion's ball is 0.45 of it
const ION_VDW = { NA: 2.27, K: 2.75, MG: 1.73, CA: 2.31, ZN: 1.39, MN: 2.0, FE: 2.0, CU: 1.4, CO: 2.0, NI: 1.63, CD: 1.58,
  HG: 1.55, CL: 1.75, BR: 1.85, I: 1.98, F: 1.47, LI: 1.82, SR: 2.49, BA: 2.68, RB: 3.03, CS: 3.43 };
export const ionRadius = el => Math.max(0.6, Math.min(1.3, 0.45 * (ION_VDW[el] || 1.8)));

const BACKBONE = new Set(["N", "C", "O", "OXT"]);            // Cα stays: it's the anchor
const STICK = 0.2, SIDES = 8;

function unitSphere(stacks, sides) {
  const v = [];
  for (let i = 0; i <= stacks; i++) for (let j = 0; j <= sides; j++) {
    const th = Math.PI * i / stacks, ph = 2 * Math.PI * j / sides;
    v.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
  }
  return { v, stacks, sides };
}
const SMALL = unitSphere(6, SIDES), LARGE = unitSphere(16, 24);

// A mesh like the cartoon's: positions, normals, owner index (res) and element code (el) per vertex.
function meshBuilder() {
  const P = [], N = [], res = [], el = [], T = [];
  const vert = (p, n, r, e) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); res.push(r); el.push(e); return res.length - 1; };
  return {
    ball(c, rad, r, e, S = SMALL) {
      const base = res.length;
      for (const n of S.v) vert(add(c, mul(n, rad)), n, r, e);
      for (let i = 0; i < S.stacks; i++) for (let j = 0; j < S.sides; j++) {
        const a = base + i * (S.sides + 1) + j, b = a + S.sides + 1;
        T.push(a, b, a + 1, a + 1, b, b + 1);
      }
    },
    tube(p, q, r, e) {   // an open cylinder from p to q
      const d = norm(sub(q, p)), u = norm(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u), base = res.length;
      for (const end of [p, q]) for (let j = 0; j < SIDES; j++) {
        const th = 2 * Math.PI * j / SIDES, n = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
        vert(add(end, mul(n, STICK)), n, r, e);
      }
      for (let j = 0; j < SIDES; j++) { const a = base + j, b = base + (j + 1) % SIDES; T.push(a, b, b + SIDES, a, b + SIDES, a + SIDES); }
    },
    bond(pa, ea, pb, eb, r) {   // two half-sticks, each in its own atom's colour
      const mid = mul(add(pa, pb), 0.5);
      this.tube(pa, mid, r, code(ea)); this.tube(mid, pb, r, code(eb));
    },
    done() {
      const nv = res.length;
      return { nv, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res), el: Uint8Array.from(el),
               band: new Float32Array(nv), face: new Float32Array(nv), nt: T.length / 3, T: Uint32Array.from(T) };
    },
  };
}

// Points for glyphs, da apart along a stick and about dr apart around it (or over an ion's ball).
// A stick atom's own small ball gets none: the sticks' rings already reach it.
function pointBuilder(da, dr) {
  const P = [], N = [], res = [], el = [];
  const put = (p, n, r, e) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); res.push(r); el.push(e); };
  return {
    ball(c, rad, r, e) {
      if (rad <= STICK) return;
      const m = Math.max(8, Math.round(4 * Math.PI * rad * rad / (da * dr))), ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < m; i++) {   // a Fibonacci sphere: evenly spread
        const y = 1 - 2 * (i + 0.5) / m, rr = Math.sqrt(1 - y * y), n = [rr * Math.cos(ga * i), y, rr * Math.sin(ga * i)];
        put(add(c, mul(n, rad)), n, r, e);
      }
    },
    tube(p, q, r, e) {
      const L = dist(p, q), d = norm(sub(q, p)), u = norm(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u);
      const rows = Math.max(1, Math.round(L / da)), m = Math.max(4, Math.round(2 * Math.PI * STICK / dr));
      for (let k = 0; k < rows; k++) {
        const c = add(p, mul(sub(q, p), (k + 0.5) / rows)), off = (k & 1) * 0.5;
        for (let j = 0; j < m; j++) {
          const th = 2 * Math.PI * (j + off) / m, n = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
          put(add(c, mul(n, STICK)), n, r, e);
        }
      }
    },
    bond(pa, ea, pb, eb, r) { const mid = mul(add(pa, pb), 0.5); this.tube(pa, mid, r, code(ea)); this.tube(mid, pb, r, code(eb)); },
    done() { return { n: res.length, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res), el: Uint8Array.from(el) }; },
  };
}

function walkSideChains(G, show, B) {
  const A = G.atoms;
  for (let i0 = 0; i0 < A.n;) {
    const r = A.res[i0];
    let i1 = i0; while (i1 < A.n && A.res[i1] === r) i1++;
    if (show(r)) {
      const pro = G.resName[r] === "PRO", idx = [];
      for (let a = i0; a < i1; a++) { const nm = A.name[a]; if (!BACKBONE.has(nm) || (pro && nm === "N")) idx.push(a); }
      if (idx.some(a => A.name[a] !== "CA" && A.name[a] !== "N")) {   // glycine has nothing to show
        const real = a => [A.P[a * 3], A.P[a * 3 + 1], A.P[a * 3 + 2]];
        const at = a => A.name[a] === "CA" && G.anchor[r] ? G.anchor[r] : real(a);
        for (let j = 0; j < idx.length; j++) for (let k = j + 1; k < idx.length; k++) {
          const a = idx[j], b = idx[k];
          if (bonded(real(a), A.el[a], real(b), A.el[b])) B.bond(at(a), A.el[a], at(b), A.el[b], r);
        }
        for (const a of idx) B.ball(at(a), STICK, r, code(A.el[a]));
      }
    }
    i0 = i1;
  }
  return B.done();
}
/** show(i): whether residue i shows its side chain. */
export const sideChainMesh = (G, show) => walkSideChains(G, show, meshBuilder());
export const sideChainPoints = (G, show, da, dr) => walkSideChains(G, show, pointBuilder(da, dr));

/** Every ligand in G.ligands; res holds the ligand's index. An ion is one ball, all in the ligand's colour. */
export const ligandMesh = G => walkLigands(G, meshBuilder());
export const ligandPoints = (G, da, dr) => walkLigands(G, pointBuilder(da, dr));
function walkLigands(G, B) {
  G.ligands.forEach((l, li) => {
    if (l.ion) { B.ball(l.P[0], ionRadius(l.el[0]), li, 0, LARGE); return; }
    const n = l.P.length;
    for (let j = 0; j < n; j++) for (let k = j + 1; k < n; k++)
      if (bonded(l.P[j], l.el[j], l.P[k], l.el[k])) B.bond(l.P[j], l.el[j], l.P[k], l.el[k], li);
    for (let j = 0; j < n; j++) B.ball(l.P[j], STICK, li, code(l.el[j]));
  });
  return B.done();
}
