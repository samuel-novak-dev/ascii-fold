import { createAsciiFold } from "./engine.js";

// <ascii-fold accession="P04637" theme="night" colour="plddt" style="height: 420px"></ascii-fold>
//
// Attributes (all optional):
//   accession     UniProt accession to fetch from AlphaFold DB
//   src           URL of a .pdb / .cif file to load instead (must be CORS-readable)
//   theme         paper | night                      colour      ss | plddt | a ChimeraX colour name or hex
//   layout        lr | rl | ascii | ribbon
//   text          3d | flat                          perspective 0–1 (default 0.5; 0 = orthographic)
//   surface       show the molecular surface instead of the cartoon (attribute present = on)
//   glyphs        classic | blocks | geo | <custom ramp, light → dark>
//   detail        xcoarse | coarse | medium | <rows>
//   spin          rotation speed, 0–1 (default 0.35; 0 if the visitor prefers reduced motion)
//   blend-from / blend-to   where the text→ribbon blend starts/ends, 0–1
//   helix-style   ribbon | cylinder
//   interactive   "false" disables drag / zoom
//   transparent   no background fill
//   no-credit     hide the AlphaFold DB attribution (please credit it elsewhere if you do)
//   no-font       don't load JetBrains Mono from Google Fonts
//
// Events: "fold-load" (detail = info), "fold-error" (detail = Error). Property: .view (engine API).

const OPTION_ATTRS = {
  theme: v => ({ theme: v }), colour: v => ({ colour: v }), color: v => ({ colour: v }), layout: v => ({ layout: v }),
  glyphs: v => ({ glyphs: v }),
  text: v => ({ text: v === "flat" ? "flat" : "3d" }),
  surface: v => ({ surface: v !== null && v !== "false" }),
  perspective: v => ({ perspective: Math.max(0, Math.min(1, parseFloat(v) || 0)) }),
  detail: v => ({ detail: /^\d+$/.test(v) ? +v : v }),
  spin: v => ({ spin: parseFloat(v) || 0 }),
  "blend-from": v => ({ blendFrom: parseFloat(v) }), "blend-to": v => ({ blendTo: parseFloat(v) }),
  "helix-style": v => ({ shape: { hStyle: v } }),
  interactive: v => ({ interactive: v !== "false" }),
  transparent: v => ({ background: v === null }),
};

let fontRequested = false;
function requestFont() {
  if (fontRequested || document.querySelector('link[href*="family=JetBrains+Mono"]')) return;
  fontRequested = true;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap";
  document.head.append(l);
}

export class AsciiFoldElement extends HTMLElement {
  static get observedAttributes() { return ["accession", "src", ...Object.keys(OPTION_ATTRS)]; }

  constructor() {
    super();
    const sr = this.attachShadow({ mode: "open" });
    sr.innerHTML = `<style>
      :host { display: block; position: relative; height: 360px; contain: content; }
      :host([hidden]) { display: none; }
      .stage { position: absolute; inset: 0; }
      .credit { position: absolute; right: 8px; bottom: 6px; font: 10px/1.2 system-ui, sans-serif; opacity: .7; z-index: 1; }
      .credit a { color: inherit; }
      .err { position: absolute; left: 8px; bottom: 6px; font: 11px/1.3 system-ui, sans-serif; color: #D33A2C; z-index: 1; max-width: 70%; }
    </style><div class="stage" part="stage"></div><div class="credit" part="credit"></div><div class="err" part="error"></div>`;
    this._stage = sr.querySelector(".stage");
    this._credit = sr.querySelector(".credit");
    this._err = sr.querySelector(".err");
    this.view = null;
  }

  _options() {
    const opts = {}, shape = {};
    for (const [attr, fn] of Object.entries(OPTION_ATTRS)) {
      const v = this.getAttribute(attr);
      if (v === null && attr !== "transparent") continue;
      const o = fn(v);
      if (o.shape) Object.assign(shape, o.shape); else Object.assign(opts, o);
    }
    if (Object.keys(shape).length) opts.shape = shape;
    return opts;
  }

  connectedCallback() {
    if (this.view) return;
    if (!this.hasAttribute("no-font")) requestFont();
    this.view = createAsciiFold(this._stage, this._options());
    this.view.on("load", info => {
      const p = this.view.palette();
      this._credit.style.color = p.ink;
      this._credit.innerHTML = this.hasAttribute("no-credit") || !info.hasPlddt ? ""
        : info.entryUrl ? `<a href="${info.entryUrl}" target="_blank" rel="noopener">AlphaFold DB</a> · CC BY 4.0` : "AlphaFold DB · CC BY 4.0";
      this.dispatchEvent(new CustomEvent("fold-load", { detail: info }));
    });
    this._load();
  }

  disconnectedCallback() { if (this.view) { this.view.destroy(); this.view = null; } }

  attributeChangedCallback(name, oldV, newV) {
    if (!this.view || oldV === newV) return;
    if (name === "accession" || name === "src") { this._load(); return; }
    if (OPTION_ATTRS[name]) {
      const o = OPTION_ATTRS[name](newV);
      if (o.shape) this.view.setShape(o.shape); else this.view.set(o);
      if (name === "theme") this._credit.style.color = this.view.palette().ink;
    }
  }

  async _load() {
    this._err.textContent = "";
    const src = this.getAttribute("src"), acc = this.getAttribute("accession");
    try {
      if (src) {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`${src} returned ${r.status}`);
        const name = src.split("/").pop().split("?")[0];
        this.view.loadText(await r.text(), { title: name, sub: name });
      } else if (acc) await this.view.loadAccession(acc);
      else this.view.loadDefault();
    } catch (e) {
      if (e.name === "AbortError") return;
      this._err.textContent = e.message;
      if (!this.view.info) this.view.loadDefault();
      this.dispatchEvent(new CustomEvent("fold-error", { detail: e }));
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ascii-fold")) customElements.define("ascii-fold", AsciiFoldElement);
