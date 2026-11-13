// The full-page app (index.html): wires the settings panel and the sequence panel to one engine view.
import { createAsciiFold, COLOURS } from "./engine.js";
import { SHAPE_DEFAULT } from "./geometry.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const view = createAsciiFold($("stage"));
window.asciiFold = view;   // handy from the console: asciiFold.set({ spin: 0 }), asciiFold.snapshot() …

// ---------- header, errors, credit ----------
function status(msg, err = false) { $("status").innerHTML = msg; $("status").classList.toggle("err", err); }
view.on("load", info => {
  $("title").textContent = info.title;
  const bits = [info.sub, `${info.residues} residues`];
  if (info.hasPlddt) bits.push(`mean pLDDT ${info.meanPlddt.toFixed(1)}`);
  else if (info.hasB) bits.push(`mean B-factor ${info.meanB.toFixed(1)}`);
  $("sub").textContent = bits.filter(Boolean).join(" · ");
  $("plddtBtn").disabled = !info.hasB;   // colours by the B-factor column, whatever made the file
  if (!info.hasB && view.options.colour === "plddt") { view.set({ colour: "ss" }); markColour("ss"); renderLegend(); }
  buildSequence();
  $("credit").innerHTML = info.entryUrl
    ? `Structure: <a href="${info.entryUrl}" target="_blank" rel="noopener">AlphaFold DB</a> (CC BY 4.0)`
    : info.fromAFDB ? "Structure: AlphaFold DB (CC BY 4.0)" : "";
});

// ---------- loading: open or drop a .pdb / .cif file ----------
async function loadFile(f) {
  try { const info = await view.loadFile(f); if (info) status(""); }
  catch (e) { status(`Couldn't read ${esc(f.name)}: ${esc(e.message)}`, true); }
}
$("openBtn").onclick = () => $("file").click();
$("file").onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; };

let dragDepth = 0;
window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("stage").classList.add("drop"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("stage").classList.remove("drop"); } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; $("stage").classList.remove("drop");
  const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f);
});

// ---------- segmented controls ----------
const handlers = {};
function setSeg(id, v) {
  $(id).querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.v === v));
  handlers[id](v);
}
function seg(id, fn) {
  handlers[id] = fn;
  $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; setSeg(id, b.dataset.v); });
}
seg("surface", v => view.set({ surface: v === "on" }));
// side chains: none, the residues selected in the sequence (kept in step with it), or all
let scMode = "off";
const syncSideChains = () => view.showSideChains(scMode === "all" ? "all" : scMode === "sel" ? [...sel] : null);
seg("sidechains", v => { scMode = v; syncSideChains(); });
seg("layout", v => view.set({ layout: v }));
seg("theme", v => { document.body.classList.toggle("night", v === "night"); view.set({ theme: v }); renderLegend(); paintSequence(); });
seg("detail", v => view.set({ detail: v }));
seg("glyphs", v => view.set({ glyphs: v }));
$("speed").oninput = e => setSpin(+e.target.value);
$("persp").oninput = e => view.set({ perspective: e.target.value / 100 });
$("depth").oninput = e => view.set({ depth: e.target.value / 100 });
seg("faces", v => view.set({ faces: v === "on" }));

