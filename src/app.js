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
  custom = false; $("colReset").hidden = true;
  buildChains();
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
  const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return;
  if (/\.json$/i.test(f.name)) loadView(f); else loadFile(f);   // a saved view, or a structure
});

// ---------- chains: one chip per protein chain, to show or hide it (at least one stays) ----------
function buildChains() {
  const ch = view.chains();
  $("chainRow").hidden = ch.length < 2;
  $("chainBtn").disabled = ch.length < 2;
  if (ch.length < 2 && view.options.colour === "chain") { view.set({ colour: "ss" }); markColour("ss"); }
  $("chainRow").innerHTML = ch.map(c => `<button type="button" data-c="${esc(c.id)}" class="${c.shown ? "on" : ""}" style="--c:${c.colour}" title="Chain ${esc(c.id)}, ${c.n} residues"><i></i>${esc(c.id)}<small>${c.n}</small></button>`).join("");
}
$("chainRow").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const on = view.chains().filter(c => c.shown).map(c => c.id), id = b.dataset.c;
  const next = on.includes(id) ? on.filter(c => c !== id) : [...on, id];
  if (!next.length) return;
  view.showChains(next);
});
view.on("chains", () => { buildChains(); buildSequence(); renderLegend(); });

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
seg("surface", v => { view.set({ surface: v === "on", glass: v === "glass" }); $("glassRow").hidden = v !== "glass"; });
$("glassOp").oninput = e => view.set({ glassOpacity: e.target.value / 100 });
// side chains: none, the residues selected in the sequence (kept in step with it), or all
let scMode = "off";
const syncSideChains = () => view.showSideChains(scMode === "all" ? "all" : scMode === "sel" ? [...sel] : null);
seg("sidechains", v => { scMode = v; syncSideChains(); });
seg("ligands", v => view.set({ ligands: v === "on" }));
seg("layout", v => view.set({ layout: v }));
seg("theme", v => { document.body.classList.toggle("night", v === "night"); view.set({ theme: v }); renderLegend(); paintSequence(); });
seg("detail", v => view.set({ detail: v }));
seg("glyphs", v => view.set({ glyphs: v }));
$("speed").oninput = e => setSpin(+e.target.value);
$("persp").oninput = e => view.set({ perspective: e.target.value / 100 });
$("depth").oninput = e => view.set({ depth: e.target.value / 100 });
seg("faces", v => view.set({ faces: v === "on" }));
// motion: the panel's switch and the animation dialog's stay in step
function setMotion(v) {
  for (const id of ["motion", "aniMotion"]) $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  view.set({ motion: v }); gifEstimate();
}
seg("motion", setMotion);

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
let custom = false;   // some residues or ligands carry their own colour
function applyColour(v) {
  if (sel.size || lsel.size) {
    if (sel.size) view.colourResidues([...sel], v);
    if (lsel.size) view.colourLigands([...lsel], v);   // Structure or pLDDT gives a ligand back its own colour
    custom = true;
  }
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
    : c === "chain" ? view.chains().filter(x => x.shown).map(x => [`Chain ${x.id}`, x.colour])
    : c === "plddt" ? [[">90", p.P[0]], ["70–90", p.P[1]], ["50–70", p.P[2]], ["<50", p.P[3]]] : named ? [named] : [];
  $("legend").innerHTML = items.map(([t, col]) => `<span style="--sw:${col}">${t}</span>`).join("") + (custom ? "<span>+ your colours</span>" : "");
}
$("colReset").onclick = () => { view.clearResidueColours(); custom = false; $("colReset").hidden = true; renderLegend(); paintSequence(); };

