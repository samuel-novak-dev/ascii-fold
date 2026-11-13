// Minimal PDB / mmCIF readers. Only what the renderer needs, from the first chain of the first
// model: every heavy atom (for the van der Waals surface), Cα and carbonyl O by name (for the
// cartoon), the residue name, B-factor (pLDDT for predicted models), and HELIX/SHEET records when
// a PDB file has them. A HETATM residue with a backbone (N, Cα, C: selenomethionine,
// phosphothreonine …) counts as a residue of the chain. Other HETATM groups are ligands (see
// ligandsNear): from any chain, as long as they sit against this one, so a ligand that AlphaFold 3
// or Boltz puts on a chain of its own still comes along. Water never does.
//
// Returns { rows: [{ num, name, CA, O, b, atoms: [{ n, e, p, b }] }], chain, ss: string[] | null,
//           ligands: [{ name, num, chain, atoms: [{ n, e, p }] }], bFactors, hasPlddt, fromAFDB, title }
//   bFactors  the B-factor column has varying values, so there's something to colour by
//   hasPlddt  it looks like per-residue confidence (pLDDT, 0–100), see confidence()
//   fromAFDB  the file comes from AlphaFold DB (for its CC BY 4.0 credit)

const WATER = new Set(["HOH", "WAT", "DOD", "H2O", "SOL"]);
// not worth drawing in a picture: cryoprotectants, precipitants and buffers from the crystal, and
// the ACE / NH2 caps on a chain's ends
const ADDITIVE = new Set(["GOL", "EDO", "PEG", "PGE", "PG4", "1PE", "P6G", "MPD", "DMS", "ACT", "FMT", "EOH", "IPA", "TRS",
  "MES", "EPE", "BME", "ACE", "NH2"]);
const elementOf = (el, name) => (el || name.replace(/[^A-Za-z]/g, "").slice(0, 1)).toUpperCase();

function addAtom(res, order, key, num, comp, name, el, p, b, het = false, chain = null) {
  let r = res.get(key);
  if (!r) { r = { num, name: comp, atoms: [], het, chain }; res.set(key, r); order.push(key); }
  r.atoms.push({ n: name, e: el, p, b });
  if (name === "CA" || name === "O") r[name] = p;
  if (name === "CA") r.b = b;
}
const hasAtom = (r, n) => r.atoms.some(a => a.n === n);
const isResidue = r => !!r.CA && (!r.het || (hasAtom(r, "N") && hasAtom(r, "C")));

// The chain's residues and its ligands: every HETATM group that isn't a residue, water or an
// additive and has an atom within REACH Å of the chain (found through a grid of the chain's atoms).
const REACH = 5;
function split(res, order, others, chain) {
  const all = order.map(k => res.get(k)), rows = all.filter(isResidue), grid = new Map();
  const cell = (x, y, z) => `${Math.floor(x / REACH)},${Math.floor(y / REACH)},${Math.floor(z / REACH)}`;
  for (const r of rows) for (const a of r.atoms) {
    const k = cell(...a.p); let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(a.p);
  }
  const near = p => {
    const [i, j, k] = p.map(v => Math.floor(v / REACH));
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++)
      for (const q of grid.get(`${i + di},${j + dj},${k + dk}`) || [])
        if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < REACH * REACH) return true;
    return false;
  };
  const ligands = [...all.filter(r => r.het && !isResidue(r)), ...others.values()]
    .filter(r => !isResidue(r) && !ADDITIVE.has(r.name) && r.atoms.some(a => near(a.p)))
    .map(r => ({ name: r.name, num: r.num, chain: r.chain ?? chain, atoms: r.atoms.map(({ n, e, p }) => ({ n, e, p })) }));
  return { rows, ligands };
}

