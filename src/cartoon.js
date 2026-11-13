// The cartoon as a triangle mesh for WebGL, as ChimeraX draws one: round tubes for loops (and for
// helices in cylinder mode) and flat bands for helices and strands, a thin box when they have
// thickness and a two-sided sheet when they don't. It's built from the same spline points, frames
// and widths as the 3D text, so the two line up exactly where one turns into the other.

import { add, sub, mul, norm } from "./vec.js";
import { rayAO } from "./surface.js";

const RING = 12;   // sides of a tube

export function cartoonMesh(G, shape) {
  const pts = G.pts, P = [], N = [], res = [], sheet = [], T = [];
  const vert = (p, n, r, sh = 0) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); res.push(r); sheet.push(sh); return res.length - 1; };
  const quad = (a, b, c, d) => T.push(a, b, c, a, c, d);
  const kindOf = k => { const a = pts[k]; return a.gap ? null : a.kind === "Hc" ? "cyl" : (a.kind === "C" || a.wOut === 0) ? "tube" : "band"; };
  const tangent = q => norm(sub(pts[Math.min(pts.length - 1, q + 1)].p, pts[Math.max(0, q - 1)].p));

  for (let k = 0; k < pts.length - 1;) {
    const kind = kindOf(k);
    if (kind === "tube" || kind === "cyl") {
      // one tube through a run of loop (or cylinder) segments, rings shared, ends capped
      let e = k; while (e < pts.length - 1 && kindOf(e) === kind) e++;
      const r = kind === "cyl" ? shape.cylR : shape.coilR;
      let prev = null;
      for (let q = k; q <= e; q++) {
        const pt = pts[q], ri = pts[Math.min(q, e - 1)].res, ring = [];
        for (let j = 0; j < RING; j++) {
          const th = 2 * Math.PI * j / RING, n = add(mul(pt.side, Math.cos(th)), mul(pt.nrm, Math.sin(th)));
          ring.push(vert(add(pt.p, mul(n, r)), n, ri));
        }
        if (prev) for (let j = 0; j < RING; j++) quad(prev[j], prev[(j + 1) % RING], ring[(j + 1) % RING], ring[j]);
        if (q === k || q === e) {   // flat cap
          const t = mul(tangent(q), q === k ? -1 : 1), c = vert(pt.p, t, ri), rim = [];
          for (let j = 0; j < RING; j++) rim.push(vert(P.slice(ring[j] * 3, ring[j] * 3 + 3), t, ri));
          for (let j = 0; j < RING; j++) T.push(c, rim[j], rim[(j + 1) % RING]);
        }
        prev = ring;
      }
      k = e;
    } else if (kind === "band") {
      // one band segment, with the same widths (arrow heads included) as the 2D ribbon
      const a = pts[k], b = pts[k + 1], ri = a.res;
      const wa = a.wOut, wb = (b.res === a.res || b.kind === a.kind) ? b.wIn : 0.04;
      const ha = a.th, hb = b.kind === a.kind ? b.th : a.th;
      const A = a.p, B = b.p, sa = a.side, sb = b.side, na = a.nrm, nb = b.nrm;
      const at = (p, s, w, n, h) => add(add(p, mul(s, w)), mul(n, h));
      if (Math.max(ha, hb) < 0.06) {   // paper-thin: one two-sided sheet
        quad(vert(at(A, sa, wa, na, 0), na, ri, 1), vert(at(A, sa, -wa, na, 0), na, ri, 1),
             vert(at(B, sb, -wb, nb, 0), nb, ri, 1), vert(at(B, sb, wb, nb, 0), nb, ri, 1));
      } else {                          // a thin box: two faces and two edges
        for (const sg of [1, -1]) {
          const nA = mul(na, sg), nB = mul(nb, sg);
          quad(vert(at(A, sa, wa, na, sg * ha), nA, ri), vert(at(A, sa, -wa, na, sg * ha), nA, ri),
               vert(at(B, sb, -wb, nb, sg * hb), nB, ri), vert(at(B, sb, wb, nb, sg * hb), nB, ri));
          const eA = mul(sa, sg), eB = mul(sb, sg);
          quad(vert(at(A, sa, sg * wa, na, ha), eA, ri), vert(at(A, sa, sg * wa, na, -ha), eA, ri),
               vert(at(B, sb, sg * wb, nb, -hb), eB, ri), vert(at(B, sb, sg * wb, nb, hb), eB, ri));
        }
      }
      k++;
    } else k++;
  }
  return { nv: res.length, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res),
           sheet: Uint8Array.from(sheet), nt: T.length / 3, T: Uint32Array.from(T) };
}

/** Ambient occlusion for the cartoon, from the cartoon itself (as in ChimeraX, only what's shown
 *  casts shadows). The triangles are sampled every ~0.4 Å into a 0.5 Å grid, and rays step finer
 *  than the grid so they can't jump a thin band; they start just clear of the cartoon's own skin. */
export function cartoonAO(mesh) {
  if (mesh.ao) return mesh.ao;
  const P = mesh.P, nv = mesh.nv, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[v * 3 + a]); hi[a] = Math.max(hi[a], P[v * 3 + a]); }
  for (let a = 0; a < 3; a++) { lo[a] -= 2; hi[a] += 2; }
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]), h = Math.max(0.5, Math.cbrt(vol / 6e6));
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const occ = new Uint8Array(nx * ny * nz), T = mesh.T;
  const mark = (x, y, z) => { occ[Math.round((x - lo[0]) / h) + nx * (Math.round((y - lo[1]) / h) + ny * Math.round((z - lo[2]) / h))] = 1; };
  for (let t = 0; t < mesh.nt; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const e = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]),
                       Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]));
    const n = Math.max(1, Math.ceil(e / 0.4));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, s = 1 - u - w;
      mark(s * P[a] + u * P[b] + w * P[c], s * P[a + 1] + u * P[b + 1] + w * P[c + 1], s * P[a + 2] + u * P[b + 2] + w * P[c + 2]);
    }
  }
  const inside = (x, y, z) => {
    const i = Math.round((x - lo[0]) / h), j = Math.round((y - lo[1]) / h), k = Math.round((z - lo[2]) / h);
    return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && occ[i + nx * (j + ny * k)] === 1;
  };
  return mesh.ao = rayAO(P, mesh.N, nv, inside, mesh.sheet, { LIFT: 0.6, STEP: 0.45, STEPS: 24 });
}
