// Minimal PDB / mmCIF readers. Only what the renderer needs, from the first chain of the first
// model: every heavy atom (for the van der Waals surface), Cα and carbonyl O by name (for the
// cartoon), the residue name, B-factor (pLDDT for predicted models), and HELIX/SHEET records when
// a PDB file has them. Selenomethionine (HETATM MSE) counts as a residue; ligands and water don't.
//
// Returns { rows: [{ num, name, CA, O, b, atoms: [{ n, e, p, b }] }], chain, ss: string[] | null,
//           bFactors, hasPlddt, fromAFDB, title }
//   bFactors  the B-factor column has varying values, so there's something to colour by
//   hasPlddt  it looks like per-residue confidence (pLDDT, 0–100), see confidence()
//   fromAFDB  the file comes from AlphaFold DB (for its CC BY 4.0 credit)

const keepHet = comp => comp === "MSE";
const elementOf = (el, name) => (el || name.replace(/[^A-Za-z]/g, "").slice(0, 1)).toUpperCase();

function addAtom(res, order, key, num, comp, name, el, p, b) {
  let r = res.get(key);
  if (!r) { r = { num, name: comp, atoms: [] }; res.set(key, r); order.push(key); }
  r.atoms.push({ n: name, e: el, p, b });
  if (name === "CA" || name === "O") r[name] = p;
  if (name === "CA") r.b = b;
}

export function parsePDB(text) {
  const res = new Map(), order = [], helix = [], sheet = [];
  let chain = null, title = null;
  for (const l of text.split(/\r?\n/)) {
    const rec = l.slice(0, 6);
    if (rec === "ENDMDL") break;
    if (rec === "TITLE " && !title) title = l.slice(10).trim();
    if (rec === "HELIX ") { helix.push([l[19], parseInt(l.slice(21, 25)), parseInt(l.slice(33, 37))]); continue; }
    if (rec === "SHEET ") { sheet.push([l[21], parseInt(l.slice(22, 26)), parseInt(l.slice(33, 37))]); continue; }
    const comp = l.slice(17, 20).trim();
    if (rec !== "ATOM  " && !(rec === "HETATM" && keepHet(comp))) continue;
    const alt = l[16]; if (alt !== " " && alt !== "A") continue;
    const ch = l[21]; if (chain === null) chain = ch; if (ch !== chain) continue;
    const name = l.slice(12, 16).trim(), el = elementOf(l.slice(76, 78).trim(), name);
    if (el === "H" || el === "D") continue;
    addAtom(res, order, l.slice(22, 27), parseInt(l.slice(22, 26)), comp, name, el,
            [parseFloat(l.slice(30, 38)), parseFloat(l.slice(38, 46)), parseFloat(l.slice(46, 54))], parseFloat(l.slice(60, 66)));
  }
  const rows = order.map(k => res.get(k)).filter(r => r.CA);
  let ss = null;
  const m = new Map();
  for (const [c, a, b] of helix) if (c === chain) for (let i = a; i <= b; i++) m.set(i, "H");
  for (const [c, a, b] of sheet) if (c === chain) for (let i = a; i <= b; i++) m.set(i, "E");
  if (m.size) ss = rows.map(r => m.get(r.num) || "C");
  return confidence({ rows, chain, ss, title, fromAFDB: /^TITLE {5}ALPHAFOLD/m.test(text.slice(0, 5000)) }, text);
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
  const res = new Map(), order = [];
  let chain = null, model = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l[0] === "#" || l[0] === "_" || l.startsWith("loop_")) break;
    const t = cifTokens(l); if (t.length < cols.length) continue;
    const comp = ix.comp >= 0 ? t[ix.comp] : "UNK";
    if (ix.g >= 0 && t[ix.g] !== "ATOM" && !(t[ix.g] === "HETATM" && keepHet(comp))) continue;
    if (ix.model >= 0) { if (model === null) model = t[ix.model]; else if (t[ix.model] !== model) break; }
    if (ix.alt >= 0 && !".?A".includes(t[ix.alt])) continue;
    const ch = t[ix.chain]; if (chain === null) chain = ch; if (ch !== chain) continue;
    const name = t[ix.atom], el = elementOf(ix.el >= 0 ? t[ix.el] : "", name);
    if (el === "H" || el === "D") continue;
    addAtom(res, order, t[ix.seq] + (ix.ins >= 0 ? t[ix.ins] : ""), parseInt(t[ix.seq]), comp, name, el,
            [parseFloat(t[ix.x]), parseFloat(t[ix.y]), parseFloat(t[ix.z])], ix.b >= 0 ? parseFloat(t[ix.b]) : 0);
  }
  return confidence({ rows: order.map(k => res.get(k)).filter(r => r.CA), chain, ss: null, title: null,
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