export function parsePDB(text) {
  const res = new Map(), order = [], others = new Map(), helix = [], sheet = [];
  let chain = null, title = null;
  for (const l of text.split(/\r?\n/)) {
    const rec = l.slice(0, 6);
    if (rec === "ENDMDL") break;
    if (rec === "TITLE " && !title) title = l.slice(10).trim();
    if (rec === "HELIX ") { helix.push([l[19], parseInt(l.slice(21, 25)), parseInt(l.slice(33, 37))]); continue; }
    if (rec === "SHEET ") { sheet.push([l[21], parseInt(l.slice(22, 26)), parseInt(l.slice(33, 37))]); continue; }
    const comp = l.slice(17, 20).trim(), het = rec === "HETATM";
    if (rec !== "ATOM  " && !het || het && WATER.has(comp)) continue;
    const alt = l[16]; if (alt !== " " && alt !== "A") continue;
    const ch = l[21]; if (chain === null && (!het || comp === "MSE")) chain = ch;
    const name = l.slice(12, 16).trim(), el = elementOf(l.slice(76, 78).trim(), name);
    if (el === "H" || el === "D") continue;
    const id = l.slice(22, 27), num = parseInt(l.slice(22, 26));
    const p = [parseFloat(l.slice(30, 38)), parseFloat(l.slice(38, 46)), parseFloat(l.slice(46, 54))], b = parseFloat(l.slice(60, 66));
    if (ch === chain) addAtom(res, order, het ? id + comp : id, num, comp, name, el, p, b, het);
    else if (het) addAtom(others, [], ch + id + comp, num, comp, name, el, p, b, true, ch);
  }
  const { rows, ligands } = split(res, order, others, chain);
  let ss = null;
  const m = new Map();
  for (const [c, a, b] of helix) if (c === chain) for (let i = a; i <= b; i++) m.set(i, "H");
  for (const [c, a, b] of sheet) if (c === chain) for (let i = a; i <= b; i++) m.set(i, "E");
  if (m.size) ss = rows.map(r => m.get(r.num) || "C");
  return confidence({ rows, ligands, chain, ss, title, fromAFDB: /^TITLE {5}ALPHAFOLD/m.test(text.slice(0, 5000)) }, text);
}

function cifTokens(line) {
  const out = [], re = /'((?:[^']|'(?!\s|$))*)'(?=\s|$)|"((?:[^"]|"(?!\s|$))*)"(?=\s|$)|(\S+)/g;
  let m; while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseCIF(text) {
  const lines = text.split(/\r?\n/);
  let i = lines.findIndex(l => l.startsWith("_atom_site."));
  if (i < 0) throw new Error("No _atom_site block in this mmCIF file");
  const cols = [];
  while (i < lines.length && lines[i].startsWith("_atom_site.")) { cols.push(lines[i].trim().slice(11)); i++; }
  const c = n => cols.indexOf(n);
  const pick = (a, b) => c(a) >= 0 ? c(a) : c(b);
  const ix = { g: c("group_PDB"), atom: c("label_atom_id"), alt: c("label_alt_id"), chain: pick("auth_asym_id", "label_asym_id"),
               seq: pick("auth_seq_id", "label_seq_id"), ins: c("pdbx_PDB_ins_code"), x: c("Cartn_x"), y: c("Cartn_y"), z: c("Cartn_z"),
               b: c("B_iso_or_equiv"), model: c("pdbx_PDB_model_num"), comp: pick("auth_comp_id", "label_comp_id"), el: c("type_symbol") };
  const res = new Map(), order = [], others = new Map();
  let chain = null, model = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l[0] === "#" || l[0] === "_" || l.startsWith("loop_")) break;
    const t = cifTokens(l); if (t.length < cols.length) continue;
    const comp = ix.comp >= 0 ? t[ix.comp] : "UNK", het = ix.g >= 0 && t[ix.g] === "HETATM";
    if (ix.g >= 0 && t[ix.g] !== "ATOM" && !het || het && WATER.has(comp)) continue;
    if (ix.model >= 0) { if (model === null) model = t[ix.model]; else if (t[ix.model] !== model) break; }
    if (ix.alt >= 0 && !".?A".includes(t[ix.alt])) continue;
    const ch = t[ix.chain]; if (chain === null && (!het || comp === "MSE")) chain = ch;
    const name = t[ix.atom], el = elementOf(ix.el >= 0 ? t[ix.el] : "", name);
    if (el === "H" || el === "D") continue;
    const id = t[ix.seq] + (ix.ins >= 0 ? t[ix.ins] : ""), num = parseInt(t[ix.seq]);
    const p = [parseFloat(t[ix.x]), parseFloat(t[ix.y]), parseFloat(t[ix.z])], b = ix.b >= 0 ? parseFloat(t[ix.b]) : 0;
    if (ch === chain) addAtom(res, order, het ? id + "|" + comp : id, num, comp, name, el, p, b, het);
    else if (het) addAtom(others, [], ch + "|" + id + "|" + comp, num, comp, name, el, p, b, true, ch);
  }
  const { rows, ligands } = split(res, order, others, chain);
  return confidence({ rows, ligands, chain, ss: null, title: null,
                      fromAFDB: /AlphaFoldDB|^data_AF-/m.test(text.slice(0, 30000)) }, text);
}

