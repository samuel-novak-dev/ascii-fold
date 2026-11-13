import { add, sub, mul, dot, cross, norm, dist } from "./vec.js";
import { assignSS } from "./ss.js";
import { VDW, VDW_DEFAULT } from "./surface.js";

const BACKBONE = new Set(["N", "CA", "C", "O", "OXT"]);

// Builds the renderable chain: a Catmull-Rom spline through Cα with, per sample, a radius
// (for the text renderer) and ribbon frame/width/thickness (for the cartoon renderer).

export const pbin = v => v > 90 ? 0 : v > 70 ? 1 : v > 50 ? 2 : 3;   // AlphaFold pLDDT bands

// ---------- shape parameters (Å) ----------
// helices: a 2.2 Å wide, paper-thin oval ribbon; strands: flat 2 Å arrows
export const SHAPE_DEFAULT = { hW: 1.1, hT: 0.04, sW: 1.0, sT: 0.2, flat: 1.0, arrows: true, head: 2.3, coilR: 0.48 };

function helixAxis(CA, s, e) {
  // per-residue axis points for helix run s..e (4-residue weighted average cancels the 3.6-residue turn)
  const ax = new Array(e - s + 1).fill(null);
  for (let i = s + 2; i <= e - 2; i++)
    ax[i - s] = mul(add(add(add(mul(CA[i - 2], 0.5), CA[i - 1]), add(CA[i], CA[i + 1])), mul(CA[i + 2], 0.5)), 0.25);
  const def = ax.map((v, k) => v ? k : -1).filter(k => k >= 0);
  if (def.length < 2) {                      // short helix: straight line through the CAs
    const c = mul(CA.slice(s, e + 1).reduce((a, p) => add(a, p), [0, 0, 0]), 1 / (e - s + 1));
    const d = norm(sub(CA[e], CA[s]));
    return CA.slice(s, e + 1).map(p => add(c, mul(d, dot(sub(p, c), d))));
  }
  const f = def[0], l = def[def.length - 1];
  const stepF = sub(ax[f], ax[f + 1]), stepL = sub(ax[l], ax[l - 1]);
  for (let k = f - 1; k >= 0; k--) ax[k] = add(ax[k + 1], stepF);
  for (let k = l + 1; k < ax.length; k++) ax[k] = add(ax[k - 1], stepL);
  // extra smoothing so the axis runs smoothly, ends pinned
  for (let pass = 0; pass < 4; pass++) {
    const sm = ax.map((v, k) => k === 0 || k === ax.length - 1 ? v : mul(add(add(ax[k - 1], mul(v, 2)), ax[k + 1]), 0.25));
    for (let k = 0; k < ax.length; k++) ax[k] = sm[k];
  }
  return ax;
}