// ---------- colour: the whole structure, or the residues selected in the sequence ----------
// Favourite swatches up front, in groups; ChimeraX's basic colours behind "More colours".
const FAVOURITES = [
  [["dark gray", "#a9a9a9"], ["gray", "#808080"]],
  [["cornflower blue", "#6495ed"], ["deep sky blue", "#00bfff"], ["light sky blue", "#87cefa"], ["steel blue", "#4682b4"]],
  [["light sea green", "#20b2aa"], ["cadet blue", "#5f9ea0"], ["dark cyan", "#008b8b"]],
  [["tomato", "#ff6347"], ["coral", "#ff7f50"], ["orange", "#ffa500"]],
  [["hot pink", "#ff69b4"], ["medium violet red", "#c71585"], ["pale violet red", "#db7093"], ["indian red", "#cd5c5c"], ["crimson", "#dc143c"]],
];
const swatch = ([n, h]) => `<button type="button" data-v="${n}" title="${n}" aria-label="${n}" style="--c:${h}"></button>`;
$("swatches").innerHTML = FAVOURITES.map(g => `<div class="srow">${g.map(swatch).join("")}</div>`).join("");
$("moreSwatches").innerHTML = COLOURS.map(swatch).join("");
$("moreCol").onclick = () => {
  const open = $("moreSwatches").hidden;
  $("moreSwatches").hidden = !open;
  $("moreCol").textContent = open ? "Fewer colours" : "More colours";
  $("moreCol").setAttribute("aria-expanded", String(open));
};
let custom = false;   // some residues carry their own colour
function applyColour(v) {
  if (sel.size) { view.colourResidues([...sel], v); custom = true; }
  else { view.clearResidueColours(); custom = false; view.set({ colour: v }); markColour(v); }
  $("colReset").hidden = !custom;
  renderLegend(); paintSequence();
}
function markColour(v) {   // highlight the overall colour's button or swatch
  document.querySelectorAll("#colour button, #swatches button, #moreSwatches button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
}
for (const id of ["colour", "swatches", "moreSwatches"])
  $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (b && !b.disabled) applyColour(b.dataset.v); });
function renderLegend() {
  const p = view.palette(), c = view.options.colour, named = [...FAVOURITES.flat(), ...COLOURS].find(([n]) => n === c);
  const items = c === "ss" ? [["Helix", p.H], ["Strand", p.E], ["Coil", p.C]]
    : c === "plddt" ? [[">90", p.P[0]], ["70–90", p.P[1]], ["50–70", p.P[2]], ["<50", p.P[3]]] : named ? [named] : [];
  $("legend").innerHTML = items.map(([t, col]) => `<span style="--sw:${col}">${t}</span>`).join("") + (custom ? "<span>+ your colours</span>" : "");
}
$("colReset").onclick = () => { view.clearResidueColours(); custom = false; $("colReset").hidden = true; renderLegend(); paintSequence(); };

// ---------- sequence panel: drag or click to select residues, then pick a colour ----------
const RW = 11;   // px per residue, as --rw in app.css
const sel = new Set();
let residues = [], anchor = -1, dragBase = null;
function buildSequence() {
  residues = view.residues(); sel.clear(); custom = false; $("colReset").hidden = true;
  const n = residues.length, runs = [];
  for (let i = 0; i < n;) {
    let j = i; while (j + 1 < n && residues[j + 1].ss === residues[i].ss) j++;
    if (residues[i].ss !== "C") runs.push([i, j, residues[i].ss]);
    i = j + 1;
  }
  const sse = runs.map(([a, b, s]) => `<b class="${s}" data-a="${a}" data-b="${b}" title="${s === "H" ? "Helix" : "Strand"} ${residues[a].num}–${residues[b].num}" style="left:${a * RW}px;width:${(b - a + 1) * RW}px"></b>`).join("");
  const aa = residues.map(r => `<i title="${esc(r.name)} ${r.num}">${r.aa}</i>`).join("");
  const nums = residues.map((r, i) => r.num % 10 === 0 ? `<span style="left:${i * RW}px">${r.num}</span>` : "").join("");
  $("seqTrack").style.width = n * RW + "px";
  $("seqTrack").innerHTML = `<div class="sse" style="width:${n * RW}px">${sse}</div><div class="aa">${aa}</div><div class="num">${nums}</div>`;
  for (const b of $("pickSS").querySelectorAll("button")) b.disabled = !residues.some(r => r.ss === b.dataset.v);
  paintSequence(); showSelection(); renderLegend();
}
function paintSequence() {   // each letter in its residue's current colour
  const cols = view.residueColours();
  $("seqTrack").querySelectorAll(".aa i").forEach((c, i) => { c.style.color = cols[i]; });
}
function ranges() {          // the selection as residue-number ranges: "12–30, 45"
  const idx = [...sel].sort((a, b) => a - b), out = [];
  for (let k = 0; k < idx.length;) {
    let j = k; while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    out.push(j > k ? `${residues[idx[k]].num}–${residues[idx[j]].num}` : `${residues[idx[k]].num}`);
    k = j + 1;
  }
  return out.length > 5 ? out.slice(0, 5).join(", ") + " …" : out.join(", ");
}
function showSelection() {
  $("seqTrack").querySelectorAll(".aa i").forEach((c, i) => c.classList.toggle("sel", sel.has(i)));
  for (const b of $("pickSS").querySelectorAll("button")) b.classList.toggle("on", allOf(b.dataset.v));
  const n = sel.size;
  $("selClear").hidden = !n;
  $("colourTarget").textContent = n ? `${n} selected` : "all";
  $("colourTarget").classList.toggle("sel", n > 0);
  $("selInfo").innerHTML = n ? `<b>${n}</b> selected (${ranges()})` : "";
  if (scMode === "sel") syncSideChains();
}
const indexAt = e => { const r = $("seqTrack").getBoundingClientRect(); return Math.max(0, Math.min(residues.length - 1, Math.floor((e.clientX - r.left) / RW))); };
$("seqTrack").addEventListener("pointerdown", e => {
  if (!residues.length || e.button !== 0) return;
  if (!(e.shiftKey || e.metaKey || e.ctrlKey)) sel.clear();
  const bar = e.target.closest(".sse b");
  if (bar) { for (let i = +bar.dataset.a; i <= +bar.dataset.b; i++) sel.add(i); showSelection(); return; }
  anchor = indexAt(e); dragBase = new Set(sel); sel.add(anchor);
  $("seqTrack").setPointerCapture(e.pointerId);
  showSelection();
});
$("seqTrack").addEventListener("pointermove", e => {
  if (anchor < 0) return;
  const i = indexAt(e);
  sel.clear(); dragBase.forEach(x => sel.add(x));
  for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k);
  showSelection();
});
const endDrag = () => { anchor = -1; dragBase = null; };
$("seqTrack").addEventListener("pointerup", endDrag);
$("seqTrack").addEventListener("pointercancel", endDrag);
$("selClear").onclick = () => { sel.clear(); showSelection(); };

