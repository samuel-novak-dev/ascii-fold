// Molecular surfaces, sampled as points about `spacing` apart with outward normals and the residue
// each belongs to; the renderer draws them as glyphs (text) or as shaded discs (the solid surface).
//
// Both are "blobby" isosurfaces: every centre i adds exp(−B·(d²/rᵢ² − 1)) and the surface is where
// the sum is 1. A lone centre is a sphere of radius rᵢ; neighbours merge smoothly, filling crevices
// much as ChimeraX's 1.4 Å solvent probe does (lower B, smoother surface).
//   vdwSurface  one centre per heavy atom at its van der Waals radius, as in ChimeraX
//   caSurface   one centre per residue, for files without side chains (Cα only)

export const VDW = { C: 1.7, N: 1.55, O: 1.52, S: 1.8, SE: 1.9, P: 1.8 };   // Bondi radii, Å
export const VDW_DEFAULT = 1.7;
const ATOM_BLOB = 1.6, ATOM_PAD = 0.5;
const RES_R = 3.4, RES_BLOB = 0.69, RES_PAD = 1.2;   // a residue as a soft 3.4 Å ball

export const vdwSurface = (atoms, spacing) => blobSurface(atoms.P, atoms.R, atoms.res, ATOM_BLOB, ATOM_PAD, spacing);
export const caSurface = (ca, spacing) => blobSurface(Float32Array.from(ca.flat()), new Float32Array(ca.length).fill(RES_R),
  Uint32Array.from(ca, (_, i) => i), RES_BLOB, RES_PAD, spacing);
export const RES_BALL = RES_R;

function blobSurface(C, R, owner, B, pad, spacing) {
  const n = R.length, cutF = Math.sqrt(1 + 4.6 / B);   // beyond rᵢ·cutF a centre adds < 1%
  let rMax = 0;
  for (let i = 0; i < n; i++) rMax = Math.max(rMax, R[i]);
  const cell = rMax * cutF, key = (x, y, z) => (x * 2048 + y) * 2048 + z, cellOf = v => Math.floor(v / cell) + 1024;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(cellOf(C[i * 3]), cellOf(C[i * 3 + 1]), cellOf(C[i * 3 + 2]));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const inv2 = Float32Array.from(R, r => 1 / (r * r)), cut2 = Float32Array.from(R, r => r * r * cutF * cutF);

  // field value f, gradient g and the owner of the largest contribution, at (x, y, z)
  let f = 0, gx = 0, gy = 0, gz = 0, best = 0;
  const field = (x, y, z) => {
    f = gx = gy = gz = 0;
    let bw = -1;
    const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = grid.get(key(cx + a, cy + b, cz + c));
      if (!list) continue;
      for (const j of list) {
        const dx = x - C[j * 3], dy = y - C[j * 3 + 1], dz = z - C[j * 3 + 2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cut2[j]) continue;
        const e = Math.exp(-B * (d2 * inv2[j] - 1)), k = -2 * B * inv2[j] * e;
        f += e; gx += dx * k; gy += dy * k; gz += dz * k;
        if (e > bw) { bw = e; best = owner[j]; }
      }
    }
  };

  // kept points by grid cell, to thin them to roughly even spacing
  const P = [], N = [], res = [];
  const tc = spacing * 0.8, tc2 = tc * tc, tcell = v => Math.floor(v / tc) + 1024, kept = new Map();
  const tooClose = (x, y, z) => {
    const cx = tcell(x), cy = tcell(y), cz = tcell(z);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = kept.get(key(cx + a, cy + b, cz + c));
      if (!list) continue;
      for (const j of list) {
        const dx = x - P[j * 3], dy = y - P[j * 3 + 1], dz = z - P[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < tc2) return true;
      }
    }
    return false;
  };

  // Seed points on a ball just outside each centre (so crevices, where the merged surface lies
  // outside the lone-centre radius, still get seeds), push them onto the isosurface with Newton
  // steps along the gradient, drop buried ones and any that crowd a point already kept.
  const golden = Math.PI * (3 - Math.sqrt(5)), maxStep = Math.min(1, rMax * 0.5);
  for (let i = 0; i < n; i++) {
    const r0 = R[i] + pad, K = Math.max(8, Math.round(4 * Math.PI * r0 * r0 / (spacing * spacing) * 1.1)), spin = i * 2.399963;
    const ox = C[i * 3], oy = C[i * 3 + 1], oz = C[i * 3 + 2];
    for (let j = 0; j < K; j++) {
      const yv = 1 - 2 * (j + 0.5) / K, rr = Math.sqrt(1 - yv * yv), ph = j * golden + spin;
      let x = ox + r0 * rr * Math.cos(ph), y = oy + r0 * yv, z = oz + r0 * rr * Math.sin(ph);
      field(x, y, z);
      if (f > 4) continue;                               // deep inside: other centres cover this spot
      let ok = false;
      for (let it = 0; it < 8; it++) {
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 < 1e-12) break;
        let t = (f - 1) / g2;
        const len = Math.abs(t) * Math.sqrt(g2);
        if (len > maxStep) t *= maxStep / len;
        x -= t * gx; y -= t * gy; z -= t * gz;
        field(x, y, z);
        if (Math.abs(f - 1) < 0.02) { ok = true; break; }
      }
      if (!ok || tooClose(x, y, z)) continue;
      const gl = Math.hypot(gx, gy, gz), m = P.length / 3, k = key(tcell(x), tcell(y), tcell(z));
      P.push(x, y, z); N.push(-gx / gl, -gy / gl, -gz / gl); res.push(best);
      if (!kept.has(k)) kept.set(k, []);
      kept.get(k).push(m);
    }
  }
  return { n: res.length, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res) };
}