// ---------- sequence panel: drag or click to select residues, then pick a colour ----------
// Ligands sit in a row of chips below the sequence; they select (and recolour) the same way.
const RW = 11;   // px per residue, as --rw in app.css
const sel = new Set(), lsel = new Set();   // selected residues, selected ligands
// With several chains, each starts after a two-column gap that carries its name.
const GAP = 2;
let residues = [], ligands = [], anchor = -1, dragBase = null, multi = false, posOf = [], colRes = [];
function buildSequence() {
  residues = view.residues(); ligands = view.ligands(); sel.clear(); lsel.clear();
  const n = residues.length, runs = [];
  multi = new Set(residues.map(r => r.chain)).size > 1;
  posOf = []; colRes = [];   // residue → column, and column → residue (a gap's columns → the chain it starts)
  residues.forEach((r, i) => {
    if (multi && (i === 0 || r.chain !== residues[i - 1].chain)) for (let g = 0; g < GAP; g++) colRes.push(i);
    posOf[i] = colRes.length; colRes.push(i);
  });
  for (let i = 0; i < n;) {
    let j = i; while (j + 1 < n && residues[j + 1].ss === residues[i].ss && residues[j + 1].chain === residues[i].chain) j++;
    if (residues[i].ss !== "C") runs.push([i, j, residues[i].ss]);
    i = j + 1;
  }
  const W = colRes.length * RW, where = i => multi ? `${residues[i].chain}:${residues[i].num}` : residues[i].num;
  const sse = runs.map(([a, b, s]) => `<b class="${s}" data-a="${a}" data-b="${b}" title="${s === "H" ? "Helix" : "Strand"} ${where(a)}–${residues[b].num}" style="left:${posOf[a] * RW}px;width:${(b - a + 1) * RW}px"></b>`).join("");
  const aa = residues.map((r, i) => (multi && (i === 0 || r.chain !== residues[i - 1].chain) ? `<u>${esc(r.chain)}</u>` : "") +
    `<i title="${esc(r.name)} ${where(i)}">${r.aa}</i>`).join("");
  const nums = residues.map((r, i) => r.num % 10 === 0 ? `<span style="left:${posOf[i] * RW}px">${r.num}</span>` : "").join("");
  $("seqTrack").style.width = W + "px";
  $("seqTrack").innerHTML = `<div class="sse" style="width:${W}px">${sse}</div><div class="aa">${aa}</div><div class="num">${nums}</div>`;
  for (const b of $("pickSS").querySelectorAll("button")) b.disabled = !residues.some(r => r.ss === b.dataset.v);
  $("ligRow").hidden = !ligands.length;
  $("ligRow").innerHTML = ligands.map(l => `<button type="button" data-l="${l.i}" title="${esc(l.name)} ${l.num}, chain ${esc(l.chain)}${l.ion ? " (ion)" : `, ${l.atoms} atoms`}"><i></i>${esc(l.name)}<small>${view.chains().length > 1 ? esc(l.chain) + ":" : ""}${l.num}</small></button>`).join("");
  $("ligands").querySelectorAll("button").forEach(b => { b.disabled = !ligands.length; });
  $("ligands").title = ligands.length ? "Ligands and ions as sticks and balls, with the cartoon or the surface" : "No ligands in this structure";
  paintSequence(); showSelection(); renderLegend();
}
function paintSequence() {   // each letter in its residue's current colour, each ligand chip's dot in the ligand's
  const cols = view.residueColours(), lcols = view.ligandColours();
  $("seqTrack").querySelectorAll(".aa i").forEach((c, i) => { c.style.color = cols[i]; });
  $("ligRow").querySelectorAll("button").forEach((b, i) => { b.style.setProperty("--c", lcols[i]); });
}
function ranges() {          // the selection as residue-number ranges: "12–30, 45" (with chains: "A:12–30, B:45")
  const idx = [...sel].sort((a, b) => a - b), out = [];
  const name = i => multi ? `${residues[i].chain}:${residues[i].num}` : `${residues[i].num}`;
  for (let k = 0; k < idx.length;) {
    let j = k; while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1 && residues[idx[j + 1]].chain === residues[idx[k]].chain) j++;
    out.push(j > k ? `${name(idx[k])}–${residues[idx[j]].num}` : name(idx[k]));
    k = j + 1;
  }
  return out.length > 5 ? out.slice(0, 5).join(", ") + " …" : out.join(", ");
}
function showSelection() {
  $("seqTrack").querySelectorAll(".aa i").forEach((c, i) => c.classList.toggle("sel", sel.has(i)));
  $("ligRow").querySelectorAll("button").forEach((b, i) => b.classList.toggle("sel", lsel.has(i)));
  for (const b of $("pickSS").querySelectorAll("button")) b.classList.toggle("on", allOf(b.dataset.v));
  const n = sel.size + lsel.size, names = [...lsel].sort((a, b) => a - b).map(i => esc(ligands[i].name));
  $("selClear").hidden = !n;
  $("selLabel").hidden = !n;
  $("colourTarget").textContent = n ? `${n} selected` : "all";
  $("colourTarget").classList.toggle("sel", n > 0);
  $("selInfo").innerHTML = n ? `<b>${n}</b> selected (${[sel.size ? ranges() : "", ...names].filter(Boolean).join(", ")})` : "";
  if (scMode === "sel") syncSideChains();
}
const indexAt = e => { const r = $("seqTrack").getBoundingClientRect(); return colRes[Math.max(0, Math.min(colRes.length - 1, Math.floor((e.clientX - r.left) / RW)))]; };
$("seqTrack").addEventListener("pointerdown", e => {
  if (!residues.length || e.button !== 0) return;
  if (!(e.shiftKey || e.metaKey || e.ctrlKey)) { sel.clear(); lsel.clear(); }
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
$("selClear").onclick = () => { sel.clear(); lsel.clear(); showSelection(); };
// a ligand chip: click selects it alone, Shift (or ⌘ / Ctrl) adds or removes it
$("ligRow").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const i = +b.dataset.l, add = e.shiftKey || e.metaKey || e.ctrlKey;
  if (add) { if (lsel.has(i)) lsel.delete(i); else lsel.add(i); }
  else { const only = lsel.size === 1 && lsel.has(i) && !sel.size; sel.clear(); lsel.clear(); if (!only) lsel.add(i); }
  showSelection();
});