// ---------- select by structure: every helix, strand or loop residue, then pick a colour ----------
// A click replaces the selection, Shift adds to it; clicking a type that's fully selected drops it.
const ofType = t => residues.flatMap((r, i) => r.ss === t ? [i] : []);
const allOf = t => { const idx = ofType(t); return idx.length > 0 && idx.every(i => sel.has(i)); };
$("pickSS").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  const t = b.dataset.v, idx = ofType(t);
  if (allOf(t)) idx.forEach(i => sel.delete(i));
  else { if (!e.shiftKey) sel.clear(); idx.forEach(i => sel.add(i)); }
  showSelection();
});
window.addEventListener("keydown", e => { if (e.key === "Escape" && sel.size && $("gifDlg").hidden) { sel.clear(); showSelection(); } });

// ---------- shape panel ----------
let rebuildQueued = null;
function shape(partial) {          // coalesce slider drags into one rebuild per frame
  rebuildQueued = { ...(rebuildQueued || {}), ...partial };
  requestAnimationFrame(() => { if (rebuildQueued) { view.setShape(rebuildQueued); rebuildQueued = null; } });
}
const SLIDERS = {
  hW: v => shape({ hW: v / 100 }),
  hT: v => shape({ hT: v / 100 }), flat: v => shape({ flat: v / 100 }), sW: v => shape({ sW: v / 100 }),
  sT: v => shape({ sT: v / 100 }), head: v => shape({ head: v / 100 }), coilR: v => shape({ coilR: v / 100 }),
};
for (const [id, fn] of Object.entries(SLIDERS)) $(id).addEventListener("input", e => fn(+e.target.value));
function syncShapeUI() {
  $("headWrap").classList.toggle("off", !view.options.shape.arrows);
}
seg("arrows", v => { view.setShape({ arrows: v === "on" }); syncShapeUI(); });
$("shapeReset").onclick = () => {
  view.resetShape();
  const d = SHAPE_DEFAULT;
  for (const [id, v] of Object.entries({ hT: d.hT, flat: d.flat, sW: d.sW, sT: d.sT, head: d.head, coilR: d.coilR })) $(id).value = Math.round(v * 100);
  $("hW").value = Math.round(d.hW * 100); setSeg("arrows", "on");
};

