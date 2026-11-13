// Molecular surface as a triangle mesh, the way ChimeraX draws one: smooth vertex normals for
// per-pixel lighting, ambient occlusion for Gentle lighting, and evenly spaced points on it for
// the 3D text.
//
// The surface is a "blobby" isosurface: every centre i adds exp(−B·(d²/rᵢ² − 1)) to a field and
// the surface is where the field is 1. A lone centre is a sphere of radius rᵢ; neighbours merge
// smoothly, filling crevices much as ChimeraX's 1.4 Å solvent probe does (lower B, smoother).
//   atoms  every heavy atom at its van der Waals radius (Bondi), when the file has side chains
//   Cα     one soft ball per residue otherwise
// The field is sampled on a grid and triangulated with surface nets (one vertex per grid cell the
// surface crosses, joined into quads), which gives a smooth, well-shaped mesh without big tables.

export const VDW = { C: 1.7, N: 1.55, O: 1.52, S: 1.8, SE: 1.9, P: 1.8 };   // Bondi radii, Å
export const VDW_DEFAULT = 1.7;
export const RES_BALL = 3.4;
const ATOM_BLOB = 1.6, RES_BLOB = 0.69;
const MAX_VOXELS = 3.5e6, MIN_SPACING = 0.55;   // grid: as fine as 0.55 Å, coarser for big proteins

/** The surface of a geometry (from buildGeometry) as { nv, P, N, res, nt, T, grid }. */
export function surfaceMesh(G) {
  const A = G.atoms;
  if (A && A.sideChains) return blobMesh(A.P, A.R, A.res, ATOM_BLOB);
  return blobMesh(Float32Array.from(G.ca.flat()), new Float32Array(G.ca.length).fill(RES_BALL), Uint32Array.from(G.ca, (_, i) => i), RES_BLOB);
}

function blobMesh(C, R, owner, B) {
  const n = R.length, cutF = Math.sqrt(1 + 4.6 / B);   // beyond rᵢ·cutF a centre adds < 1%
  let rMax = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    rMax = Math.max(rMax, R[i]);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], C[i * 3 + a]); hi[a] = Math.max(hi[a], C[i * 3 + a]); }
  }
  const pad = rMax * cutF + 1;
  for (let a = 0; a < 3; a++) { lo[a] -= pad; hi[a] += pad; }
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  const h = Math.max(MIN_SPACING, Math.cbrt(vol / MAX_VOXELS));
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const [ox, oy, oz] = lo, F = new Float32Array(nx * ny * nz);

  // splat every centre into the grid
  for (let i = 0; i < n; i++) {
    const cx = C[i * 3], cy = C[i * 3 + 1], cz = C[i * 3 + 2], r2 = R[i] * R[i], rc = R[i] * cutF, rc2 = rc * rc;
    const x0 = Math.max(0, Math.ceil((cx - rc - ox) / h)), x1 = Math.min(nx - 1, Math.floor((cx + rc - ox) / h));
    const y0 = Math.max(0, Math.ceil((cy - rc - oy) / h)), y1 = Math.min(ny - 1, Math.floor((cy + rc - oy) / h));
    const z0 = Math.max(0, Math.ceil((cz - rc - oz) / h)), z1 = Math.min(nz - 1, Math.floor((cz + rc - oz) / h));
    for (let z = z0; z <= z1; z++) {
      const dz = oz + z * h - cz, dz2 = dz * dz;
      for (let y = y0; y <= y1; y++) {
        const dy = oy + y * h - cy, dyz = dy * dy + dz2;
        if (dyz > rc2) continue;
        const row = nx * (y + ny * z);
        for (let x = x0; x <= x1; x++) {
          const dx = ox + x * h - cx, d2 = dx * dx + dyz;
          if (d2 < rc2) F[row + x] += Math.exp(-B * (d2 / r2 - 1));
        }
      }
    }
  }

  // surface nets: a vertex in every cell whose corners straddle the surface, at the mean of the
  // edge crossings; then a quad across every grid edge that crosses, joining its 4 cells
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const OFF = CORNER.map(([a, b, c]) => a + nx * (b + ny * c));
  const cellV = new Int32Array(nx * ny * nz).fill(-1), P = [], T = [], g = new Float32Array(8);
  const du = [1, nx, nx * ny];   // cell index step along x, y, z
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const c = x + nx * (y + ny * z);
    let mask = 0;
    for (let k = 0; k < 8; k++) { g[k] = F[c + OFF[k]] - 1; if (g[k] > 0) mask |= 1 << k; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of EDGES) {
      if ((g[a] > 0) === (g[b] > 0)) continue;
      const t = g[a] / (g[a] - g[b]), A = CORNER[a], Bc = CORNER[b];
      sx += A[0] + t * (Bc[0] - A[0]); sy += A[1] + t * (Bc[1] - A[1]); sz += A[2] + t * (Bc[2] - A[2]); cnt++;
    }
    cellV[c] = P.length / 3;
    P.push(ox + (x + sx / cnt) * h, oy + (y + sy / cnt) * h, oz + (z + sz / cnt) * h);
    // the three grid edges leaving corner 0 of this cell; each needs the cells behind it to exist
    const pos = [x, y, z];
    for (let i = 0; i < 3; i++) {
      if (!(mask & 1) === !(mask & (1 << (1 << i)))) continue;   // corner 1 << i is one step along axis i
      const iu = (i + 1) % 3, iv = (i + 2) % 3;
      if (pos[iu] === 0 || pos[iv] === 0) continue;
      const a = cellV[c], b = cellV[c - du[iu]], d = cellV[c - du[iv]], e = cellV[c - du[iu] - du[iv]];
      if (a < 0 || b < 0 || d < 0 || e < 0) continue;
      if (mask & 1) T.push(a, b, e, a, e, d); else T.push(a, e, b, a, d, e);
    }
  }

  // smooth normals and the residue each vertex belongs to, from the centres themselves
  const nv = P.length / 3, N = new Float32Array(nv * 3), res = new Uint32Array(nv), Pf = Float32Array.from(P);
  const cell = rMax * cutF, cellOf = v => Math.floor(v / cell) + 1024, key = (a, b, c) => (a * 2048 + b) * 2048 + c, grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(cellOf(C[i * 3]), cellOf(C[i * 3 + 1]), cellOf(C[i * 3 + 2]));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  for (let v = 0; v < nv; v++) {
    const x = Pf[v * 3], y = Pf[v * 3 + 1], z = Pf[v * 3 + 2], cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
    let gx = 0, gy = 0, gz = 0, bw = -1, best = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = grid.get(key(cx + a, cy + b, cz + c));
      if (!list) continue;
      for (const j of list) {
        const dx = x - C[j * 3], dy = y - C[j * 3 + 1], dz = z - C[j * 3 + 2], d2 = dx * dx + dy * dy + dz * dz, r2 = R[j] * R[j];
        if (d2 > r2 * cutF * cutF) continue;
        const e = Math.exp(-B * (d2 / r2 - 1)), k = 2 * B / r2 * e;   // −∇ of this term, i.e. outward
        gx += dx * k; gy += dy * k; gz += dz * k;
        if (e > bw) { bw = e; best = owner[j]; }
      }
    }
    const l = Math.hypot(gx, gy, gz) || 1;
    N[v * 3] = gx / l; N[v * 3 + 1] = gy / l; N[v * 3 + 2] = gz / l; res[v] = best;
  }
  return { nv, P: Pf, N, res, nt: T.length / 3, T: Uint32Array.from(T), grid: { F, nx, ny, nz, h, ox, oy, oz } };
}

