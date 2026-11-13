// The cartoon as a triangle mesh for WebGL, as ChimeraX draws one: round tubes for loops and flat
// bands for helices and strands, a thin box when they have thickness and a two-sided sheet when
// they don't. It's built from the same spline points, frames
// and widths as the 3D text, so the two line up exactly where one turns into the other. Band
// vertices are flagged, so the renderer can keep each helix and strand one even colour, and helix
// faces carry +1 (outside, toward the side chains) or −1 (inside), so it can shade the two apart.

import { add, sub, mul, norm } from "./vec.js";

const RING = 12;   // sides of a tube

export function cartoonMesh(G, shape) {
  const pts = G.pts, P = [], N = [], res = [], band = [], face = [], T = [];
  const vert = (p, n, r, b = 0, f = 0) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); res.push(r); band.push(b); face.push(f); return res.length - 1; };
  const quad = (a, b, c, d) => T.push(a, b, c, a, c, d);
  const kindOf = k => { const a = pts[k]; return a.gap ? null : (a.kind === "C" || a.wOut === 0) ? "tube" : "band"; };
  const tangent = q => norm(sub(pts[Math.min(pts.length - 1, q + 1)].p, pts[Math.max(0, q - 1)].p));

  for (let k = 0; k < pts.length - 1;) {
    const kind = kindOf(k);
    if (kind === "tube") {
      // one tube through a run of loop segments, rings shared, ends capped
      let e = k; while (e < pts.length - 1 && kindOf(e) === kind) e++;
      const r = shape.coilR;
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
      const a = pts[k], b = pts[k + 1], ri = a.res, hx = a.kind === "H" ? 1 : 0;   // helix faces get a side
      const wa = a.wOut, wb = (b.res === a.res || b.kind === a.kind) ? b.wIn : 0.04;
      const ha = a.th, hb = b.kind === a.kind ? b.th : a.th;
      const A = a.p, B = b.p, sa = a.side, sb = b.side, na = a.nrm, nb = b.nrm;
      const at = (p, s, w, n, h) => add(add(p, mul(s, w)), mul(n, h));
      if (Math.max(ha, hb) < 0.06) {   // paper-thin: one two-sided sheet
        quad(vert(at(A, sa, wa, na, 0), na, ri, 1, hx), vert(at(A, sa, -wa, na, 0), na, ri, 1, hx),
             vert(at(B, sb, -wb, nb, 0), nb, ri, 1, hx), vert(at(B, sb, wb, nb, 0), nb, ri, 1, hx));
      } else {                          // a thin box: two faces and two edges
        for (const sg of [1, -1]) {
          const nA = mul(na, sg), nB = mul(nb, sg);
          quad(vert(at(A, sa, wa, na, sg * ha), nA, ri, 1, hx * sg), vert(at(A, sa, -wa, na, sg * ha), nA, ri, 1, hx * sg),
               vert(at(B, sb, -wb, nb, sg * hb), nB, ri, 1, hx * sg), vert(at(B, sb, wb, nb, sg * hb), nB, ri, 1, hx * sg));
          const eA = mul(sa, sg), eB = mul(sb, sg);
          quad(vert(at(A, sa, sg * wa, na, ha), eA, ri, 1), vert(at(A, sa, sg * wa, na, -ha), eA, ri, 1),
               vert(at(B, sb, sg * wb, nb, -hb), eB, ri, 1), vert(at(B, sb, sg * wb, nb, hb), eB, ri, 1));
        }
      }
      k++;
    } else k++;
  }
  return { nv: res.length, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res),
           band: Float32Array.from(band), face: Float32Array.from(face), nt: T.length / 3, T: Uint32Array.from(T) };
}
