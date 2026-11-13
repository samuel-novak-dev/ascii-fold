import { parseStructure } from "./parse.js";

export const AFDB = "https://alphafold.ebi.ac.uk";
const ACC_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

// Accepts "P01116", "af-p01116-f1", "AF-P01116-F1-model_v6.pdb" … → "P01116" (or null)
export function normalizeAccession(raw) {
  const acc = String(raw || "").trim().toUpperCase()
    .replace(/^AF-/, "").replace(/-F\d+(-MODEL_V\d+)?(\.(PDB|CIF))?$/, "");
  return ACC_RE.test(acc) ? acc : null;
}

export class AFDBError extends Error {
  constructor(message, kind, acc) { super(message); this.kind = kind; this.acc = acc; }
}

// Fetch the AlphaFold DB model for a UniProt accession straight from the browser
// (AFDB serves CORS headers). Returns { parsed, meta, acc, entryUrl }.
export async function fetchAFDB(raw, { signal } = {}) {
  const acc = normalizeAccession(raw);
  if (!acc) throw new AFDBError(`“${raw}” doesn't look like a UniProt accession (e.g. P01116).`, "invalid", raw);
  const entryUrl = `${AFDB}/entry/${acc}`;
  let meta, text;
  try {
    const r = await fetch(`${AFDB}/api/prediction/${acc}`, { signal });
    if (r.status === 404 || r.status === 400) throw new AFDBError(`No AlphaFold DB entry for ${acc}.`, "missing", acc);
    if (!r.ok) throw new Error(`API returned ${r.status}`);
    const list = await r.json();
    meta = Array.isArray(list) ? list[0] : list;
    if (!meta || !(meta.pdbUrl || meta.cifUrl)) throw new AFDBError(`No model file listed for ${acc}.`, "missing", acc);
    const fr = await fetch(meta.pdbUrl || meta.cifUrl, { signal });
    if (!fr.ok) throw new Error(`model file returned ${fr.status}`);
    text = await fr.text();
  } catch (e) {
    if (e instanceof AFDBError || e.name === "AbortError") throw e;
    throw new AFDBError(`Couldn't reach AlphaFold DB (${e.message || e}).`, "network", acc);
  }
  const parsed = parseStructure(text);
  parsed.fromAFDB = parsed.hasPlddt = parsed.bFactors = true;
  return { parsed, meta, acc, entryUrl };
}

// Display strings for an AFDB entry
export function describeAFDB(meta, acc) {
  const frag = meta.uniprotStart && meta.uniprotEnd ? ` (${meta.uniprotStart}–${meta.uniprotEnd})` : "";
  return {
    title: meta.gene || meta.uniprotId || acc,
    sub: [meta.uniprotDescription, meta.organismScientificName, `${meta.entryId || "AF-" + acc}${frag} · v${meta.latestVersion || "?"}`].filter(Boolean).join(" · "),
  };
}