/** Ambient occlusion per vertex, like ChimeraX's multishadow: the cosine-weighted share of
 *  directions over the vertex's hemisphere along which no part of the protein lies within ~11 Å. */
export function meshAO(mesh) {
  if (mesh.ao) return mesh.ao;
  const { F, nx, ny, nz, h, ox, oy, oz } = mesh.grid, P = mesh.P, N = mesh.N, nv = mesh.nv;
  const K = 40, dirs = [], golden = Math.PI * (3 - Math.sqrt(5)), STEPS = 9, STEP = 1.25, LIFT = 0.7;
  for (let j = 0; j < K; j++) {
    const y = 1 - 2 * (j + 0.5) / K, r = Math.sqrt(1 - y * y), ph = j * golden;
    dirs.push([r * Math.cos(ph), y, r * Math.sin(ph)]);
  }
  const inside = (x, y, z) => {
    const i = Math.round((x - ox) / h), j = Math.round((y - oy) / h), k = Math.round((z - oz) / h);
    return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && F[i + nx * (j + ny * k)] > 1;
  };
  const ao = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const n0 = N[v * 3], n1 = N[v * 3 + 1], n2 = N[v * 3 + 2];
    const px = P[v * 3] + n0 * LIFT, py = P[v * 3 + 1] + n1 * LIFT, pz = P[v * 3 + 2] + n2 * LIFT;
    let open = 0, all = 0;
    for (const d of dirs) {
      const w = d[0] * n0 + d[1] * n1 + d[2] * n2;
      if (w <= 0.05) continue;
      let hit = false;
      for (let s = 1; s <= STEPS && !hit; s++) hit = inside(px + d[0] * s * STEP, py + d[1] * s * STEP, pz + d[2] * s * STEP);
      all += w; if (!hit) open += w;
    }
    ao[v] = all ? open / all : 1;
  }
  return mesh.ao = ao;
}

/** Points about `spacing` apart on the mesh (for the 3D text), with normals, residues and the
 *  mesh vertex each came from. */
export function meshPoints(mesh, spacing) {
  const tc = spacing * 0.8, tc2 = tc * tc, cellOf = v => Math.floor(v / tc) + 1024, key = (a, b, c) => (a * 2048 + b) * 2048 + c;
  const kept = new Map(), P = mesh.P, N = mesh.N, outP = [], outN = [], res = [], vix = [];
  for (let v = 0; v < mesh.nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
    let close = false;
    for (let a = -1; a <= 1 && !close; a++) for (let b = -1; b <= 1 && !close; b++) for (let c = -1; c <= 1 && !close; c++) {
      const list = kept.get(key(cx + a, cy + b, cz + c));
      if (!list) continue;
      for (const j of list) {
        const dx = x - outP[j * 3], dy = y - outP[j * 3 + 1], dz = z - outP[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < tc2) { close = true; break; }
      }
    }
    if (close) continue;
    const k = key(cx, cy, cz);
    if (!kept.has(k)) kept.set(k, []);
    kept.get(k).push(vix.length);
    outP.push(x, y, z); outN.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); res.push(mesh.res[v]); vix.push(v);
  }
  return { n: vix.length, P: Float32Array.from(outP), N: Float32Array.from(outN), res: Uint32Array.from(res), vix: Uint32Array.from(vix) };
}