// ---------- snapshot ----------
$("png").onclick = () => { $("snap").querySelector("img").src = view.snapshot(); $("snap").hidden = false; };
$("snap").onclick = e => { if (e.target === $("snap")) $("snap").hidden = true; };

// ---------- GIF export ----------
// The GIF turns at the on-screen speed: the engine spins spin × 1.6 rad/s, so one turn takes 2π / (1.6 × spin) s.
const gif = { delay: 50, width: 720, url: null, ctrl: null };
const KB_PER_FRAME_720 = 57;                       // measured: ~3.4 MB for 60 frames at 720 px
const turnSeconds = () => (2 * Math.PI) / (1.6 * Math.max(0.1, view.options.spin));
const gifFrames = () => Math.max(12, Math.round((turnSeconds() * 1000) / gif.delay));
function gifEstimate() {
  const n = gifFrames(), mb = (n * KB_PER_FRAME_720 * (gif.width / 720) ** 2) / 1024;
  $("gifTurnTime").textContent = turnSeconds().toFixed(1) + " s";
  $("gifEst").textContent = `${turnSeconds().toFixed(1)} s loop · ${n} frames · about ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB` +
    (mb > 15 ? " — large; try Light, a smaller width, or a faster spin" : "");
}
function setSpin(v) {                              // keeps the main slider, the dialog slider and the engine in step
  $("speed").value = v; $("gifSpin").value = Math.max(10, v);
  view.set({ spin: v / 100 }); gifEstimate();
}
$("gifSpin").oninput = e => setSpin(+e.target.value);
seg("gifFps", v => { gif.delay = +v; gifEstimate(); });
seg("gifSize", v => { gif.width = +v; gifEstimate(); });
function gifReset() {
  if (gif.url) URL.revokeObjectURL(gif.url);
  gif.url = null; $("gifOut").innerHTML = ""; $("gifSave").hidden = true; $("gifBar").style.width = "0";
}
$("gifBtn").onclick = () => {
  gifReset(); $("gifGo").textContent = "Record";
  if (view.options.spin < 0.1) setSpin(35);          // a GIF needs some rotation: fall back to the default speed
  $("gifSpin").value = Math.round(view.options.spin * 100); gifEstimate();
  $("gifDlg").hidden = false; $("gifGo").focus();
};
function gifClose() { if (gif.ctrl) gif.ctrl.abort(); $("gifDlg").hidden = true; }
$("gifClose").onclick = gifClose;
$("gifDlg").onclick = e => { if (e.target === $("gifDlg")) gifClose(); };
window.addEventListener("keydown", e => { if (e.key === "Escape" && !$("gifDlg").hidden) gifClose(); });
$("gifGo").onclick = async () => {
  gifReset();
  gif.ctrl = typeof AbortController === "function" ? new AbortController() : null;
  $("gifGo").disabled = true; $("gifGo").textContent = "Recording…";
  try {
    const frames = gifFrames();
    const blob = await view.recordGif({ frames, delay: gif.delay, width: gif.width,
      signal: gif.ctrl && gif.ctrl.signal, onProgress: f => $("gifBar").style.width = (f * 100).toFixed(1) + "%" });
    gif.url = URL.createObjectURL(blob);
    const name = `ascii-fold-${(view.info && (view.info.acc || view.info.title) || "protein").replace(/[^\w-]+/g, "_")}.gif`;
    $("gifSave").href = gif.url; $("gifSave").download = name; $("gifSave").hidden = false;
    $("gifOut").innerHTML = `<img alt="Recorded GIF of the rotating structure" src="${gif.url}"><p>${(blob.size / 1048576).toFixed(1)} MB · ${frames} frames · ${turnSeconds().toFixed(1)} s · right-click the image to save if Download is blocked</p>`;
  } catch (e) {
    if (e.name !== "AbortError") $("gifOut").innerHTML = `<p>Couldn't record: ${esc(e.message)}</p>`;
  } finally {
    gif.ctrl = null; $("gifGo").disabled = false; $("gifGo").textContent = "Record again";
  }
};

// ---------- start ----------
markColour(view.options.colour);
renderLegend();
view.loadDefault();
