// The full-page app (index.html): wires the toolbar and panels to one engine view.
import { createAsciiFold, COLOURS } from "./engine.js";
import { SHAPE_DEFAULT } from "./geometry.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const RANDOM_POOL = [
  "P42212", "P00698", "P69905", "P68871", "P04637", "P01116", "P00533", "P07900", "P02768", "P05067",
  "P38398", "P0DP23", "P62988", "P00760", "P01308", "P10636", "Q9BYF1", "P35222", "P61626",
];

const view = createAsciiFold($("stage"));
window.asciiFold = view;   // handy from the console: asciiFold.set({ spin: 0 }), asciiFold.snapshot() …

// ---------- header, status, credit ----------
function status(msg, err = false) { $("status").innerHTML = msg; $("status").classList.toggle("err", err); }
view.on("load", info => {
  $("title").textContent = info.title;
  const bits = [info.sub, `${info.residues} residues`];
  if (info.hasPlddt) bits.push(`mean pLDDT ${info.meanPlddt.toFixed(1)}`);
  if (info.ssFromGeometry) bits.push("SS from Cα geometry");
  $("sub").textContent = bits.filter(Boolean).join(" · ");
  $("plddtBtn").disabled = !info.hasPlddt;
  if (!info.hasPlddt && view.options.colour === "plddt") setSeg("colour", "ss");
  $("credit").innerHTML = info.entryUrl
    ? `Structure: <a href="${info.entryUrl}" target="_blank" rel="noopener">AlphaFold DB</a> (CC BY 4.0)`
    : info.hasPlddt ? "Structure: AlphaFold DB (CC BY 4.0)" : "";
});
view.on("zoom", z => $("zval").textContent = z.toFixed(1) + "×");

// ---------- loading ----------
async function loadAccession(raw) {
  status(`Fetching ${esc(raw.trim().toUpperCase())} from AlphaFold DB…`);
  try {
    const info = await view.loadAccession(raw);
    if (!info) return;
    $("acc").value = info.acc;
    status(`Loaded <a href="${info.entryUrl}" target="_blank" rel="noopener">AF-${esc(info.acc)}</a> from AlphaFold DB.`);
    try { history.replaceState(null, "", "#" + info.acc); } catch {}
  } catch (e) {
    if (e.name === "AbortError") return;
    if (e.kind === "network")
      status(`${esc(e.message)} Download the model from <a href="https://alphafold.ebi.ac.uk/entry/${esc(e.acc)}" target="_blank" rel="noopener">the ${esc(e.acc)} entry</a> and drop the .pdb or .cif file here.`, true);
    else status(esc(e.message), true);
  }
}
async function loadFile(f) {
  try { const info = await view.loadFile(f); if (info) status(`Loaded ${esc(f.name)}.`); }
  catch (e) { status(`Couldn't read ${esc(f.name)}: ${esc(e.message)}`, true); }
}

$("form").onsubmit = e => { e.preventDefault(); loadAccession($("acc").value); };
$("rand").onclick = () => {
  let pick; do { pick = RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)]; } while (pick === $("acc").value);
  $("acc").value = pick; loadAccession(pick);
};
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
  if (id === "colour") $("swatches").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.v === v));
  handlers[id](v);
}
function seg(id, fn) {
  handlers[id] = fn;
  $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; setSeg(id, b.dataset.v); });
}
function renderLegend() {
  const p = view.palette(), c = view.options.colour;
  const solid = COLOURS.find(([n]) => n === c);
  const items = c === "ss" ? [["Helix", p.H], ["Strand", p.E], ["Coil", p.C]]
    : c === "plddt" ? [[">90", p.P[0]], ["70–90", p.P[1]], ["50–70", p.P[2]], ["<50", p.P[3]]] : solid ? [solid] : [];
  $("legend").innerHTML = items.map(([t, col]) => `<span style="--sw:${col}">${t}</span>`).join("");
}
seg("layout", v => view.set({ layout: v }));
seg("text", v => view.set({ text: v }));
seg("lighting", v => view.set({ lighting: v }));
seg("surface", v => view.set({ surface: v === "on" }));
$("persp").oninput = e => view.set({ perspective: e.target.value / 100 });
seg("seam", v => view.set({ seam: v }));
seg("colour", v => { view.set({ colour: v }); renderLegend(); });
// one-colour swatches, ChimeraX style; they share the colour control's handler and highlight
$("swatches").innerHTML = COLOURS.map(([n, h]) => `<button type="button" data-v="${n}" title="${n}" aria-label="${n}" style="--c:${h}"></button>`).join("");
$("swatches").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setSeg("colour", b.dataset.v); });
seg("theme", v => { document.body.classList.toggle("night", v === "night"); view.set({ theme: v }); renderLegend(); });
seg("glyphs", v => view.set({ glyphs: v }));
seg("detail", v => view.set({ detail: v }));
$("speed").oninput = e => setSpin(+e.target.value);
$("f0").oninput = e => view.set({ blendFrom: e.target.value / 100 });
$("f1").oninput = e => view.set({ blendTo: e.target.value / 100 });