// ---------- labels: click a residue or ligand in the view to pin (or unpin) its label ----------
view.on("pick", hit => { if (hit) view.label(hit.kind, hit.i); });
view.on("labels", list => { $("labClear").hidden = !list.length; });
$("labClear").onclick = () => view.clearLabels();
$("selLabel").onclick = () => {   // label the whole selection (if all of it is labelled already, unlabel it)
  const items = [...[...sel].map(i => ["residue", i]), ...[...lsel].map(i => ["ligand", i])];
  const have = new Set(view.labels().map(l => l.kind + l.i)), all = items.every(([k, i]) => have.has(k + i));
  for (const [k, i] of items) view.label(k, i, !all);
};

// ---------- select by structure: every helix, strand or loop residue, then pick a colour ----------
// A click replaces the selection, Shift adds to it; clicking a type that's fully selected drops it.
const ofType = t => residues.flatMap((r, i) => r.ss === t ? [i] : []);
const allOf = t => { const idx = ofType(t); return idx.length > 0 && idx.every(i => sel.has(i)); };
$("pickSS").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  const t = b.dataset.v, idx = ofType(t);
  if (allOf(t)) idx.forEach(i => sel.delete(i));
  else { if (!e.shiftKey) { sel.clear(); lsel.clear(); } idx.forEach(i => sel.add(i)); }
  showSelection();
});
window.addEventListener("keydown", e => { if (e.key === "Escape" && (sel.size || lsel.size) && $("gifDlg").hidden) { sel.clear(); lsel.clear(); showSelection(); } });

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

