import { add, sub, mul, dot, cross, norm, dist } from "./vec.js";
import { assignSS } from "./ss.js";

// Builds the renderable chain: a Catmull-Rom spline through Cα with, per sample, a radius
// (for the text renderer) and ribbon frame/width/thickness (for the cartoon renderer).

export const pbin = v => v > 90 ? 0 : v > 70 ? 1 : v > 50 ? 2 : 3;   // AlphaFold pLDDT bands

// ---------- shape parameters (Å) ----------
export const SHAPE_DEFAULT = { hStyle: "ribbon", hW: 1.35, hT: 0.28, cylR: 2.3, sW: 1.15, sT: 0.14, flat: 0.6, arrows: true, head: 2.3, coilR: 0.48 };

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
  // extra smoothing so cylinders run straight, ends pinned
  for (let pass = 0; pass < 4; pass++) {
    const sm = ax.map((v, k) => k === 0 || k === ax.length - 1 ? v : mul(add(add(ax[k - 1], mul(v, 2)), ax[k + 1]), 0.25));
    for (let k = 0; k < ax.length; k++) ax[k] = sm[k];
  }
  return ax;
}

export function buildGeometry(parsed, shape = SHAPE_DEFAULT) {
  const rows = parsed.rows;
  if (rows.length < 5) throw new Error("Too few residues to draw");
  const N = rows.length, SH = { ...SHAPE_DEFAULT, ...shape }, cyl = SH.hStyle === "cylinder";
  let CA0 = rows.map(r => r.CA);
  const cen = CA0.reduce((a, p) => add(a, p), [0, 0, 0]).map(v => v / N);
  CA0 = CA0.map(p => sub(p, cen));
  const SS = parsed.ss || assignSS(CA0);
  const PB = rows.map(r => pbin(r.b || 0));
  const SUB = Math.max(3, Math.min(10, Math.round(2600 / N)));

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

  // helix axes: drawn on in cylinder mode, and always the core of the 3D text's helix tube
  const AX = new Array(N).fill(null);
  for (let i = 0; i < N;) {
    if (SS[i] !== "H") { i++; continue; }
    let j = i; while (j + 1 < N && SS[j + 1] === "H") j++;
    helixAxis(CA, i, j).forEach((p, k) => AX[i + k] = p);
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

  const rH = cyl ? SH.cylR : 2.1 * SH.hW / 1.35, rE = Math.max(1.0, SH.sW * 1.35);
  const radOf = ss => ss === "H" ? rH : ss === "E" ? rE : 0.95;
  // 3D text tube (tp, tr): helices become one solid cylinder around the axis instead of a
  // tube along the Cα spiral, which reads as a coiled spring once drawn in depth
  const rHT = cyl ? SH.cylR : 2.2 + 0.9 * SH.hW, tRad = ss => ss === "H" ? rHT : radOf(ss);
  const pts = [];
  for (let i = 0; i < N - 1; i++) {
    const p0 = CA[Math.max(0, i - 1)], p1 = CA[i], p2 = CA[i + 1], p3 = CA[Math.min(N - 1, i + 2)];
    const gap = dist(CA0[i], CA0[i + 1]) > 4.3;
    const inCyl = cyl && SS[i] === "H" && SS[i + 1] === "H";
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB, t2 = t * t, t3 = t2 * t;
      let pos;
      if (inCyl) pos = add(mul(AX[i], 1 - t), mul(AX[i + 1], t));
      else if (cyl && SS[i] === "H") pos = add(mul(AX[i], 1 - t), mul(p2, t));        // leave the cylinder end
      else if (cyl && SS[i + 1] === "H") pos = add(mul(p1, 1 - t), mul(AX[i + 1], t)); // enter the cylinder
      else {
        const c = k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
        pos = [c(0), c(1), c(2)];
      }
      const near = t < 0.5 ? i : i + 1, hi = SS[i] === "H", hj = SS[i + 1] === "H";
      let tp = pos;
      if (!cyl && hi && hj) tp = add(mul(AX[i], 1 - t), mul(AX[i + 1], t));
      else if (!cyl && hi) tp = add(mul(AX[i], 1 - t), mul(pos, t));      // leave the helix axis
      else if (!cyl && hj) tp = add(mul(pos, 1 - t), mul(AX[i + 1], t));  // join it
      pts.push({ p: pos, r: radOf(SS[i]) * (1 - t) + radOf(SS[i + 1]) * t, ss: SS[near], pk: PB[near],
                 tp, tr: tRad(SS[i]) * (1 - t) + tRad(SS[i + 1]) * t,
                 side: norm(add(mul(SIDE[i], 1 - t), mul(SIDE[i + 1], t))), res: i, t, gap, cyl: inCyl });
    }
  }
  const lastP = cyl && SS[N - 1] === "H" ? AX[N - 1] : CA[N - 1];
  pts.push({ p: lastP, r: radOf(SS[N - 1]), ss: SS[N - 1], pk: PB[N - 1], side: SIDE[N - 1], res: N - 1, t: 0, gap: false, cyl: cyl && SS[N - 1] === "H",
             tp: !cyl && SS[N - 1] === "H" ? AX[N - 1] : lastP, tr: tRad(SS[N - 1]) });

  for (let k = 0; k < pts.length; k++) {
    const q = pts[k];
    const a = pts[Math.max(0, k - 1)].p, b = pts[Math.min(pts.length - 1, k + 1)].p;
    const T = norm(sub(b, a));
    const S = norm(sub(q.side, mul(T, dot(q.side, T))));
    q.side = S; q.nrm = norm(cross(T, S));
    const i = q.res, t = q.t, own = SS[i], next = SS[Math.min(N - 1, i + 1)];
    let w = 0, th = 0;
    if (q.cyl) { q.kind = "Hc"; q.wIn = q.wOut = 0; continue; }
    if (own === "H" && !cyl) { w = next === "H" ? SH.hW : SH.hW * (1 - 0.7 * t); th = SH.hT; }
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

  const plddts = rows.map(r => r.b || 0);
  const hasPlddt = parsed.isAF || false;
  const meanP = plddts.reduce((a, b) => a + b, 0) / N;
  return { pts, R, hasPlddt, N, meanP, ssCounts: { H: SS.filter(s => s === "H").length, E: SS.filter(s => s === "E").length }, ssAuto: !parsed.ss };
}