// ---------- zoom ----------
$("zin").onclick = () => view.zoomBy(1.25);
$("zout").onclick = () => view.zoomBy(0.8);
$("zfit").onclick = () => view.resetView();
window.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "+" || e.key === "=") view.zoomBy(1.25);
  else if (e.key === "-" || e.key === "_") view.zoomBy(0.8);
  else if (e.key === "0") view.resetView();
});

// ---------- shape panel ----------
let rebuildQueued = null;
function shape(partial) {          // coalesce slider drags into one rebuild per frame
  rebuildQueued = { ...(rebuildQueued || {}), ...partial };
  requestAnimationFrame(() => { if (rebuildQueued) { view.setShape(rebuildQueued); rebuildQueued = null; } });
}
const isCyl = () => view.options.shape.hStyle === "cylinder";
const SLIDERS = {
  hW: v => shape(isCyl() ? { cylR: v / 100 * 1.7 } : { hW: v / 100 }),
  hT: v => shape({ hT: v / 100 }), flat: v => shape({ flat: v / 100 }), sW: v => shape({ sW: v / 100 }),
  sT: v => shape({ sT: v / 100 }), head: v => shape({ head: v / 100 }), coilR: v => shape({ coilR: v / 100 }),
};
for (const [id, fn] of Object.entries(SLIDERS)) $(id).addEventListener("input", e => fn(+e.target.value));
function syncShapeUI() {
  const s = view.options.shape, cyl = s.hStyle === "cylinder";
  $("hW").value = Math.round((cyl ? s.cylR / 1.7 : s.hW) * 100);
  $("hTwrap").classList.toggle("off", cyl);
  $("headWrap").classList.toggle("off", !s.arrows);
}
seg("hStyle", v => { view.setShape({ hStyle: v }); syncShapeUI(); });
seg("arrows", v => { view.setShape({ arrows: v === "on" }); syncShapeUI(); });
$("shapeReset").onclick = () => {
  view.resetShape();
  const d = SHAPE_DEFAULT;
  for (const [id, v] of Object.entries({ hT: d.hT, flat: d.flat, sW: d.sW, sT: d.sT, head: d.head, coilR: d.coilR })) $(id).value = Math.round(v * 100);
  setSeg("hStyle", "ribbon"); setSeg("arrows", "on");
};
$("shapeBtn").onclick = () => {
  const closed = $("shape").classList.toggle("closed");
  $("shapeBtn").textContent = closed ? "Shape ▸" : "Shape ▾";
  $("shapeBtn").setAttribute("aria-expanded", String(!closed));
};

// ---------- export ----------
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(view.text()); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Copy blocked"; }
  setTimeout(() => $("copy").textContent = "Copy text", 1400);
};
$("png").onclick = () => { $("snap").querySelector("img").src = view.snapshot(); $("snap").hidden = false; };
$("snap").onclick = e => { if (e.target === $("snap")) $("snap").hidden = true; };

// ---------- share ----------
function shareUrl() {
  const base = location.href.split("#")[0];
  return view.info && view.info.acc ? `${base}#${view.info.acc}` : base;
}
$("share").onclick = async () => {
  const url = shareUrl(), title = `${view.info ? view.info.title : "Protein"} — ASCII Fold`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    $("share").textContent = "Link copied";
  } catch (e) {
    if (e.name === "AbortError") return;
    status(`Share link: <a href="${esc(url)}">${esc(url)}</a>`);
  }
  setTimeout(() => $("share").textContent = "Share", 1600);
};

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
renderLegend();
view.loadDefault();
status("Enter a UniProt accession, hit Random, or drop an AlphaFold .pdb / .cif file.");
let startAcc = "";
try { startAcc = decodeURIComponent(location.hash.slice(1)); } catch {}
if (startAcc) { $("acc").value = startAcc.toUpperCase(); loadAccession(startAcc); }
window.addEventListener("hashchange", () => {
  let a = ""; try { a = decodeURIComponent(location.hash.slice(1)); } catch {}
  if (a && a.toUpperCase() !== (view.info && view.info.acc)) { $("acc").value = a.toUpperCase(); loadAccession(a); }
});
