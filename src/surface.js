// Molecular surface from Cα alone. It is the isosurface of a sum of Gaussians, one per residue, so a
// lone residue is a ball of radius SURF_R and neighbours merge smoothly: a residue-scale version of
// ChimeraX's surface (there are no side chains here to give finer detail). It's returned as points
// about `spacing` apart with outward normals and the residue each belongs to; the renderer draws
// them as glyphs (text) or as shaded discs (the solid surface).

export const SURF_SIGMA = 2.9, SURF_R = 3.4;

export function molSurface(ca, spacing) {
  const s2 = 2 * SURF_SIGMA * SURF_SIGMA, inv = 1 / (SURF_SIGMA * SURF_SIGMA), cut = 3 * SURF_SIGMA, cut2 = cut * cut;
  const iso = Math.exp(-SURF_R * SURF_R / s2);
  const key = (x, y, z) => (x * 2048 + y) * 2048 + z;

  // residues by grid cell, for the field
  const cellOf = v => Math.floor(v / cut) + 1024, grid = new Map();
  ca.forEach((p, i) => { const k = key(cellOf(p[0]), cellOf(p[1]), cellOf(p[2])); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });

  // field value f, gradient g and the residue contributing most, at (x, y, z)
  let f = 0, gx = 0, gy = 0, gz = 0, best = 0;
  const field = (x, y, z) => {
    f = gx = gy = gz = 0;
    let bw = -1;
    const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = grid.get(key(cx + a, cy + b, cz + c));
      if (!list) continue;
      for (const j of list) {
        const p = ca[j], dx = x - p[0], dy = y - p[1], dz = z - p[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cut2) continue;
        const e = Math.exp(-d2 / s2);
        f += e; gx -= dx * inv * e; gy -= dy * inv * e; gz -= dz * inv * e;
        if (e > bw) { bw = e; best = j; }
      }
    }
  };

  // kept points by grid cell, to thin them to roughly even spacing
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

  // seed points on a ball just outside each residue, push them onto the isosurface with a few
  // Newton steps along the gradient, drop the buried ones and anything crowding a point already kept.
  // Seeding outside the lone-residue radius keeps crevices covered, where seeds at that radius
  // would start deep inside the merged surface.
  const P = [], N = [], res = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const R0 = SURF_R + 1.2, K = Math.max(12, Math.round(4 * Math.PI * R0 * R0 / (spacing * spacing) * 1.1));
  for (let i = 0; i < ca.length; i++) {
    const c = ca[i], spin = i * 2.399963;
    for (let j = 0; j < K; j++) {
      const yv = 1 - 2 * (j + 0.5) / K, rr = Math.sqrt(1 - yv * yv), ph = j * golden + spin;
      let x = c[0] + R0 * rr * Math.cos(ph), y = c[1] + R0 * yv, z = c[2] + R0 * rr * Math.sin(ph);
      field(x, y, z);
      if (f > iso * 4) continue;                         // deep inside: other residues cover this spot
      let ok = false;
      for (let it = 0; it < 8; it++) {
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 < 1e-12) break;
        let t = (f - iso) / g2;
        const len = Math.abs(t) * Math.sqrt(g2);
        if (len > 1) t /= len;                           // at most 1 Å per step
        x -= t * gx; y -= t * gy; z -= t * gz;
        field(x, y, z);
        if (Math.abs(f - iso) < iso * 0.02) { ok = true; break; }
      }
      if (!ok || tooClose(x, y, z)) continue;
      const gl = Math.hypot(gx, gy, gz), n = P.length / 3, k = key(tcell(x), tcell(y), tcell(z));
      P.push(x, y, z); N.push(-gx / gl, -gy / gl, -gz / gl); res.push(best);
      if (!kept.has(k)) kept.set(k, []);
      kept.get(k).push(n);
    }
  }
  return { n: res.length, P: Float32Array.from(P), N: Float32Array.from(N), res: Uint32Array.from(res) };
}