// ---------- image export: a PNG at 1×, 2× or 4×, on paper or transparent ----------
const img = { scale: 2, bg: "paper", url: null };
function renderImage() {
  $("imgOut").innerHTML = "<p>Rendering…</p>";
  requestAnimationFrame(() => setTimeout(() => {     // let "Rendering…" show before the (blocking) render
    const url = view.snapshot({ scale: img.scale, transparent: img.bg === "none" });
    const name = `ascii-fold-${(view.info && (view.info.acc || view.info.title) || "protein").replace(/[^\w-]+/g, "_")}.png`;
    $("imgOut").innerHTML = `<img alt="The exported image" class="${img.bg === "none" ? "clear" : ""}" src="${url}"><p></p>`;
    const im = $("imgOut").querySelector("img");
    im.onload = () => { $("imgPx").textContent = `${im.naturalWidth} × ${im.naturalHeight}`; };
    $("imgSave").href = url; $("imgSave").download = name;
  }, 0));
}
seg("imgScale", v => { img.scale = +v; if (!$("imgDlg").hidden) renderImage(); });
seg("imgBg", v => { img.bg = v; if (!$("imgDlg").hidden) renderImage(); });
$("png").onclick = () => { $("imgDlg").hidden = false; renderImage(); $("imgSave").focus(); };
const imgClose = () => { $("imgDlg").hidden = true; $("imgOut").innerHTML = ""; $("imgSave").removeAttribute("href"); };
$("imgClose").onclick = imgClose;
$("imgDlg").onclick = e => { if (e.target === $("imgDlg")) imgClose(); };
window.addEventListener("keydown", e => { if (e.key === "Escape" && !$("imgDlg").hidden) imgClose(); });

// ---------- animation export: one seamless loop as a GIF or a video ----------
// The loop takes view.loopSeconds() at the current spin: a full turn, or one rock out and back.
const gif = { delay: 50, width: 720, fmt: "gif", url: null, ctrl: null };
const KB_PER_FRAME_720 = 57;                       // measured: ~3.4 MB for 60 frames at 720 px
const VIDEO_FPS = 30;
const gifFrames = () => Math.max(12, Math.round((view.loopSeconds() * 1000) / gif.delay));
function gifEstimate() {
  const secs = view.loopSeconds();
  $("gifTurnTime").textContent = secs.toFixed(1) + " s";
  if (gif.fmt === "video") {
    $("gifEst").textContent = `${secs.toFixed(1)} s loop · ${VIDEO_FPS} fps · recording takes as long as the loop`;
    return;
  }
  const n = gifFrames(), mb = (n * KB_PER_FRAME_720 * (gif.width / 720) ** 2) / 1024;
  $("gifEst").textContent = `${secs.toFixed(1)} s loop · ${n} frames · about ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB` +
    (mb > 15 ? " — large; try Light, a smaller width, or a faster spin" : "");
}
function setSpin(v) {                              // keeps the main slider, the dialog slider and the engine in step
  $("speed").value = v; $("gifSpin").value = Math.max(10, v);
  view.set({ spin: v / 100 }); gifEstimate();
}
$("gifSpin").oninput = e => setSpin(+e.target.value);
seg("gifFps", v => { gif.delay = +v; gifEstimate(); });
seg("gifSize", v => { gif.width = +v; gifEstimate(); });
seg("aniMotion", setMotion);
seg("aniFmt", v => { gif.fmt = v; $("gifFpsRow").hidden = v === "video"; gifReset(); gifEstimate(); });
function gifReset() {
  if (gif.url) URL.revokeObjectURL(gif.url);
  gif.url = null; $("gifOut").innerHTML = ""; $("gifSave").hidden = true; $("gifBar").style.width = "0";
  $("gifGo").textContent = "Record";
}
$("gifBtn").onclick = () => {
  gifReset();
  if (view.options.spin < 0.1) setSpin(35);          // an animation needs some motion: fall back to the default speed
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
  const video = gif.fmt === "video", secs = view.loopSeconds();
  try {
    const opts = { width: gif.width, signal: gif.ctrl && gif.ctrl.signal, onProgress: f => $("gifBar").style.width = (f * 100).toFixed(1) + "%" };
    const blob = video ? await view.recordVideo({ ...opts, fps: VIDEO_FPS }) : await view.recordGif({ ...opts, frames: gifFrames(), delay: gif.delay });
    const ext = blob.type === "image/gif" ? "gif" : blob.type === "video/mp4" ? "mp4" : "webm";
    gif.url = URL.createObjectURL(blob);
    const name = `ascii-fold-${(view.info && (view.info.acc || view.info.title) || "protein").replace(/[^\w-]+/g, "_")}.${ext}`;
    $("gifSave").href = gif.url; $("gifSave").download = name; $("gifSave").hidden = false;
    const what = video ? `${ext.toUpperCase()} · ${VIDEO_FPS} fps` : `${gifFrames()} frames`;
    $("gifOut").innerHTML = (video ? `<video src="${gif.url}" controls loop autoplay muted playsinline></video>`
      : `<img alt="Recorded GIF of the moving structure" src="${gif.url}">`) +
      `<p>${(blob.size / 1048576).toFixed(1)} MB · ${what} · ${secs.toFixed(1)} s</p>`;
  } catch (e) {
    if (e.name !== "AbortError") $("gifOut").innerHTML = `<p>Couldn't record: ${esc(e.message)}</p>`;
  } finally {
    gif.ctrl = null; $("gifGo").disabled = false; $("gifGo").textContent = "Record again";
  }
};

