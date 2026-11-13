"""Pack one chain of a PDB file into a small JS module for src/data/.

    python3 scripts/bundle_pdb.py 6GJ8.pdb A "KRAS G12D, PDB 6GJ8 chain A" > src/data/kras-6gj8.js

Keeps the chain's HELIX/SHEET records and every heavy atom of its first model (alternate
location A or none; no water or hydrogens), ligands and ions included. Atoms are stored as
"name x y z" with coordinates to 0.01 Å (ligand atoms add their element), one residue per line
(a ligand's marked "H"), and the module expands them back to PDB text on import, so parsePDB
reads it like any other file.
"""
import json
import sys

path, chain, label = sys.argv[1], sys.argv[2], sys.argv[3]
ss, residues, order = [], {}, []
for line in open(path):
    rec = line[:6]
    if rec == "ENDMDL":
        break
    if rec == "HELIX " and line[19] == chain or rec == "SHEET " and line[21] == chain:
        ss.append(line.rstrip())
    comp = line[17:20].strip()
    ligand = rec == "HETATM" and comp not in ("MSE", "HOH", "WAT", "DOD")
    if rec != "ATOM  " and not (rec == "HETATM" and comp == "MSE") and not ligand:
        continue
    if line[21] != chain or line[16] not in " A":
        continue
    element = line[76:78].strip() or line[12:16].strip()[0]
    if element in ("H", "D"):
        continue
    key = line[22:27]
    if key not in residues:
        residues[key] = (line[22:26].strip() + " " + comp + (" H" if ligand else ""), [])
        order.append(key)
    x, y, z = (float(line[c:c + 8]) for c in (30, 38, 46))
    residues[key][1].append(f"{line[12:16].strip()} {x:.2f} {y:.2f} {z:.2f}" + (f" {element}" if ligand else ""))

rows = "\n".join(head + "|" + "|".join(atoms) for head, atoms in (residues[k] for k in order))
n_atoms = sum(len(residues[k][1]) for k in order)
ligands = [residues[k][0].split()[1] for k in order if residues[k][0].endswith(" H")]
ss_json, rows_json = json.dumps(ss), json.dumps(rows)
with_ligands = f", ligands {', '.join(ligands)} included" if ligands else ""
print(f"""// {label}: all {n_atoms} heavy atoms{with_ligands}, plus HELIX/SHEET records (PDB data: CC0).
// Packed by scripts/bundle_pdb.py ("name x y z" per atom, one residue per line) and expanded to
// PDB text on import.
const SS = {ss_json};
const RES = {rows_json};

function expand() {{
  const out = SS.slice();
  let serial = 1;
  for (const line of RES.split("\\n")) {{
    const [head, ...atoms] = line.split("|"), [num, comp, het] = head.split(" ");
    for (const a of atoms) {{
      const [n, x, y, z, e] = a.split(" "), el = e || (n.startsWith("SE") ? "SE" : n[0]);
      out.push((het ? "HETATM" : "ATOM  ") + String(serial++).padStart(5) + " " + (n.length < 4 ? " " + n : n).padEnd(4) + " " + comp.padStart(3) +
        " {chain}" + num.padStart(4) + "    " + (+x).toFixed(3).padStart(8) + (+y).toFixed(3).padStart(8) + (+z).toFixed(3).padStart(8) +
        "  1.00  0.00          " + el.padStart(2));
    }}
  }}
  return out.join("\\n");
}}

export default expand();""")
