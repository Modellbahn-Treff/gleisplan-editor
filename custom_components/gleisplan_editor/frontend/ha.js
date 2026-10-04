"use strict";

/* =====================================================================
   Home-Assistant-Anbindung
   Nur aktiv, wenn der Editor als Panel in Home Assistant läuft: panel.js ruft
   dann gleisplanSetHass() mit dem hass-Objekt auf – und bei jeder
   Zustandsänderung in Home Assistant erneut. Ohne diesen Aufruf (index.html
   per Doppelklick geöffnet) bleibt alles hier wirkungslos und der Editor
   arbeitet wie bisher nur mit localStorage und Dateien.

   Wird vor app.js geladen; greift erst zur Laufzeit auf dessen Funktionen zu.
   ===================================================================== */

const ha = (() => {
  const $ = id => document.getElementById(id);
  const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  let hass = null;
  let host = null; // {narrow, toggleMenu()} aus panel.js

  const ws = (type, data) => hass.callWS(Object.assign({ type: "gleisplan_editor/" + type }, data));
  const errText = err => (err && (err.message || err.code)) || String(err);

  /* ---------- Live-Zustände ---------- */
  function entityState(entity) {
    const s = hass && entity && hass.states[entity];
    return s ? s.state : null;
  }
  function isOn(entity) { return entityState(entity) === "on"; }

  // Dieselbe Zuordnung wie in den Regeln der exportierten YAML
  function liveClass(kind, entity) {
    const s = entityState(entity);
    if (s !== "on" && s !== "off") return "";
    if (kind === "turnout") return s === "on" ? " turnout-diverging" : " turnout-straight";
    return s === "on" ? " signal-green" : " signal-red";
  }

  /* hass kommt bei jeder Zustandsänderung irgendeiner Entity neu – gezeichnet wird
     nur, wenn sich eine im Plan verwendete Entity geändert hat. Das Eigenschaften-
     Formular wird dabei nicht neu aufgebaut, damit Eingaben den Fokus behalten. */
  let liveSignature = "";
  function refreshLive() {
    const parts = [];
    [state.nodes, state.signals, state.blocks].forEach(coll =>
      Object.values(coll).forEach(o => { if (o.entity) parts.push(o.entity + "=" + entityState(o.entity)); }));
    const signature = parts.join("|");
    if (signature === liveSignature) return;
    liveSignature = signature;
    renderNodes();
    renderSignals();
    renderBlockList();
    document.querySelectorAll(".ha-state").forEach(fillStateHint);
  }

  /* ---------- Entity-Felder ---------- */
  // Vorschlagslisten je Domänen-Auswahl; passende Domänen stehen vorn, der Rest folgt
  const entityLists = {};
  function entityListId(domains) {
    const key = domains.join("-");
    const ids = Object.keys(hass.states);
    let list = entityLists[key];
    if (!list) {
      list = entityLists[key] = { el: document.createElement("datalist"), count: -1 };
      list.el.id = "haEntities-" + key;
      document.body.appendChild(list.el);
    }
    if (list.count !== ids.length) {
      list.count = ids.length;
      const preferred = id => domains.includes(id.slice(0, id.indexOf(".")));
      ids.sort((a, b) => (preferred(b) - preferred(a)) || a.localeCompare(b));
      list.el.textContent = "";
      ids.forEach(id => {
        const option = document.createElement("option");
        option.value = id;
        const name = hass.states[id].attributes.friendly_name;
        if (name) option.label = name;
        list.el.appendChild(option);
      });
    }
    return list.el.id;
  }

  function fillStateHint(line) {
    const entity = line.dataset.entity;
    const s = entity && hass.states[entity];
    line.classList.toggle("missing", !!entity && !s);
    if (!entity) line.textContent = "";
    else if (!s) line.textContent = "Entity in Home Assistant nicht gefunden.";
    else line.textContent = `Aktueller Zustand: ${s.state}` + (s.attributes.friendly_name ? ` (${s.attributes.friendly_name})` : "");
  }

  function decorateEntityField(wrap, input, entity, domains) {
    if (!hass) return;
    input.setAttribute("list", entityListId(domains));
    const line = document.createElement("div");
    line.className = "hint ha-state";
    line.dataset.entity = entity || "";
    wrap.appendChild(line);
    fillStateHint(line);
  }

  // Weiche direkt aus dem Editor schalten, um die Zuordnung zu prüfen
  function toggleButton(entity) {
    if (!hass || !entity || !hass.states[entity]) return null;
    const btn = document.createElement("button");
    btn.className = "wide";
    btn.style.marginBottom = "10px";
    btn.textContent = "Weiche schalten (Test)";
    btn.addEventListener("click", () => {
      hass.callService("homeassistant", "toggle", { entity_id: entity })
        .catch(err => showToast("Schalten fehlgeschlagen: " + errText(err)));
    });
    return btn;
  }

  /* ---------- Pläne in Home Assistant ----------
     Der geöffnete Plan wird nach jeder Änderung automatisch gespeichert. Der
     localStorage bleibt Zwischenspeicher; beim Start gilt der Stand aus Home
     Assistant, damit derselbe Plan auf jedem Gerät gleich aussieht. */
  const knownPlans = new Set(); // IDs, die es in Home Assistant gibt
  let ready = false;            // erst nach dem ersten Abgleich automatisch speichern
  let savedJson = null;         // zuletzt gespeicherter bzw. geladener Stand
  let saveTimer = 0;

  function setStatus(text) { $("haStatus").textContent = text; }

  function planChanged() {
    if (!hass) return;
    const nameInput = $("haPlanName");
    if (document.activeElement !== nameInput) nameInput.value = state.name || "";
    if (!ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePlan, 800);
  }

  async function savePlan() {
    clearTimeout(saveTimer);
    if (!hass || !ready) return;
    if (!PLAN_ID_RE.test(state.planId)) state.planId = uid(); // z.B. aus einer fremden JSON-Datei
    const id = state.planId;
    const json = JSON.stringify(state);
    if (json === savedJson) { setStatus("In Home Assistant gespeichert"); return; }
    // Leere Pläne, die es in Home Assistant noch nicht gibt, nicht anlegen
    if (!knownPlans.has(id) && !Object.keys(state.nodes).length) { setStatus(""); return; }
    setStatus("Speichert …");
    try {
      await ws("plans/save", { plan_id: id, name: state.name || "", data: JSON.parse(json) });
      knownPlans.add(id);
      savedJson = json;
      setStatus("In Home Assistant gespeichert");
    } catch (err) {
      setStatus("Speichern fehlgeschlagen");
      showToast("Speichern in Home Assistant fehlgeschlagen: " + errText(err));
    }
  }

  async function loadPlan(id) {
    const plan = await ws("plans/get", { plan_id: id });
    openPlan(Object.assign({}, plan.data, { planId: plan.id, name: plan.name }));
    savedJson = JSON.stringify(state);
    helpOverlay.hidden = true;
    setStatus("In Home Assistant gespeichert");
  }

  async function connect() {
    document.body.classList.add("in-ha");
    $("haBar").hidden = false;
    $("btnHaPublish").hidden = false;
    renderAll(); // Entity-Felder und Live-Zustände einblenden
    try {
      const plans = await ws("plans/list");
      plans.forEach(p => knownPlans.add(p.id));
      if (knownPlans.has(state.planId)) {
        await loadPlan(state.planId);
      } else if (!Object.keys(state.nodes).length && plans.length) {
        // Neues Gerät/neuer Browser: den zuletzt bearbeiteten Plan öffnen
        plans.sort((a, b) => (a.updated < b.updated ? 1 : -1));
        await loadPlan(plans[0].id);
      }
      ready = true;
      await savePlan(); // lokaler Plan, den es in Home Assistant noch nicht gibt
    } catch (err) {
      setStatus("Plan-Speicher nicht erreichbar");
      showToast("Pläne konnten nicht aus Home Assistant geladen werden: " + errText(err));
    }
  }

  function setHass(newHass, newHost) {
    const first = !hass;
    hass = newHass;
    host = newHost || {};
    $("btnHaMenu").hidden = !(host.narrow || hass.dockedSidebar === "always_hidden");
    if (first) connect();
    refreshLive();
  }

  /* ---------- Dialog: Pläne ---------- */
  const plansOverlay = $("haPlansOverlay");
  const publishOverlay = $("haPublishOverlay");
  const overlays = [plansOverlay, publishOverlay];

  function dialogOpen() { return overlays.some(o => !o.hidden); }
  function closeDialog() {
    const open = overlays.filter(o => !o.hidden);
    open.forEach(o => { o.hidden = true; });
    return open.length > 0;
  }
  overlays.forEach(o => o.addEventListener("click", ev => { if (ev.target === o) o.hidden = true; }));

  async function showPlans() {
    try {
      await savePlan();
      const plans = await ws("plans/list");
      plans.sort((a, b) => (a.updated < b.updated ? 1 : -1));
      const listEl = $("haPlanList");
      listEl.textContent = "";
      if (!plans.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "Noch keine Pläne gespeichert. Ein Plan wird gespeichert, sobald er ein Element enthält.";
        listEl.appendChild(li);
      }
      plans.forEach(plan => {
        const current = plan.id === state.planId;
        const li = document.createElement("li");
        const info = document.createElement("div");
        info.className = "plan-info";
        const name = document.createElement("div");
        name.textContent = (plan.name || "Ohne Namen") + (current ? " (geöffnet)" : "");
        const date = document.createElement("div");
        date.className = "hint";
        date.textContent = "Geändert: " + new Date(plan.updated).toLocaleString("de-DE");
        info.append(name, date);
        const openBtn = document.createElement("button");
        openBtn.textContent = "Öffnen";
        openBtn.disabled = current;
        openBtn.addEventListener("click", () => switchPlan(plan.id));
        const delBtn = document.createElement("button");
        delBtn.textContent = "Löschen";
        delBtn.addEventListener("click", () => deletePlan(plan));
        li.append(info, openBtn, delBtn);
        listEl.appendChild(li);
      });
      plansOverlay.hidden = false;
    } catch (err) {
      showToast("Pläne konnten nicht geladen werden: " + errText(err));
    }
  }

  async function switchPlan(id) {
    try {
      await savePlan();
      await loadPlan(id);
      plansOverlay.hidden = true;
    } catch (err) {
      showToast("Plan konnte nicht geöffnet werden: " + errText(err));
    }
  }

  async function deletePlan(plan) {
    const label = plan.name || "Ohne Namen";
    if (!confirm(`Plan „${label}“ in Home Assistant löschen?\nBereits veröffentlichte Dateien in www/floorplan bleiben erhalten.`)) return;
    try {
      clearTimeout(saveTimer);
      await ws("plans/delete", { plan_id: plan.id });
      knownPlans.delete(plan.id);
      if (plan.id === state.planId) { savedJson = null; openPlan(emptyState()); }
      await showPlans();
    } catch (err) {
      showToast("Plan konnte nicht gelöscht werden: " + errText(err));
    }
  }

  /* ---------- Veröffentlichen ----------
     Schreibt SVG und CSS nach <config>/www/floorplan. Der Dateiname folgt dem
     Plannamen, damit mehrere Pläne (über Links verbunden) nebeneinander liegen. */
  function fileBase() {
    const base = (state.name || "").toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
    return base || "gleisplan";
  }

  async function publish() {
    const base = fileBase();
    try {
      const res = await ws("publish", { name: base, svg: exportSvgXml(), css: buildCss() });
      $("haPublishSummary").textContent = `Geschrieben: ${res.svg_url} und ${res.css_url}`;
      $("haPublishHint").textContent =
        (res.restart_required ? "Der Ordner www wurde gerade erst angelegt – Home Assistant einmal neu starten, damit /local erreichbar ist. " : "") +
        "Beim ersten Mal die folgende Karte in ein Dashboard einfügen (Karte hinzufügen → Manuell). " +
        "Danach genügt erneutes Veröffentlichen, solange sich keine Entities, Element-IDs oder Link-Ziele ändern – sonst die Karte neu einfügen.";
      $("haPublishYaml").value = buildYaml(base);
      publishOverlay.hidden = false;
    } catch (err) {
      showToast("Veröffentlichen fehlgeschlagen: " + errText(err));
    }
  }

  async function copyYaml() {
    const area = $("haPublishYaml");
    area.select();
    try {
      // Ohne HTTPS gibt es navigator.clipboard nicht – dann über die Textauswahl kopieren
      if (navigator.clipboard) await navigator.clipboard.writeText(area.value);
      else document.execCommand("copy");
      showToast("YAML kopiert");
    } catch (err) {
      showToast("Kopieren nicht möglich – Text ist markiert, bitte Strg/Cmd+C drücken");
    }
  }

  $("btnHaMenu").addEventListener("click", () => { if (host && host.toggleMenu) host.toggleMenu(); });
  $("haPlanName").addEventListener("change", ev => { state.name = ev.target.value.trim(); renderAll(); });
  $("btnHaPlans").addEventListener("click", showPlans);
  $("btnHaPlansClose").addEventListener("click", closeDialog);
  $("btnHaPublish").addEventListener("click", publish);
  $("btnHaCopyYaml").addEventListener("click", copyYaml);
  $("btnHaPublishClose").addEventListener("click", closeDialog);
  window.addEventListener("pagehide", () => { savePlan(); });

  return {
    get connected() { return !!hass; },
    setHass, liveClass, isOn, decorateEntityField, toggleButton,
    planChanged, flush: savePlan, dialogOpen, closeDialog
  };
})();

window.gleisplanSetHass = ha.setHass;