// ---------- saved views: everything about the picture, as a small .json file ----------
// The structure itself isn't saved: open the same file, then the view.
$("viewSave").onclick = () => {
  const v = view.getView(); if (!v) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(v, null, 1)], { type: "application/json" }));
  a.download = `ascii-fold-view-${(view.info && (view.info.acc || view.info.title) || "protein").replace(/[^\w-]+/g, "_")}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("viewOpen").onclick = () => $("viewFile").click();
$("viewFile").onchange = e => { const f = e.target.files[0]; if (f) loadView(f); e.target.value = ""; };
const markSeg = (id, v) => $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
function syncUI() {   // every control from the view's current options
  const o = view.options, sh = o.shape;
  document.body.classList.toggle("night", o.theme === "night");
  markSeg("theme", o.theme);
  markSeg("surface", o.surface ? "on" : o.glass ? "glass" : "off"); $("glassRow").hidden = o.surface || !o.glass;
  $("glassOp").value = Math.round(o.glassOpacity * 100);
  markSeg("ligands", o.ligands ? "on" : "off");
  for (const id of ["layout", "detail", "glyphs"]) markSeg(id, o[id]);
  markSeg("faces", o.faces ? "on" : "off"); markSeg("motion", o.motion); markSeg("aniMotion", o.motion);
  $("speed").value = Math.round(o.spin * 100); $("persp").value = Math.round(o.perspective * 100); $("depth").value = Math.round(o.depth * 100);
  for (const k of ["hW", "hT", "flat", "sW", "sT", "head", "coilR"]) $(k).value = Math.round(sh[k] * 100);
  markSeg("arrows", sh.arrows ? "on" : "off"); syncShapeUI();
  markColour(o.colour);
}
async function loadView(f) {
  try {
    const v = JSON.parse(await f.text()), tally = view.setView(v);
    syncUI(); buildChains(); buildSequence();
    // side chains: all, none, or the saved residues as the selection ("Selected")
    const keys = new Set(Array.isArray(v.sideChains) ? v.sideChains : []);
    scMode = v.sideChains === "all" ? "all" : keys.size ? "sel" : "off";
    residues.forEach((r, i) => { if (keys.has(`${r.chain}:${r.num}`)) sel.add(i); });
    markSeg("sidechains", scMode); syncSideChains(); showSelection();
    custom = !!((v.residueColours || []).length || (v.ligandColours || []).length); $("colReset").hidden = !custom;
    renderLegend(); paintSequence();
    status(tally.missed ? `View opened; ${tally.missed} of its residues, ligands or labels aren't in this structure.` : "");
  } catch (e) { status(`Couldn't open the view ${esc(f.name)}: ${esc(e.message)}`, true); }
}

// ---------- start ----------
markColour(view.options.colour);
renderLegend();
view.loadDefault();
