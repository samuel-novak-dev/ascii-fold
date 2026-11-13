import { dist } from "./vec.js";

// Secondary structure from Cα coordinates alone (P-SEA-like distance criteria), for files
// without HELIX/SHEET records — e.g. AlphaFold DB models. Good enough for drawing:
// ~80–86% per-residue agreement with deposited assignments on the structures we checked.
// chain (optional): each residue's chain id; no window or run crosses from one chain to the next.
export function assignSS(P, chain = null) {
  const n = P.length, ss = new Array(n).fill("C");
  const d = (i, j) => dist(P[i], P[j]);
  const same = (i, j) => !chain || chain[i] === chain[j];   // i..j in one chain (chains are contiguous)

  // helix: two consecutive i→i+2/3/4 windows with α-helical spacing
  const hw = i => i + 4 < n && same(i, i + 4) && Math.abs(d(i, i + 2) - 5.45) < 0.6 && Math.abs(d(i, i + 3) - 5.2) < 0.7 && Math.abs(d(i, i + 4) - 6.2) < 0.8;
  for (let i = 0; i + 5 < n; i++)
    if (hw(i) && hw(i + 1)) for (let k = i; k <= i + 5; k++) ss[k] = "H";

  // strand: extended backbone that pairs with another extended segment as a ladder
  const ext = new Array(n).fill(false);
  for (let i = 0; i + 2 < n; i++)
    if (same(i, i + 2) && d(i, i + 2) > 6.1 && (i + 3 >= n || !same(i, i + 3) || d(i, i + 3) > 8.4)) ext[i] = ext[i + 1] = ext[i + 2] = true;
  const cell = 5.5, grid = new Map(), keyOf = p => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  P.forEach((p, i) => { const k = keyOf(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const ok = (a, b) => a >= 0 && b >= 0 && a < n && b < n && Math.abs(a - b) > 2 && d(a, b) < 5.5;   // a ladder may pair two chains
  for (let i = 0; i < n; i++) {
    if (!ext[i] || ss[i] === "H") continue;
    const g = [0, 1, 2].map(a => Math.floor(P[i][a] / cell));
    let paired = false;
    for (let ax = -1; ax <= 1 && !paired; ax++) for (let ay = -1; ay <= 1 && !paired; ay++) for (let az = -1; az <= 1 && !paired; az++) {
      for (const j of grid.get(`${g[0] + ax},${g[1] + ay},${g[2] + az}`) || []) {
        if (Math.abs(i - j) < 3 || !ext[j] || ss[j] === "H" || d(i, j) > 5.5) continue;
        if (ok(i + 1, j + 1) || ok(i - 1, j - 1) || ok(i + 1, j - 1) || ok(i - 1, j + 1)) { paired = true; break; }
      }
    }
    if (paired) ss[i] = "E";
  }

  // tidy: bridge single-residue gaps in strands, drop fragments
  for (let i = 1; i < n - 1; i++) if (ss[i] === "C" && ss[i - 1] === "E" && ss[i + 1] === "E" && ext[i] && same(i - 1, i + 1)) ss[i] = "E";
  const clean = (type, min) => {
    for (let i = 0; i < n;) {
      if (ss[i] !== type) { i++; continue; }
      let j = i; while (j < n && ss[j] === type && same(i, j)) j++;
      if (j - i < min) for (let k = i; k < j; k++) ss[k] = "C";
      i = j;
    }
  };
  clean("H", 4); clean("E", 3);
  return ss;
}
