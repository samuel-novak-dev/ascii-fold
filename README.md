# ASCII Fold

Spinning protein structures drawn as ASCII text that dissolves into a cartoon ribbon or a molecular surface. Open a `.pdb` / `.cif` file (from [AlphaFold DB](https://alphafold.ebi.ac.uk), the PDB or your own) and it's drawn in your browser. There's no server and no build step to run it.

<p align="center"><img src="docs/demo.gif" alt="KRAS G12D rotating: ASCII characters on the left dissolve into a red, blue and gold cartoon ribbon on the right" width="560"></p>

- **Text in 3D.** Glyphs are printed on the surface of the chain: they shrink and fade with distance, hide behind nearer parts, darken on the side away from the light and foreshorten as the surface turns away. The text takes the cartoon's shape: helices are twisting ribbons, strands are flat arrows and loops are thin tubes, so text and ribbon line up exactly where one turns into the other. A Perspective slider sets how strongly near parts loom.
- **Text → ribbon blend.** One projection drives the text and a canvas cartoon, so they always line up. The handover is a fixed dither, like a halftone.
- **Your structures.** Open or drop a `.pdb` / `.cif` file (gzipped is fine) on the page; the embeddable element can also fetch AlphaFold DB models by accession. Colour by secondary structure, by pLDDT, or in one colour: a row of favourites plus ChimeraX's basic colours.
- **Surface.** Show the molecular surface instead of the cartoon, built from every heavy atom at its van der Waals radius, as in ChimeraX. It's drawn as a smooth triangle mesh with WebGL and lit like ChimeraX's gentle lighting, with depth cueing only in the back half. The text is printed on the same surface. Files with only Cα atoms get a smoother residue-level surface.
- **Sequence panel.** The chain's sequence runs along the bottom with its helices and strands. Drag across residues or click a helix or strand to select it, or select every helix, strand or loop at once from the Colour panel (Shift adds), then pick a colour to recolour just those residues.
- **Lighting.** One style throughout, after ChimeraX's `lighting gentle`: soft ambient light with ambient occlusion, so grooves and buried faces darken, plus a little key light and no highlights. The cartoon and surface are real 3D meshes rendered with WebGL, with ChimeraX-style silhouette outlines.
- **Shape controls** (in the settings panel, under Glyphs and shape). Flatten strands and size their arrowheads. Draw helices as flat ribbons on a fitted ideal helix (2.2 Å wide and paper-thin by default) or as cylinders. Set thickness and width for helices, strands and loops.
- **Zoom and detail.** Zoom adds characters instead of enlarging them (the 3D text re-samples in half-octave steps). The Detail setting picks the number of text rows, which also sets the 3D glyph size.
- **Export.** Save seamless looping GIFs (one exact turn, up to 1080 px wide) or PNG snapshots.
- **Embeddable.** `<ascii-fold accession="P01116">` works on any page.

## Run it

```bash
git clone https://github.com/mitsenkov/ascii-fold.git
cd ascii-fold
npx serve .            # or: python3 -m http.server
```

Then open the printed URL. ES modules need a web server, so double-clicking `index.html` won't work. For a single file you can open from disk, use `dist/ascii-fold-standalone.html`.

## Deploy your own

If you deploy somewhere other than `https://mitsenkov.github.io/ascii-fold/`, update the `og:url` and `og:image` tags in `index.html`. Social sites need absolute URLs for the preview image (`docs/og.png`).


The site is static, so any static host works.

**GitHub Pages:** fork the repo, then go to **Settings → Pages → Source → GitHub Actions**. The workflow in `.github/workflows/pages.yml` builds and publishes on every push to `main`. Your copy appears at `https://<you>.github.io/ascii-fold/`.

**Netlify / Vercel / Cloudflare Pages:** connect the repo, set the build command to `npm run build` and the output directory to `.` (repo root).

**Anywhere else:** upload `dist/ascii-fold-standalone.html` and rename it `index.html` if you like.

AlphaFold DB sends CORS headers, so visitors' browsers fetch models directly and you don't need a proxy.

## Embed it

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/mitsenkov/ascii-fold@v1.0.0/dist/ascii-fold.js"></script>

<ascii-fold accession="P04637" theme="night" colour="plddt" style="height: 420px"></ascii-fold>
```

| Attribute | Values | Default |
|---|---|---|
| `accession` | UniProt accession, fetched from AlphaFold DB | bundled KRAS (PDB 6GJ8) |
| `src` | URL of a `.pdb` / `.cif` file (must be CORS-readable) | |
| `theme` | `paper` · `night` | `paper` |
| `colour` | `ss` · `plddt`, or one colour: a ChimeraX basic colour name (`red`, `orange red`, `cornflower blue`, `light sea green`, `dim gray` …) or a hex value | `ss` |
| `layout` | `lr` (text→ribbon) · `rl` · `ascii` · `ribbon` | `lr` |
| `perspective` | 0–1; 0 is orthographic | `1` |
| `surface` | present: show the molecular surface instead of the cartoon | |
| `glyphs` | `classic` · `blocks` · `geo`, or your own light→dark ramp | `classic` |
| `detail` | `xcoarse` · `coarse` · `medium`, or a row count | `medium` |
| `spin` | rotation speed, 0–1 | `0` (still) |
| `blend-from`, `blend-to` | where the blend starts and ends, 0–1 (not in the app's panel) | `0.4`, `0.6` |
| `helix-style` | `ribbon` · `cylinder` | `ribbon` |
| `interactive` | `false` disables drag and zoom | |
| `transparent` | no background fill | |
| `no-credit` | hides the AlphaFold DB credit line (credit it elsewhere) | |

Size the element with CSS; it defaults to 360 px tall. It fires `fold-load` and `fold-error` events and exposes the engine as `element.view`. `examples/embed.html` shows a few variants.

For a bigger view on your homepage, embed the full app in an `<iframe>`, or use the element above.

## Use the engine directly

```js
import { createAsciiFold } from "./src/index.js";   // or the dist bundle

const view = createAsciiFold(document.querySelector("#box"), { theme: "night", colour: "plddt" });
await view.loadAccession("P42212");
view.setShape({ hStyle: "cylinder", flat: 1 });
view.set({ spin: 0.35, perspective: 0 });   // turning, no perspective
view.set({ surface: true, colour: "cornflower blue" });
view.setRotation(1.2, -0.3);
const png = view.snapshot();       // data URL of the current frame
const gif = await view.recordGif({ frames: 60, width: 720 });   // Blob: one seamless turn
const txt = view.text();           // the protein as plain ASCII text
```

Other methods: `rotation` (the orientation as a 3×3 matrix), `set(options)`, `loadFile(file)`, `loadText(text)`, `loadDefault()`, `zoomBy(f)`, `resetView()`, `palette()`, `residues()`, `residueColours()`, `colourResidues(indices, colour)`, `clearResidueColours()`, `on("load" | "zoom" | "colour", fn)` and `destroy()`. In the app, the view is available as `window.asciiFold`.

## How it works

1. **Parse.** Read Cα and carbonyl O of the first chain from PDB or mmCIF. `src/parse.js` does this with no dependencies.
2. **Secondary structure.** Use HELIX/SHEET records when present. Otherwise assign it from Cα distances alone (`src/ss.js`, P-SEA-like). This agreed with deposited assignments on about 80–86% of residues in our checks, which is fine for drawing but not for analysis.
3. **Geometry.** Draw a Catmull-Rom spline through Cα. Orient the ribbon using the backbone C=O directions. Smooth the strand pleats on request, and fit helix axes for cylinders (`src/geometry.js`).
4. **Text.** Glyphs sit on the cartoon's own surfaces: rows across both faces and the edges of helix and strand bands, and rings around loop tubes, using the same widths as the ribbon. Each frame they are rotated with the model and dropped when they face away. The rest are splatted into a depth buffer, and any glyph with a nearer surface in front is dropped too. The survivors are sized by perspective, fogged by depth, laid into the surface's tangent plane and drawn back to front from a pre-rendered glyph atlas. A small paper disc under each glyph hides ink further back. Copy text is separate: it splats spheres along the chain into a z-buffered cell grid and maps each cell's light and depth to a glyph ramp.
5. **Cartoon.** Build the cartoon as a triangle mesh (`src/cartoon.js`): round tubes for loops (and cylinder helices), flat bands for helices and strands (a thin box, or a two-sided sheet when they have no thickness), and arrowheads, all from the same spline points, frames and widths as the 3D text. `src/glview.js` draws it with WebGL in the same (perspective) projection as the text. Without WebGL, a 2D painter's-algorithm ribbon stands in. Each helix of 4+ residues is drawn along an ideal helix: constant radius and twist around the fitted axis, with its phase and twist least-squares fitted to the real Cα (0.3–0.8 Å RMSD on KRAS). It eases back onto the path through the real Cα over the last residue and a half, so loops join smoothly. The picture is smoother than the data, on purpose.
   **Surface.** A blobby isosurface (`src/surface.js`): each heavy atom adds exp(−B·(d²/r² − 1)) to a field, with r its Bondi van der Waals radius, and the surface is where the field is 1. A lone atom is a sphere of its radius, and neighbours merge smoothly, filling crevices much as a solvent probe does. The field is sampled on a grid (0.55 Å, coarser for big proteins) and triangulated with surface nets, with normals and residues taken from the atoms. `src/glview.js` draws it the same way as the cartoon. The 3D text sits on evenly spaced mesh vertices. Without side chains, the same method runs on one soft 3.4 Å ball per residue.
   **Lighting.** Ambient occlusion per vertex is the share of 40 directions over its hemisphere that escape within about 11 Å (like ChimeraX's multishadow): rays are marched through the surface's field, or through the cartoon's own triangles sampled into a grid (only what's shown casts shadows, as in ChimeraX). The 3D text uses the Cα density just outside each glyph. All of it is mixed with a little key light and no highlights.
   **Silhouettes.** With WebGL2 the model is rendered into a multisampled buffer, and a second pass draws a thin dark outline wherever depth jumps by more than ~1.6 Å, like ChimeraX's silhouettes.
   **Rotation.** The orientation is a rotation matrix turned like a trackball: drags and the spin rotate about the screen's own axes, with no gimbal limits.
   **Depth cue.** As in ChimeraX, the front half of the model is untouched and the back half fades toward the background.
6. **Blend.** A fixed random mask hands each glyph to either the text or the model according to its horizontal position, and the model fades in under the text.

`scripts/bundle_pdb.py` packs one chain of a PDB file (all heavy atoms plus HELIX/SHEET) into the compact module used for the bundled structure.

## Develop

```bash
npm install
npm run dev        # static server on :5173
npm run build      # dist/ascii-fold.js (ESM), dist/ascii-fold.iife.js (global AsciiFold), dist/ascii-fold-standalone.html
```

```
src/
  engine.js               createAsciiFold(): rendering, interaction, public API
  geometry.js             spline, ribbon frames, shape parameters
  cartoon.js              cartoon triangle mesh (tubes, bands, arrows) and its ambient occlusion
  surface.js              molecular surface mesh (van der Waals atoms or Cα), ambient occlusion, text points
  glview.js               WebGL renderer for both meshes: Gentle lighting, depth cue, silhouettes
  parse.js · ss.js        PDB/mmCIF reader, Cα-only secondary structure
  afdb.js                 AlphaFold DB fetch + accession handling
  ascii-fold-element.js   <ascii-fold> web component
  app.js                  the full-page app (index.html)
```

## Data and credits

- Models come from the **AlphaFold Protein Structure Database** (EMBL-EBI and Google DeepMind). AlphaFold data is © 2021 DeepMind Technologies Limited, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and use of AlphaFold DB is subject to the [EMBL-EBI Terms of Use](https://www.ebi.ac.uk/about/terms-of-use/). The app and the component show a credit line; please keep it, or credit AlphaFold DB elsewhere on your page. If you use the predictions in your work, cite Jumper et al., *Nature* (2021) and the current database paper listed on the [AlphaFold DB homepage](https://alphafold.ebi.ac.uk).
- The bundled default structure is **PDB 6GJ8** (KRAS G12D) chain A with all heavy atoms, from the [Protein Data Bank](https://www.rcsb.org/structure/6GJ8) (CC0).
- The font is **JetBrains Mono**, loaded from Google Fonts under the SIL Open Font License.
- GIF encoding uses [gifenc](https://github.com/mattdesl/gifenc) by Matt DesLauriers (MIT), vendored in `src/vendor/`.

## License

The code is [MIT](LICENSE). Structure data keeps its own licence (see above).
