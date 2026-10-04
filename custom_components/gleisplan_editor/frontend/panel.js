/* Panel für die Seitenleiste von Home Assistant: zeigt den Editor (index.html) in
   einem iframe und reicht das hass-Objekt hinein. Editor und Home Assistant haben
   denselben Origin, deshalb genügt ein direkter Funktionsaufruf – ohne Token. */

const EDITOR_URL = new URL("index.html", import.meta.url);
EDITOR_URL.search = new URL(import.meta.url).search; // ?v=… der Integration weitergeben

class GleisplanEditorPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._frame = null;
    this._host = {
      toggleMenu: () => this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }))
    };
  }

  set hass(hass) { this._hass = hass; this._push(); }
  set narrow(narrow) { this._narrow = narrow; this._push(); }

  connectedCallback() {
    if (this._frame) return;
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host { display: block; height: 100vh; height: 100dvh; }" +
      "iframe { display: block; width: 100%; height: 100%; border: 0; }";
    this._frame = document.createElement("iframe");
    this._frame.title = "Gleisplan-Editor";
    this._frame.addEventListener("load", () => this._push());
    this._frame.src = EDITOR_URL.href;
    root.append(style, this._frame);
  }

  _push() {
    const win = this._frame && this._frame.contentWindow;
    if (!this._hass || !win || typeof win.gleisplanSetHass !== "function") return;
    this._host.narrow = this._narrow;
    win.gleisplanSetHass(this._hass, this._host);
  }
}

customElements.define("gleisplan-editor-panel", GleisplanEditorPanel);
