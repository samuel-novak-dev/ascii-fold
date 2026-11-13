// Side chains as sticks, the way ChimeraX shows atoms: 0.2 Å sticks with a ball of the same radius
// at every atom, each half-bond in its own atom's colour (carbon takes the residue's colour; N, O
// and S are coloured by element). Bonds come from distances, so any file works. Each side chain
// hangs from the cartoon: its Cα is drawn at the residue's point on the cartoon (for an idealised
// helix up to ~1 Å from the real one), so the sticks grow out of the ribbon.

import { add, sub, mul, norm, cross, dist } from "./vec.js";

// colour code per vertex: 0 = carbon (residue colour), else an element colour (ChimeraX's)
export const ELEMENT_RGB = [null, [48, 80, 248], [255, 13, 13], [255, 255, 48], [255, 161, 0]];
const CODE = { N: 1, O: 2, S: 3, SE: 4 };
const COV = { C: 0.76, N: 0.71, O: 0.66, S: 1.05, SE: 1.2 };   // covalent radii, Å
const BACKBONE = new Set(["N", "C", "O", "OXT"]);            // Cα stays: it's the anchor
const STICK = 0.2, SIDES = 8, STACKS = 6;

/** show(i): whether residue i shows its side chain. Returns a mesh like the cartoon's, plus el codes. */
export function sideChainMesh(G, show) {
  const A = G.atoms, P = [], N = [], res = [], el = [], T = [];
  const vert = (p, n, r, e) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); res.push(r); el.push(e); return res.length - 1; };

  // a small unit sphere, reused for every atom's ball
  const sph = [];
  for (let i = 0; i <= STACKS; i++) for (let j = 0; j <= SIDES; j++) {
    const th = Math.PI * i / STACKS, ph = 2 * Math.PI * j / SIDES;
    sph.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
  }
  const ball = (c, r, e) => {
    const base = res.length;
    for (const n of sph) vert(add(c, mul(n, STICK)), n, r, e);
    for (let i = 0; i < STACKS; i++) for (let j = 0; j < SIDES; j++) {
      const a = base + i * (SIDES + 1) + j, b = a + SIDES + 1;
      T.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };
  const tube = (p, q, r, e) => {   // an open cylinder from p to q
    const d = norm(sub(q, p)), u = norm(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u), base = res.length;
    for (const end of [p, q]) for (let j = 0; j < SIDES; j++) {
      const th = 2 * Math.PI * j / SIDES, n = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
      vert(add(end, mul(n, STICK)), n, r, e);
    }
    for (let j = 0; j < SIDES; j++) { const a = base + j, b = base + (j + 1) % SIDES; T.push(a, b, b + SIDES, a, b + SIDES, a + SIDES); }
  };

  for (let i0 = 0; i0 < A.n;) {
    const r = A.res[i0];
    let i1 = i0; while (i1 < A.n && A.res[i1] === r) i1++;
    if (show(r)) {
      const pro = G.resName[r] === "PRO", idx = [];
      for (let a = i0; a < i1; a++) { const nm = A.name[a]; if (!BACKBONE.has(nm) || (pro && nm === "N")) idx.push(a); }
      if (idx.some(a => A.name[a] !== "CA" && A.name[a] !== "N")) {   // glycine has nothing to show
        const real = a => [A.P[a * 3], A.P[a * 3 + 1], A.P[a * 3 + 2]];
        const at = a => A.name[a] === "CA" && G.anchor[r] ? G.anchor[r] : real(a);
        const code = a => CODE[A.el[a]] || 0;
        for (let j = 0; j < idx.length; j++) for (let k = j + 1; k < idx.length; k++) {
          const a = idx[j], b = idx[k];
          if (dist(real(a), real(b)) > (COV[A.el[a]] || 0.76) + (COV[A.el[b]] || 0.76) + 0.45) continue;
          const pa = at(a), pb = at(b), mid = mul(add(pa, pb), 0.5);
          tube(pa, mid, r, code(a)); tube(mid, pb, r, code(b));
        }
        for (const a of idx) ball(at(a), r, code(a));
      }
    }
    i0 = i1;
  }
  const nv = res.length;
  return { nv, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res), el: Uint8Array.from(el),
           band: new Float32Array(nv), face: new Float32Array(nv), nt: T.length / 3, T: Uint32Array.from(T) };
}