export function buildGeometry(parsed, shape = SHAPE_DEFAULT) {
  const rows = parsed.rows;
  if (rows.length < 5) throw new Error("Too few residues to draw");
  const N = rows.length, SH = { ...SHAPE_DEFAULT, ...shape };
  let CA0 = rows.map(r => r.CA);
  const cen = CA0.reduce((a, p) => add(a, p), [0, 0, 0]).map(v => v / N);
  CA0 = CA0.map(p => sub(p, cen));
  const SS = parsed.ss || assignSS(CA0);
  const PB = rows.map(r => pbin(r.b || 0));
  // spline samples per residue: a helix turns ~100° per residue, so fewer than ~6 shows as corners
  const SUB = Math.max(6, Math.min(12, Math.round(4000 / N)));

  // flatten strands: smooth the pleated Cα zig-zag inside β runs
  let CA = CA0.map(p => p.slice());
  for (let pass = 0; pass < 3 && SH.flat > 0; pass++) {
    const nx = CA.map((p, i) => {
      if (SS[i] !== "E" || i === 0 || i === N - 1) return p;
      const avg = mul(add(add(CA[i - 1], mul(p, 2)), CA[i + 1]), 0.25);
      return add(mul(p, 1 - SH.flat), mul(avg, SH.flat));
    });
    CA = nx;
  }

  // helix axes: what the ideal helices wind around, and what keeps a ribbon's width parallel to its axis
  const AX = new Array(N).fill(null), AD = new Array(N).fill(null);
  for (let i = 0; i < N;) {
    if (SS[i] !== "H") { i++; continue; }
    let j = i; while (j + 1 < N && SS[j + 1] === "H") j++;
    helixAxis(CA, i, j).forEach((p, k) => AX[i + k] = p);
    for (let k = i; k <= j; k++) AD[k] = norm(sub(AX[Math.min(j, k + 1)], AX[Math.max(i, k - 1)]));
    i = j + 1;
  }

  // Idealised helices. A real helix's Cα trace is irregular enough that a ribbon drawn through it
  // shows kinks and odd angles. Each helix of 4+ residues is redrawn as an ideal one: it follows the
  // fitted (possibly curved) axis at constant radius and constant twist per residue, with its phase
  // and twist least-squares fitted to the real Cα, so it stays as close to them as a regular helix
  // on that axis can. Over the last residue and a half at each end it eases back onto the path
  // through the real Cα, so loops join exactly as before. Smoother than the data, on purpose;
  // helixRMSD says by how much.
  const HF = new Array(N).fill(null), helixRMSD = [];
  for (let i = 0; i < N;) {
    if (SS[i] !== "H") { i++; continue; }
    let j = i; while (j + 1 < N && SS[j + 1] === "H") j++;
    if (j - i >= 3) {
      const U = [], V = [];   // a frame carried along the axis with as little twist as possible
      let u = sub(CA[i], AX[i]);
      for (let k = i; k <= j; k++) { u = norm(sub(u, mul(AD[k], dot(u, AD[k])))); U[k] = u; V[k] = cross(AD[k], u); }
      const th = [], n = j - i + 1;
      let rs = 0;
      for (let k = i; k <= j; k++) {   // each Cα's angle and distance around the axis, angles unwrapped
        const d = sub(CA[k], AX[k]), x = dot(d, U[k]), y = dot(d, V[k]);
        let a = Math.atan2(y, x);
        if (th.length) { const p = th[th.length - 1]; a += 2 * Math.PI * Math.round((p - a) / (2 * Math.PI)); }
        th.push(a); rs += Math.hypot(x, y);
      }
      const r = Math.max(1.9, Math.min(2.7, rs / n)), km = (n - 1) / 2, tm = th.reduce((s, a) => s + a, 0) / n;
      let sxy = 0, sxx = 0;
      th.forEach((a, k) => { sxy += (k - km) * (a - tm); sxx += (k - km) * (k - km); });
      const b = sxy / sxx, h = { i, j, U, V, r, a0: tm - b * km, b };   // angle(k) = a0 + b·(k − i)
      let se = 0;
      for (let k = i; k <= j; k++) {
        const ang = h.a0 + b * (k - i), ideal = add(AX[k], add(mul(U[k], r * Math.cos(ang)), mul(V[k], r * Math.sin(ang))));
        const d = dist(ideal, CA[k]); se += d * d;
        HF[k] = h;
      }
      helixRMSD.push({ from: i, to: j, rmsd: Math.sqrt(se / n) });
    }
    i = j + 1;
  }

  // side vectors from carbonyl O (fallback: curvature), sign-consistent, then smoothed
  const SIDE = [];
  for (let i = 0; i < N; i++) {
    let sv;
    if (rows[i].O) sv = norm(sub(rows[i].O, rows[i].CA));
    else { const a = CA[Math.max(0, i - 1)], b = CA[Math.min(N - 1, i + 1)]; sv = norm(sub(add(a, b), mul(CA[i], 2))); }
    if (i > 0 && dot(sv, SIDE[i - 1]) < 0) sv = mul(sv, -1);
    SIDE.push(sv);
  }
  const extraE = Math.round(SH.flat * 6);
  for (let pass = 0; pass < 2 + extraE; pass++) {
    const sm = SIDE.map((v, i) => (i === 0 || i === N - 1 || SS[i] === "C" || (pass >= 2 && SS[i] !== "E")) ? v
      : norm(add(add(mul(SIDE[i - 1], 0.25), mul(v, 0.5)), mul(SIDE[i + 1], 0.25))));
    for (let i = 0; i < N; i++) SIDE[i] = sm[i];
  }
  // Helix ribbons, as in ChimeraX: width along the helix axis, so the band wraps round the helix
  // like a spiral staircase and every turn is the same. (Carbonyl directions wobble residue to residue, which
  // twisted the band at odd angles.)
  for (let i = 0; i < N; i++) if (AD[i] && Math.hypot(...AD[i]) > 0.5) SIDE[i] = AD[i];

  const rH = 2.1 * SH.hW, rE = Math.max(1.0, SH.sW * 1.35);
  const radOf = ss => ss === "H" ? rH : ss === "E" ? rE : 0.95;
  const catmull = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return [0, 1, 2].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  const pts = [];
  for (let i = 0; i < N - 1; i++) {
    const p0 = CA[Math.max(0, i - 1)], p1 = CA[i], p2 = CA[i + 1], p3 = CA[Math.min(N - 1, i + 2)];
    const gap = dist(CA0[i], CA0[i + 1]) > 4.3;
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB, hf = HF[i];
      let pos;
      if (hf && HF[i + 1] === hf) {   // the ideal helix (an exact spiral round the smooth axis), eased in at the ends
        const ax = catmull(AX[Math.max(hf.i, i - 1)], AX[i], AX[i + 1], AX[Math.min(hf.j, i + 2)], t);
        const T = norm(add(mul(AD[i], 1 - t), mul(AD[i + 1], t)));
        let u = add(mul(hf.U[i], 1 - t), mul(hf.U[i + 1], t)); u = norm(sub(u, mul(T, dot(u, T)))); const v = cross(T, u);
        const ang = hf.a0 + hf.b * (i - hf.i + t);
        const ideal = add(ax, add(mul(u, hf.r * Math.cos(ang)), mul(v, hf.r * Math.sin(ang)))), real = catmull(p0, p1, p2, p3, t);
        const e = Math.min(i + t - hf.i, hf.j - i - t) / 1.5, w = e >= 1 ? 1 : e * e * (3 - 2 * e);   // smoothstep from each end
        pos = add(real, mul(sub(ideal, real), w));
      } else pos = catmull(p0, p1, p2, p3, t);
      const near = t < 0.5 ? i : i + 1;
      pts.push({ p: pos, r: radOf(SS[i]) * (1 - t) + radOf(SS[i + 1]) * t, ss: SS[near], pk: PB[near],
                 side: norm(add(mul(SIDE[i], 1 - t), mul(SIDE[i + 1], t))), res: i, t, gap });
    }
  }
  pts.push({ p: CA[N - 1], r: radOf(SS[N - 1]), ss: SS[N - 1], pk: PB[N - 1], side: SIDE[N - 1], res: N - 1, t: 0, gap: false });

  for (let k = 0; k < pts.length; k++) {
    const q = pts[k];
    const a = pts[Math.max(0, k - 1)].p, b = pts[Math.min(pts.length - 1, k + 1)].p;
    const T = norm(sub(b, a));
    const S = norm(sub(q.side, mul(T, dot(q.side, T))));
    q.side = S; q.nrm = norm(cross(T, S));
    const i = q.res, t = q.t, own = SS[i], next = SS[Math.min(N - 1, i + 1)], prev = SS[Math.max(0, i - 1)];
    // a helix ribbon's normal points out from the axis, toward the side chains, so the renderer
    // can tell the outside of a turn (facing the viewer) from the inside (seen through the gaps)
    if (own === "H" && AX[i]) {
      const ax = AX[i + 1] && SS[i + 1] === "H" ? add(mul(AX[i], 1 - t), mul(AX[i + 1], t)) : AX[i];
      if (dot(q.nrm, sub(q.p, ax)) < 0) q.nrm = mul(q.nrm, -1);
    }
    let w = 0, th = 0;
    if (own === "H") {   // full width inside the helix, tapering over its first and last residue
      w = SH.hW * (next === "H" ? 1 : 1 - 0.7 * t) * (prev === "H" || i === 0 ? 1 : 0.3 + 0.7 * t);
      th = SH.hT;
    }
    else if (own === "E") {
      th = SH.sT;
      if (next === "E") w = SH.sW;
      else if (SH.arrows) w = SH.head * (1 - t) + 0.04;                  // arrow head over the last residue
      else w = SH.sW * (1 - 0.35 * t);
    }
    q.kind = w > 0 ? own : "C"; q.th = th;
    q.wIn = q.wOut = w;
    if (own === "E" && next !== "E" && t === 0 && SH.arrows) { q.wIn = SH.sW; q.wOut = SH.head; }
  }

  // fit radius: robust to long disordered tails
  const radii = pts.map(q => Math.hypot(...q.p)).sort((a, b) => a - b);
  const rMax = radii[radii.length - 1], r95 = radii[Math.floor(radii.length * 0.95)];
  const R = Math.min(rMax, r95 * 1.12) + 2.2;

  // every heavy atom, centred like the Cα, at its van der Waals radius (for the side-chain surface).
  // Files with only Cα (and O) have no side chains, and the surface falls back to one ball per residue.
  const nAt = rows.reduce((s, r) => s + (r.atoms ? r.atoms.length : 0), 0);
  const AP = new Float32Array(nAt * 3), AR = new Float32Array(nAt), ARes = new Uint32Array(nAt), AN = new Array(nAt), AE = new Array(nAt);
  let ai = 0, withSide = 0;
  rows.forEach((r, i) => {
    let side = false;
    for (const a of r.atoms || []) {
      AP[ai * 3] = a.p[0] - cen[0]; AP[ai * 3 + 1] = a.p[1] - cen[1]; AP[ai * 3 + 2] = a.p[2] - cen[2];
      AR[ai] = VDW[a.e] || VDW_DEFAULT; ARes[ai] = i; AN[ai] = a.n; AE[ai] = a.e; ai++;
      if (!BACKBONE.has(a.n)) side = true;
    }
    if (side) withSide++;
  });
  const atoms = { n: nAt, P: AP, R: AR, res: ARes, name: AN, el: AE, sideChains: withSide > N * 0.5 };
  // where each residue sits on the cartoon (the spline point at its Cα): side chains hang from here
  const anchor = new Array(N);
  for (const q of pts) if (q.t === 0) anchor[q.res] = q.p;

  // ligands and ions, centred like the chain
  const ligands = (parsed.ligands || []).map(l => ({ name: l.name, num: l.num, chain: l.chain, ion: l.atoms.length === 1,
    P: l.atoms.map(a => sub(a.p, cen)), el: l.atoms.map(a => a.e), names: l.atoms.map(a => a.n) }));

  const plddts = rows.map(r => r.b || 0);
  // colour by B-factor ("pLDDT") whenever the file has varying B-factors; hasPlddt only labels them
  const hasPlddt = !!parsed.hasPlddt, hasB = !!parsed.bFactors || hasPlddt;
  const meanP = plddts.reduce((a, b) => a + b, 0) / N;
  return { pts, R, hasPlddt, hasB, fromAFDB: !!parsed.fromAFDB, N, meanP, ca: CA0, helixRMSD, ssRes: SS, pkRes: PB, atoms, anchor, ligands, resName: rows.map(r => r.name || "UNK"), resNum: rows.map(r => r.num), ssCounts: { H: SS.filter(s => s === "H").length, E: SS.filter(s => s === "E").length }, ssAuto: !parsed.ss };
}