// The B-factor column. Colouring by it (the "pLDDT" colour) only needs values that vary; values
// on a 0–1 scale (ESMFold and others) are rescaled to 0–100. Whether they *are* pLDDT, for the
// "mean pLDDT" label, is a guess: yes if the file says so (ModelCIF's _ma_qa_metric, or "pLDDT"),
// if they were on a 0–1 scale, or, unless the file declares an experimental method, if a
// predictor is named or every residue carries one value on all its atoms.
const STRONG = /_ma_qa_metric|plddt/i;
const PREDICTOR = /alphafold|colabfold|esmfold|openfold|boltz|chai-?1|rosettafold|protenix|helixfold|omegafold/i;
const EXPERIMENT = /^EXPDTA|_exptl\.method|_refine\.ls_/m;
function confidence(parsed, text) {
  const rows = parsed.rows;
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) if (Number.isFinite(r.b)) { lo = Math.min(lo, r.b); hi = Math.max(hi, r.b); }
  parsed.bFactors = parsed.hasPlddt = false;
  if (!(hi > lo)) return parsed;                        // none, or all the same: nothing to colour by
  parsed.bFactors = true;
  const unit = lo >= 0 && hi <= 1;
  if (unit) for (const r of rows) { r.b *= 100; for (const a of r.atoms) a.b *= 100; }
  if (!(lo >= 0 && (unit || hi <= 100))) return parsed;
  let multi = 0, same = 0;
  for (const r of rows) { if (r.atoms.length < 3) continue; multi++; if (r.atoms.every(a => a.b === r.atoms[0].b)) same++; }
  const perResidue = multi >= 10 && same >= 0.95 * multi;
  parsed.hasPlddt = STRONG.test(text) || unit || (!EXPERIMENT.test(text) && (PREDICTOR.test(text) || perResidue));
  return parsed;
}

export function parseStructure(text) {
  if (/^data_/m.test(text.slice(0, 2000)) || /_atom_site\./.test(text.slice(0, 200000))) return parseCIF(text);
  return parsePDB(text);
}

// Read a File/Blob (optionally .gz) into a parsed structure.
export async function readStructureFile(file) {
  let text;
  if (/\.gz$/i.test(file.name || "")) {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser can't unzip .gz files; unzip it first");
    text = await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  } else text = await file.text();
  const parsed = parseStructure(text);
  const m = (file.name || "").match(/AF-([A-Z0-9]+)-F(\d+)/i);
  if (m) parsed.fromAFDB = parsed.hasPlddt = parsed.bFactors = true;
  return { parsed, afId: m ? { acc: m[1].toUpperCase(), frag: m[2] } : null };
}
