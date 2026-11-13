# ASCII Fold

Protein structures drawn as 3D ASCII text that melts into a ChimeraX-style cartoon, with side chains, ligands and a see-through surface, right in the browser.

<p align="center"><img src="docs/demo.gif" alt="KRAS G12D (PDB 6GJ8) turning: geometric glyphs on the left melt into a cartoon with side chains, ligands and a see-through surface" width="560"></p>

## Start it

```bash
git clone https://github.com/samuel-novak-dev/ascii-fold.git
cd ascii-fold
python3 -m http.server 5173
```

Open <http://localhost:5173>, then open or drop a `.pdb` / `.cif` file onto the page. Opening `index.html` straight from disk won't work, because it needs a web server. To run it without one, open `dist/ascii-fold-standalone.html` instead.

## Citation

This project is based on **ascii-fold** by Maxim Tsenkov: <https://github.com/mitsenkov/ascii-fold> (MIT). If you use it, please cite the original repository:

> Tsenkov, M. *ascii-fold: spinning protein structures drawn as ASCII text.* https://github.com/mitsenkov/ascii-fold
