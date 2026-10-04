"use strict";

/* =====================================================================
   Datenmodell
   - nodes: Weichen/Kreuzung/Prellbock/Link (feste Anschlüsse "Ports") sowie
     "joint"-Knoten (freie Verbindungspunkte ohne feste Richtung).
   - edges: verbinden je zwei Ports (oder Joints). Die Form der Kante
     wird automatisch als glatte Kurve zwischen den beiden Anschluss-
     richtungen berechnet ("Gleis formt sich von selbst").
   - signals: sitzen an einer Position (t) entlang einer Kante.
   - blocks: fassen mehrere Kanten zu einem Blockabschnitt zusammen.
   ===================================================================== */

const NS = "http://www.w3.org/2000/svg";
const GRID_SNAP = 20;
const STORAGE_KEY = "gleisplan-editor-state-v2";
const VIEW_STORAGE_KEY = "gleisplan-editor-view";
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;

const TURNOUT_TYPES = new Set(["turnout_l", "turnout_r", "turnout_y"]);
const FIXED_PORT_TYPES = new Set(["straight", "turnout_l", "turnout_r", "turnout_y", "cross", "buffer", "link"]);

const BLOCK_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#00acc1", "#c0ca33", "#d81b60"];

const TOOL_LABELS = {
  straight: "Gerade", turnout_l: "Weiche links", turnout_r: "Weiche rechts", turnout_y: "3-Weg-Weiche",
  cross: "Kreuzung", buffer: "Prellbock", link: "Link"
};

let state = {
  nodes: {},   // id -> {id,type,x,y,rot,entity,label} (Link zusätzlich: target)
  edges: {},   // id -> {id, a:{node,port}, b:{node,port}}
  signals: {}, // id -> {id, edge, t, side, entity, label}
  blocks: {},  // id -> {id, name, entity, color, edges:[edgeId,...], nodes:[nodeId,...]}
  counters: { straight: 0, turnout: 0, cross: 0, buffer: 0, link: 0, joint: 0, signal: 0, block: 0 }
};

let currentTool = "select";
let activeBlockId = null;
let snapEnabled = true;

/* ---------- Auswahl ----------
   Mehrfachauswahl über Knoten, Kanten und Signale. Ein Block wird nur einzeln
   (über die Liste rechts) ausgewählt und schließt die übrige Auswahl aus. */
const selection = { nodes: new Set(), edges: new Set(), signals: new Set(), block: null };
const SEL_SETS = { node: "nodes", edge: "edges", signal: "signals" };

function clearSelection() {
  selection.nodes.clear(); selection.edges.clear(); selection.signals.clear();
  selection.block = null;
}
function isSelected(kind, key) {
  return kind === "block" ? selection.block === key : selection[SEL_SETS[kind]].has(key);
}
function selectOnly(kind, key) {
  clearSelection();
  if (kind === "block") selection.block = key; else selection[SEL_SETS[kind]].add(key);
}
function toggleSelected(kind, key) {
  selection.block = null;
  const set = selection[SEL_SETS[kind]];
  if (set.has(key)) set.delete(key); else set.add(key);
}
function selectionCount() {
  return selection.nodes.size + selection.edges.size + selection.signals.size + (selection.block ? 1 : 0);
}
// {kind,key}, wenn genau ein Element ausgewählt ist – sonst null
function singleSelection() {
  if (selectionCount() !== 1) return null;
  if (selection.block) return { kind: "block", key: selection.block };
  for (const kind in SEL_SETS) {
    const set = selection[SEL_SETS[kind]];
    if (set.size) return { kind, key: set.values().next().value };
  }
  return null;
}
// Kanten, deren beide Enden ausgewählt sind, gehören mit zur Auswahl
function selectEdgesBetweenSelectedNodes() {
  Object.values(state.edges).forEach(e => {
    if (selection.nodes.has(e.a.node) && selection.nodes.has(e.b.node)) selection.edges.add(e.id);
  });
}
function selectAll() {
  clearSelection();
  Object.keys(state.nodes).forEach(id => selection.nodes.add(id));
  Object.keys(state.edges).forEach(id => selection.edges.add(id));
  Object.keys(state.signals).forEach(id => selection.signals.add(id));
}
// Verweise auf inzwischen gelöschte Elemente entfernen (Löschen, Undo, Laden …)
function pruneSelection() {
  for (const kind in SEL_SETS) {
    const set = selection[SEL_SETS[kind]];
    const coll = state[SEL_SETS[kind]];
    set.forEach(id => { if (!coll[id]) set.delete(id); });
  }
  if (selection.block && !state.blocks[selection.block]) selection.block = null;
  if (activeBlockId && !state.blocks[activeBlockId]) activeBlockId = null;
}

/* ---------- Hilfsfunktionen ---------- */
// IDs landen als Element-IDs im SVG und müssen deshalb über alle Arten eindeutig sein
function idTaken(id) {
  return !!(state.nodes[id] || state.edges[id] || state.signals[id] || state.blocks[id]);
}
function nextId(kind) {
  let id;
  do {
    state.counters[kind] = (state.counters[kind] || 0) + 1;
    id = kind + "_" + state.counters[kind];
  } while (idTaken(id));
  return id;
}
function sanitizeId(str) { return (str || "").trim().replace(/[^a-zA-Z0-9_\-]/g, "_"); }
function uid() { return "id" + Math.random().toString(36).slice(2, 9); }
function newEdgeId() { let id; do { id = uid(); } while (idTaken(id)); return id; }

/* Element umbenennen: Schlüssel und alle Verweise mitziehen. */
function renameElement(kind, oldId, newId) {
  if (!newId || newId === oldId) return false;
  if (idTaken(newId)) { alert(`Die ID "${newId}" ist bereits vergeben.`); return false; }
  const coll = state[kind === "block" ? "blocks" : SEL_SETS[kind]];
  const obj = coll[oldId];
  if (!obj) return false;
  delete coll[oldId];
  obj.id = newId;
  coll[newId] = obj;
  if (kind === "node") {
    Object.values(state.edges).forEach(e => {
      if (e.a.node === oldId) e.a.node = newId;
      if (e.b.node === oldId) e.b.node = newId;
    });
    Object.values(state.blocks).forEach(b => { b.nodes = (b.nodes || []).map(id => id === oldId ? newId : id); });
  }
  if (kind === "block") {
    if (activeBlockId === oldId) activeBlockId = newId;
    if (selection.block === oldId) selection.block = newId;
  } else if (selection[SEL_SETS[kind]].delete(oldId)) {
    selection[SEL_SETS[kind]].add(newId);
  }
  return true;
}

/* Geladene Pläne angleichen: fehlende Felder ergänzen und Elemente, deren ID früher
   ohne den Schlüssel umbenannt wurde, wieder unter ihrer ID ablegen. */
function normalizeState(s) {
  const out = Object.assign(emptyState(), s);
  out.counters = Object.assign(emptyState().counters, s.counters);
  if (!out.planId) out.planId = uid();
  const rekey = (coll) => {
    const map = {}, res = {};
    Object.keys(coll).forEach(key => {
      const obj = coll[key];
      const id = obj.id && !res[obj.id] ? obj.id : key;
      obj.id = id; res[id] = obj; map[key] = id;
    });
    return { map, res };
  };
  const n = rekey(out.nodes);
  out.nodes = n.res;
  const nodeRef = id => (out.nodes[id] ? id : n.map[id]);
  Object.keys(out.edges).forEach(key => {
    const e = out.edges[key];
    e.id = key;
    e.a.node = nodeRef(e.a.node); e.b.node = nodeRef(e.b.node);
    if (!out.nodes[e.a.node] || !out.nodes[e.b.node]) delete out.edges[key];
  });
  out.signals = rekey(out.signals).res;
  out.blocks = rekey(out.blocks).res;
  Object.values(out.blocks).forEach(b => {
    b.edges = (b.edges || []).filter(id => out.edges[id]);
    b.nodes = (b.nodes || []).map(nodeRef).filter(id => out.nodes[id] && out.nodes[id].type !== "link");
  });
  return out;
}

function snap(v) { return snapEnabled ? Math.round(v / GRID_SNAP) * GRID_SNAP : v; }

function deg2rad(d) { return (d * Math.PI) / 180; }
function unit(deg) { const r = deg2rad(deg); return { x: Math.cos(r), y: Math.sin(r) }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.nodes) { state = normalizeState(parsed); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

/* ---------- Verlauf (Undo/Redo) ----------
   Jeder abgeschlossene Bearbeitungsschritt wird als JSON-Schnappschuss abgelegt.
   Während eines Zieh-Vorgangs wird nichts festgehalten – erst beim Loslassen. */
const HISTORY_LIMIT = 200;
let undoStack = [];
let historyIndex = -1;

function commitState() {
  const json = JSON.stringify(state);
  if (undoStack[historyIndex] === json) return;
  undoStack = undoStack.slice(0, historyIndex + 1);
  undoStack.push(json);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  historyIndex = undoStack.length - 1;
  try { localStorage.setItem(STORAGE_KEY, json); } catch (e) { /* ignore */ }
  ha.planChanged();
}
function stepHistory(dir) {
  const idx = historyIndex + dir;
  if (drag || idx < 0 || idx >= undoStack.length) return;
  historyIndex = idx;
  state = JSON.parse(undoStack[idx]);
  try { localStorage.setItem(STORAGE_KEY, undoStack[idx]); } catch (e) { /* ignore */ }
  ha.planChanged();
  renderAll();
}
function undo() { stepHistory(-1); }
function redo() { stepHistory(1); }

/* ---------- Anschluss-Geometrie (lokal, Knotenmittelpunkt = 0,0) ----------
   angle: Richtung vom Knotenmittelpunkt weg, in die der Nachbar liegt
   (0=Ost, 90=Süd, 180=West, 270=Nord; SVG-Y wächst nach unten).
   Weichen: alle Ports liegen 20 (= GRID_SNAP) vom Mittelpunkt entfernt, der Abzweig
   auf dem 30°-Strahl (17.32 = 20·cos 30°). So liegen ungedreht Einfahrt und Stammgleis
   im Raster, und um 30° gedreht (Abzweig waagerecht) der Abzweig-Port. */
function getPortDefs(type) {
  switch (type) {
    case "straight":
      return {
        a: { x: -12, y: 0, angle: 180 },
        b: { x: 12, y: 0, angle: 0 }
      };
    case "turnout_l":
      return {
        entry: { x: -20, y: 0, angle: 180 },
        through: { x: 20, y: 0, angle: 0 },
        diverge: { x: 17.32, y: -10, angle: 330 }
      };
    case "turnout_r":
      return {
        entry: { x: -20, y: 0, angle: 180 },
        through: { x: 20, y: 0, angle: 0 },
        diverge: { x: 17.32, y: 10, angle: 30 }
      };
    case "turnout_y":
      return {
        entry: { x: -20, y: 0, angle: 180 },
        through: { x: 20, y: 0, angle: 0 },
        divergeA: { x: 17.32, y: -10, angle: 330 },
        divergeB: { x: 17.32, y: 10, angle: 30 }
      };
    case "cross":
      return {
        e: { x: 24, y: 0, angle: 0 },
        s: { x: 0, y: 24, angle: 90 },
        w: { x: -24, y: 0, angle: 180 },
        n: { x: 0, y: -24, angle: 270 }
      };
    case "buffer":
    case "link":
      return { end: { x: 20, y: 0, angle: 0 } };
    default:
      return {}; // joint: keine festen Ports
  }
}

/* Innere, feste Gleisstücke eines Knotens (Weichenherz, Kreuzung, Prellbock).
   Werden 1:1 mit exportiert. */
function bezierD(p0, t0Deg, p1, t1Deg, k) {
  const u0 = unit(t0Deg), u1 = unit(t1Deg);
  const c1 = { x: p0.x + u0.x * k, y: p0.y + u0.y * k };
  const c2 = { x: p1.x - u1.x * k, y: p1.y - u1.y * k };
  return `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p1.x},${p1.y}`;
}

function getNodeInnerPaths(type) {
  const p = getPortDefs(type);
  const K = 14;
  switch (type) {
    case "straight":
      return [{ d: `M${p.a.x},${p.a.y} L${p.b.x},${p.b.y}`, cls: "fp-track" }];
    case "turnout_l":
    case "turnout_r":
      // Abzweig zuerst: das Stammgleis liegt darüber (siehe fp-diverge-top in renderNodes)
      return [
        { d: bezierD(p.entry, p.entry.angle + 180, p.diverge, p.diverge.angle, K), cls: "fp-diverge" },
        { d: `M${p.entry.x},${p.entry.y} L${p.through.x},${p.through.y}`, cls: "fp-through" }
      ];
    case "turnout_y":
      return [
        { d: bezierD(p.entry, p.entry.angle + 180, p.divergeA, p.divergeA.angle, K), cls: "fp-diverge" },
        { d: bezierD(p.entry, p.entry.angle + 180, p.divergeB, p.divergeB.angle, K), cls: "fp-diverge" },
        { d: `M${p.entry.x},${p.entry.y} L${p.through.x},${p.through.y}`, cls: "fp-through" }
      ];
    case "cross":
      return [
        { d: `M${p.w.x},${p.w.y} L${p.e.x},${p.e.y}`, cls: "fp-track" },
        { d: `M${p.n.x},${p.n.y} L${p.s.x},${p.s.y}`, cls: "fp-track" }
      ];
    case "buffer":
      return [
        { d: `M${p.end.x},${p.end.y} L-16,0`, cls: "fp-track" },
        { d: `M-16,-9 L-16,9`, cls: "fp-track" }
      ];
    case "link":
      // Gleisende wie beim Prellbock, statt des Querbalkens ein Pfeil "weiter auf anderer Seite"
      return [
        { d: `M${p.end.x},${p.end.y} L-4,0`, cls: "fp-track" },
        { d: `M-7,-10 L-17,0 L-7,10`, cls: "fp-link-arrow" }
      ];
    default:
      return [];
  }
}

/* ---------- Welt-Koordinaten von Ports ---------- */
function portWorldPos(node, portKey) {
  if (node.type === "joint" || !portKey) return { x: node.x, y: node.y };
  const p = getPortDefs(node.type)[portKey];
  const rad = deg2rad(node.rot);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: node.x + p.x * cos - p.y * sin, y: node.y + p.x * sin + p.y * cos };
}
function portWorldAngle(node, portKey) {
  if (node.type === "joint" || !portKey) return null;
  const p = getPortDefs(node.type)[portKey];
  return (p.angle + node.rot + 360) % 360;
}

/* ---------- Belegung von Ports ---------- */
function edgesOfNode(nodeId) {
  return Object.values(state.edges).filter(e => e.a.node === nodeId || e.b.node === nodeId);
}
function isPortOpen(nodeId, portKey) {
  const node = state.nodes[nodeId];
  if (node.type === "joint") {
    return edgesOfNode(nodeId).length < 2;
  }
  return !Object.values(state.edges).some(e =>
    (e.a.node === nodeId && e.a.port === portKey) || (e.b.node === nodeId && e.b.port === portKey)
  );
}
function openPortsOfNode(nodeId) {
  const node = state.nodes[nodeId];
  if (node.type === "joint") {
    return isPortOpen(nodeId, null) ? [null] : [];
  }
  return Object.keys(getPortDefs(node.type)).filter(k => isPortOpen(nodeId, k));
}

/* ---------- Kanten-Geometrie ---------- */
function edgeEndInfo(ref) {
  const node = state.nodes[ref.node];
  const pos = portWorldPos(node, ref.port);
  const angle = node.type === "joint" ? null : portWorldAngle(node, ref.port);
  return { pos, angle };
}

function edgeGeometry(edge) {
  const A = edgeEndInfo(edge.a);
  const B = edgeEndInfo(edge.b);
  const d = dist(A.pos, B.pos);
  const k = Math.min(Math.max(d * 0.5, 24), 140);
  const kA = A.angle === null ? 0 : k;
  const kB = B.angle === null ? 0 : k;
  const u0 = A.angle === null ? { x: 0, y: 0 } : unit(A.angle);
  const u1 = B.angle === null ? { x: 0, y: 0 } : unit(B.angle);
  const c1 = { x: A.pos.x + u0.x * kA, y: A.pos.y + u0.y * kA };
  const c2 = { x: B.pos.x + u1.x * kB, y: B.pos.y + u1.y * kB };
  return { p0: A.pos, c1, c2, p1: B.pos };
}

function cubicPoint(g, t) {
  const mt = 1 - t;
  const x = mt * mt * mt * g.p0.x + 3 * mt * mt * t * g.c1.x + 3 * mt * t * t * g.c2.x + t * t * t * g.p1.x;
  const y = mt * mt * mt * g.p0.y + 3 * mt * mt * t * g.c1.y + 3 * mt * t * t * g.c2.y + t * t * t * g.p1.y;
  return { x, y };
}
function cubicTangent(g, t) {
  const mt = 1 - t;
  const x = 3 * mt * mt * (g.c1.x - g.p0.x) + 6 * mt * t * (g.c2.x - g.c1.x) + 3 * t * t * (g.p1.x - g.c2.x);
  const y = 3 * mt * mt * (g.c1.y - g.p0.y) + 6 * mt * t * (g.c2.y - g.c1.y) + 3 * t * t * (g.p1.y - g.c2.y);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}
function edgePathD(edge) {
  const g = edgeGeometry(edge);
  return `M${g.p0.x},${g.p0.y} C${g.c1.x},${g.c1.y} ${g.c2.x},${g.c2.y} ${g.p1.x},${g.p1.y}`;
}
function edgeSamples(edge, n) {
  const g = edgeGeometry(edge);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push({ t: i / n, pt: cubicPoint(g, i / n) });
  return pts;
}

/* ---------- Löschen mit Aufräumen ---------- */
function deleteEdge(edgeId) {
  delete state.edges[edgeId];
  Object.keys(state.signals).forEach(sid => { if (state.signals[sid].edge === edgeId) delete state.signals[sid]; });
  Object.values(state.blocks).forEach(b => { b.edges = b.edges.filter(id => id !== edgeId); });
  cleanupOrphanJoints();
}
function cleanupOrphanJoints() {
  Object.keys(state.nodes).forEach(nid => {
    const n = state.nodes[nid];
    if (n.type === "joint" && edgesOfNode(nid).length === 0) delete state.nodes[nid];
  });
}
function deleteNode(nodeId) {
  edgesOfNode(nodeId).forEach(e => deleteEdge(e.id));
  delete state.nodes[nodeId];
  Object.values(state.blocks).forEach(b => { b.nodes = (b.nodes || []).filter(id => id !== nodeId); });
}

/* ---------- SVG Grundgerüst ---------- */
const svg = document.getElementById("grid");
const canvasWrap = document.getElementById("canvasWrap");

function makeLayer(id) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("id", id);
  svg.appendChild(g);
  return g;
}
const layerGrid = makeLayer("layer-grid");
const layerBlocks = makeLayer("layer-blocks");
const layerTracks = makeLayer("layer-tracks");
const layerNodes = makeLayer("layer-nodes");
const layerSignals = makeLayer("layer-signals");
const layerHandles = makeLayer("layer-handles");   // Editor-only
const layerSelection = makeLayer("layer-selection"); // Editor-only
const layerPreview = makeLayer("layer-preview");   // Editor-only

function el(tag, attrs, cls) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (cls) e.setAttribute("class", cls);
  return e;
}

/* ---------- Ansicht (unbegrenzte Zeichenfläche) ----------
   Der Plan hat keine Ränder: das SVG füllt immer den ganzen Arbeitsbereich und
   zeigt über die viewBox einen frei verschiebbaren, zoombaren Ausschnitt.
   Das Raster ist ein Muster, das stets genau den sichtbaren Ausschnitt bedeckt. */
const view = { x: 0, y: 0, zoom: 1 };

const gridPattern = el("pattern", {
  id: "gridDots", patternUnits: "userSpaceOnUse",
  x: -GRID_SNAP / 2, y: -GRID_SNAP / 2, width: GRID_SNAP, height: GRID_SNAP
});
gridPattern.appendChild(el("circle", { cx: GRID_SNAP / 2, cy: GRID_SNAP / 2, r: 1 }, "fp-grid-dot"));
layerGrid.appendChild(gridPattern);
const gridRect = el("rect", { fill: "url(#gridDots)" }, "fp-grid");
layerGrid.appendChild(gridRect);

const zoomLabel = document.getElementById("zoomLabel");

function applyView() {
  const w = (canvasWrap.clientWidth || 1) / view.zoom, h = (canvasWrap.clientHeight || 1) / view.zoom;
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${w} ${h}`);
  gridRect.setAttribute("x", view.x); gridRect.setAttribute("y", view.y);
  gridRect.setAttribute("width", w); gridRect.setAttribute("height", h);
  gridRect.setAttribute("display", view.zoom < 0.4 ? "none" : "inline"); // zu dicht zum Lesen
  zoomLabel.textContent = Math.round(view.zoom * 100) + "%";
  try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view)); } catch (e) { /* ignore */ }
}
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY));
    if (v && isFinite(v.x) && isFinite(v.y) && v.zoom >= ZOOM_MIN && v.zoom <= ZOOM_MAX) { Object.assign(view, { x: v.x, y: v.y, zoom: v.zoom }); return true; }
  } catch (e) { /* ignore */ }
  return false;
}
// Zoomen um einen festen Bildschirmpunkt (Mauszeiger bzw. Mitte des Arbeitsbereichs)
function zoomAt(clientX, clientY, zoom) {
  const anchor = toSvgPoint({ clientX, clientY });
  const rect = svg.getBoundingClientRect();
  view.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  view.x = anchor.x - (clientX - rect.left) / view.zoom;
  view.y = anchor.y - (clientY - rect.top) / view.zoom;
  applyView();
}
function zoomBy(factor) {
  const r = canvasWrap.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.zoom * factor);
}
// Ganzen Plan in den Arbeitsbereich einpassen (nie größer als 100 %)
function fitView() {
  const w = canvasWrap.clientWidth || 1, h = canvasWrap.clientHeight || 1;
  if (!Object.keys(state.nodes).length) {
    Object.assign(view, { x: 0, y: 0, zoom: 1 });
  } else {
    const b = getUsedBounds(), pad = 60;
    view.zoom = Math.min(1, Math.max(ZOOM_MIN, Math.min(w / (b.maxX - b.minX + 2 * pad), h / (b.maxY - b.minY + 2 * pad))));
    view.x = (b.minX + b.maxX) / 2 - w / view.zoom / 2;
    view.y = (b.minY + b.maxY) / 2 - h / view.zoom / 2;
  }
  applyView();
}
document.getElementById("btnZoomIn").addEventListener("click", () => zoomBy(1.25));
document.getElementById("btnZoomOut").addEventListener("click", () => zoomBy(0.8));
document.getElementById("btnZoomReset").addEventListener("click", () => zoomBy(1 / view.zoom));
document.getElementById("btnZoomFit").addEventListener("click", fitView);
new ResizeObserver(applyView).observe(canvasWrap);

/* Mausrad/Trackpad verschiebt den Ausschnitt, mit Strg/Cmd (bzw. Pinch-Geste) wird gezoomt. */
canvasWrap.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const unit = ev.deltaMode === 1 ? 16 : 1; // Zeilen statt Pixel (Firefox mit Mausrad)
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(ev.clientX, ev.clientY, view.zoom * Math.exp(-ev.deltaY * unit * 0.01));
    return;
  }
  let dx = ev.deltaX * unit, dy = ev.deltaY * unit;
  if (ev.shiftKey && !dx) { dx = dy; dy = 0; }
  view.x += dx / view.zoom;
  view.y += dy / view.zoom;
  applyView();
  if (drag && lastDragEvent) handleDragMove(lastDragEvent);
}, { passive: false });

/* ---------- Rendering ---------- */
function renderNodes() {
  layerNodes.innerHTML = "";
  Object.values(state.nodes).forEach(node => {
    if (node.type === "joint") {
      const sel = isSelected("node", node.id);
      layerNodes.appendChild(el("circle", { cx: node.x, cy: node.y, r: 4 }, "fp-joint" + (sel ? " node-selected" : "")));
      return;
    }
    const g = el("g", { transform: `translate(${node.x},${node.y}) rotate(${node.rot})` });
    const sel = isSelected("node", node.id);
    if (TURNOUT_TYPES.has(node.type)) {
      g.setAttribute("id", node.id);
      g.setAttribute("class", "fp-turnout" + ha.liveClass("turnout", node.entity) + (sel ? " node-selected" : ""));
    } else if (node.type === "link") {
      // Eigene ID und Klickfläche: in HA führt ein Klick auf die Zielseite
      g.setAttribute("id", node.id);
      g.setAttribute("class", "fp-link" + (sel ? " node-selected" : ""));
      g.appendChild(el("rect", { x: -24, y: -15, width: 48, height: 30 }, "fp-link-hit"));
    } else {
      g.setAttribute("class", "fp-track-node" + (sel ? " node-selected" : ""));
    }
    g.dataset.node = node.id;
    const segs = getNodeInnerPaths(node.type);
    // Klickfläche: füllt den Zwischenraum zwischen Stammgleis und Abzweig(en), damit die
    // Weiche in HA nicht nur auf den schmalen Strichen anklickbar ist.
    if (TURNOUT_TYPES.has(node.type)) {
      const through = getPortDefs(node.type).through;
      const d = segs.filter(seg => seg.cls === "fp-diverge")
        .map(seg => `${seg.d} L${through.x},${through.y} Z`).join(" ");
      g.appendChild(el("path", { d }, "fp-turnout-hit"));
    }
    segs.forEach(seg => g.appendChild(el("path", { d: seg.d }, seg.cls)));
    // SVG kennt kein z-index: Abzweig ein zweites Mal über dem Stammgleis ablegen.
    // Die Kopie ist nur bei "turnout-diverging" sichtbar, damit der gelbe (gestellte)
    // Strang in beiden Stellungen oben liegt.
    if (TURNOUT_TYPES.has(node.type)) {
      segs.filter(seg => seg.cls === "fp-diverge")
        .forEach(seg => g.appendChild(el("path", { d: seg.d, display: "none" }, "fp-diverge fp-diverge-top")));
    }
    if ((TURNOUT_TYPES.has(node.type) || node.type === "link") && node.label) g.appendChild(buildTurnoutLabel(node));
    layerNodes.appendChild(g);
  });
}

/* Beschriftung einer Weiche (oder eines Links): liegt in der Weichen-Gruppe (wird mit exportiert,
   in HA mit angeklickt), steht auf der dem Abzweig abgewandten Seite und wird
   gegen die Knotenrotation zurückgedreht, damit der Text immer waagerecht bleibt. */
function buildTurnoutLabel(node) {
  const ly = node.type === "turnout_r" ? -16 : node.type === "turnout_l" ? 16 : node.type === "link" ? 22 : 28;
  const rad = deg2rad(node.rot);
  const wx = -ly * Math.sin(rad); // waagerechter Anteil des Versatzes in Welt-Koordinaten
  const anchor = wx > Math.abs(ly) / 2 ? "start" : wx < -Math.abs(ly) / 2 ? "end" : "middle";
  const t = el("text", { transform: `translate(0,${ly}) rotate(${-node.rot})`, "text-anchor": anchor, dy: ".35em" }, "fp-label");
  t.textContent = node.label;
  return t;
}

function renderTracks() {
  layerTracks.innerHTML = "";
  Object.values(state.edges).forEach(edge => {
    const sel = isSelected("edge", edge.id);
    const d = edgePathD(edge);
    layerTracks.appendChild(el("path", { d }, "fp-track" + (sel ? " edge-selected" : "")));
    // breiter, unsichtbarer Pfad zum leichteren Anklicken
    const hit = el("path", { d }, "edge-hit");
    hit.dataset.edge = edge.id;
    layerTracks.appendChild(hit);
  });
}

/* Die Blöcke selbst sind deckend, transparent ist erst die gemeinsame Gruppe
   .fp-blocks. So mischen sich die Farben nicht, wo die runden Enden zweier
   benachbarter Blöcke übereinander liegen: dort ist nur der obere Block zu sehen.
   Der gerade bearbeitete Block liegt kräftiger hervorgehoben darüber. */
function renderBlocks() {
  layerBlocks.innerHTML = "";
  const group = el("g", { opacity: 0.32 }, "fp-blocks");
  layerBlocks.appendChild(group);
  Object.values(state.blocks).forEach(b => {
    const sel = isSelected("block", b.id);
    const editing = activeBlockId === b.id;
    const g = el("g", { id: b.id }, "fp-block" + (sel ? " block-selected" : "") + (editing ? " block-editing" : ""));
    b.edges.forEach(eid => {
      const edge = state.edges[eid];
      if (!edge) return;
      g.appendChild(el("path", { d: edgePathD(edge), stroke: b.color }, "fp-block-seg"));
    });
    (b.nodes || []).forEach(nid => {
      const node = state.nodes[nid];
      if (!node) return;
      const ng = el("g", { transform: `translate(${node.x},${node.y}) rotate(${node.rot})` });
      getNodeInnerPaths(node.type).forEach(seg => {
        ng.appendChild(el("path", { d: seg.d, stroke: b.color }, "fp-block-seg"));
      });
      g.appendChild(ng);
    });
    if (editing) { g.setAttribute("opacity", 0.6); layerBlocks.appendChild(g); }
    else group.appendChild(g);
  });
}

/* Signal liegt parallel neben dem Gleis, Mastfuß voraus, Schirm in Fahrtrichtung.
   Es gilt für die Fahrtrichtung, in der es rechts vom Gleis steht. */
const SIGNAL_OFFSET = 18;

function signalFrame(sig) {
  const edge = state.edges[sig.edge];
  if (!edge) return null;
  const geo = edgeGeometry(edge);
  const pt = cubicPoint(geo, sig.t);
  const tan = cubicTangent(geo, sig.t);
  const dir = sig.side === "R" ? tan : { x: -tan.x, y: -tan.y };
  const normal = { x: -dir.y, y: dir.x };
  return {
    angle: Math.atan2(dir.y, dir.x) * 180 / Math.PI,
    center: { x: pt.x + normal.x * SIGNAL_OFFSET, y: pt.y + normal.y * SIGNAL_OFFSET }
  };
}

function renderSignals() {
  layerSignals.innerHTML = "";
  Object.values(state.signals).forEach(sig => {
    const f = signalFrame(sig);
    if (!f) return;
    const sel = isSelected("signal", sig.id);
    const g = el("g", { id: sig.id }, "fp-signal" + ha.liveClass("signal", sig.entity) + (sel ? " sig-selected" : ""));
    g.dataset.signal = sig.id;
    const body = el("g", { transform: `translate(${f.center.x},${f.center.y}) rotate(${f.angle})` });
    body.appendChild(el("line", { x1: -17, y1: -5.5, x2: -17, y2: 5.5, class: "mast" }));
    body.appendChild(el("line", { x1: -17, y1: 0, x2: -7, y2: 0, class: "mast" }));
    body.appendChild(el("rect", { x: -7, y: -6.5, width: 24, height: 13, rx: 6.5, class: "housing" }));
    body.appendChild(el("circle", { cx: -0.5, cy: 0, r: 4, class: "lamp lamp-red" }));
    body.appendChild(el("circle", { cx: 10.5, cy: 0, r: 4, class: "lamp lamp-green" }));
    g.appendChild(body);
    layerSignals.appendChild(g);
  });
}

const ROTATE_HANDLE_RADIUS = 46;

function renderHandles() {
  layerHandles.innerHTML = "";
  Object.values(state.nodes).forEach(node => {
    if (node.type === "joint") {
      if (isPortOpen(node.id, null)) {
        layerHandles.appendChild(makeHandle(node.x, node.y, node.id, null));
      }
      return;
    }
    const ports = getPortDefs(node.type);
    Object.keys(ports).forEach(key => {
      if (!isPortOpen(node.id, key)) return;
      const pos = portWorldPos(node, key);
      layerHandles.appendChild(makeHandle(pos.x, pos.y, node.id, key));
    });
  });

  if (currentTool !== "select") return;
  const rh = rotateHandleInfo();
  if (rh) {
    const rad = deg2rad(rh.angle);
    const hx = rh.center.x + Math.cos(rad) * rh.radius;
    const hy = rh.center.y + Math.sin(rad) * rh.radius;
    if (rh.group) layerHandles.appendChild(el("circle", { cx: rh.center.x, cy: rh.center.y, r: 3 }, "rotate-pivot"));
    layerHandles.appendChild(el("line", { x1: rh.center.x, y1: rh.center.y, x2: hx, y2: hy }, "rotate-handle-line"));
    layerHandles.appendChild(el("circle", { cx: hx, cy: hy, r: 8 }, "rotate-handle"));
  }
}

function selectedNodes() {
  return [...selection.nodes].map(id => state.nodes[id]).filter(Boolean);
}
function nodesBounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(n => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  });
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/* Drehgriff: bei einem einzelnen Element zeigt er in dessen Richtung, bei einer
   Gruppe sitzt er außerhalb der Gruppe und dreht um deren Mittelpunkt. */
function rotateHandleInfo() {
  const nodes = selectedNodes();
  if (nodes.length === 1) {
    const node = nodes[0];
    if (node.type === "joint") return null;
    return { group: false, center: { x: node.x, y: node.y }, radius: ROTATE_HANDLE_RADIUS, angle: node.rot };
  }
  if (nodes.length < 2) return null;
  if (drag && drag.kind === "rotate" && drag.group) {
    return { group: true, center: drag.center, radius: drag.radius, angle: drag.delta };
  }
  const b = nodesBounds(nodes);
  const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + ROTATE_HANDLE_RADIUS;
  return { group: true, center: { x: b.cx, y: b.cy }, radius, angle: 0 };
}
function makeHandle(x, y, nodeId, portKey) {
  const h = el("circle", { cx: x, cy: y, r: 7 }, "port-handle");
  h.dataset.node = nodeId;
  h.dataset.port = portKey === null ? "" : portKey;
  return h;
}

function renderSelectionOutline() {
  layerSelection.innerHTML = "";
  selection.nodes.forEach(id => {
    const n = state.nodes[id];
    if (!n) return;
    layerSelection.appendChild(el("circle", { cx: n.x, cy: n.y, r: n.type === "joint" ? 12 : 30 }, "selection-outline"));
  });
  selection.signals.forEach(id => {
    const sig = state.signals[id];
    const f = sig && signalFrame(sig);
    if (!f) return;
    layerSelection.appendChild(el("circle", { cx: f.center.x, cy: f.center.y, r: 24 }, "selection-outline"));
  });
}

function renderAll() {
  pruneSelection();
  renderNodes();
  renderTracks();
  renderBlocks();
  renderSignals();
  renderHandles();
  renderSelectionOutline();
  renderBlockList();
  renderProps();
  if (!drag) commitState();
  updateHistoryButtons();
}

/* ---------- Werkzeug-Icons ---------- */
function buildToolIcon(tool) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 40 40");
  s.setAttribute("class", "tool-icon");
  s.setAttribute("width", "22");
  s.setAttribute("height", "22");
  s.setAttribute("aria-hidden", "true");
  const g = el("g", { transform: "translate(20,20) scale(0.82)" });
  if (FIXED_PORT_TYPES.has(tool)) {
    getNodeInnerPaths(tool).forEach(seg => g.appendChild(el("path", { d: seg.d }, "icon-track")));
  } else if (tool === "select") {
    g.appendChild(el("path", { d: "M-11,-15 L-11,13 L-4,7 L1,17 L6,15 L1,5 L9,5 Z" }, "icon-fill"));
  } else if (tool === "erase") {
    g.appendChild(el("path", { d: "M-14,-9 L14,-9 M-5,-9 L-5,-15 L5,-15 L5,-9 M-10,-9 L-8,16 L8,16 L10,-9 M-3,-2 L-3,9 M3,-2 L3,9" }, "icon-stroke-thin"));
  } else if (tool === "signal") {
    g.appendChild(el("path", { d: "M0,8 L0,17 M-6,17 L6,17" }, "icon-stroke-thin"));
    g.appendChild(el("rect", { x: -7, y: -18, width: 14, height: 26, rx: 7 }, "icon-housing"));
    g.appendChild(el("circle", { cx: 0, cy: -10.5, r: 4 }, "icon-signal-off"));
    g.appendChild(el("circle", { cx: 0, cy: 0.5, r: 4 }, "icon-signal-dot"));
  }
  s.appendChild(g);
  return s;
}
function initToolbarIcons() {
  document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
    btn.innerHTML = "";
    btn.appendChild(buildToolIcon(btn.dataset.tool));
  });
}

/* ---------- Werkzeugleiste ---------- */
document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
  if (FIXED_PORT_TYPES.has(btn.dataset.tool) || btn.dataset.tool === "signal") {
    btn.setAttribute("draggable", "true");
    btn.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/plain", btn.dataset.tool);
      ev.dataTransfer.effectAllowed = "copy";
    });
  }
});

svg.addEventListener("dragover", (ev) => {
  if (!ev.dataTransfer.types.includes("text/plain")) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});
svg.addEventListener("drop", (ev) => {
  const type = ev.dataTransfer.getData("text/plain");
  if (type === "signal") {
    ev.preventDefault();
    const pt = toSvgPoint(ev);
    const hit = findEdgeNear(pt, SIGNAL_DROP_RADIUS);
    if (!hit) return;
    createSignalAt(refineEdgeHit(hit, pt), pt);
    renderAll();
    return;
  }
  if (!FIXED_PORT_TYPES.has(type)) return;
  ev.preventDefault();
  const pt = toSvgPoint(ev);
  createNodeAt(type, pt);
  renderAll();
});

function setTool(tool) {
  currentTool = tool;
  // Aktiven Block nur beenden, wenn explizit zur Auswahl zurückgekehrt wird –
  // beim kurzen Wechsel zu einem Platzierungswerkzeug (z.B. neues Element für
  // denselben Block anlegen) soll der Block-Kontext erhalten bleiben.
  if (tool === "select") activeBlockId = null;
  document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  renderAll();
}

const snapToggle = document.getElementById("snapToggle");
if (snapToggle) {
  snapToggle.addEventListener("change", () => { snapEnabled = snapToggle.checked; });
}

/* ---------- Zeiger-Interaktion ---------- */
function toSvgPoint(evt) {
  const rect = svg.getBoundingClientRect();
  return { x: view.x + (evt.clientX - rect.left) / view.zoom, y: view.y + (evt.clientY - rect.top) / view.zoom };
}

function findEdgeNear(pt, maxD) {
  let best = null, bestD = maxD;
  Object.values(state.edges).forEach(edge => {
    edgeSamples(edge, 24).forEach(s => {
      const d = dist(pt, s.pt);
      if (d < bestD) { bestD = d; best = { edge, t: s.t }; }
    });
  });
  return best;
}
function findNodeNear(pt, maxD) {
  let best = null, bestD = maxD;
  Object.values(state.nodes).forEach(n => {
    const d = dist(pt, { x: n.x, y: n.y });
    if (d < bestD) { bestD = d; best = n; }
  });
  return best;
}
function findSignalNear(pt, maxD) {
  let best = null, bestD = maxD;
  Object.values(state.signals).forEach(sig => {
    const f = signalFrame(sig);
    if (!f) return;
    const d = dist(pt, f.center);
    if (d < bestD) { bestD = d; best = sig; }
  });
  return best;
}
function findHandleNear(pt, maxD) {
  let best = null, bestD = maxD;
  Object.values(state.nodes).forEach(node => {
    openPortsOfNode(node.id).forEach(portKey => {
      const pos = portWorldPos(node, portKey);
      const d = dist(pt, pos);
      if (d < bestD) { bestD = d; best = { node: node.id, port: portKey, pos }; }
    });
  });
  return best;
}

function createNodeAt(type, pt) {
  const id = nextId(NODE_ID_KIND[type]);
  state.nodes[id] = { id, type, x: snap(pt.x), y: snap(pt.y), rot: 0, entity: "", label: "" };
  selectOnly("node", id);
  return id;
}

/* Beim Ziehen darf das Signal weiter vom Gleis entfernt losgelassen werden als beim Klicken. */
const SIGNAL_DROP_RADIUS = 45;

// Seite des Gleises, auf der pt liegt
function signalSideAt(hit, pt) {
  const g2 = edgeGeometry(hit.edge);
  const p = cubicPoint(g2, hit.t);
  const tan = cubicTangent(g2, hit.t);
  const normal = { x: tan.y, y: -tan.x };
  return ((pt.x - p.x) * normal.x + (pt.y - p.y) * normal.y) >= 0 ? "L" : "R";
}
// findEdgeNear rastet auf 1/24 der Kante – für stufenloses Ziehen nachverfeinern
function refineEdgeHit(hit, pt) {
  const g2 = edgeGeometry(hit.edge);
  let best = hit.t, bestD = Infinity;
  for (let i = -10; i <= 10; i++) {
    const t = Math.min(1, Math.max(0, hit.t + i / 240));
    const d = dist(pt, cubicPoint(g2, t));
    if (d < bestD) { bestD = d; best = t; }
  }
  return { edge: hit.edge, t: best };
}
function createSignalAt(hit, pt) {
  const id = nextId("signal");
  state.signals[id] = { id, edge: hit.edge.id, t: hit.t, side: signalSideAt(hit, pt), entity: "", label: "" };
  selectOnly("signal", id);
  return id;
}

/* Signal gleitet am nächstgelegenen Gleis entlang (ohne Abstandsgrenze, damit es
   nicht hängen bleibt), die Mausseite bestimmt die Gleisseite. */
function applySignalDrag(d) {
  d.raf = 0;
  const sig = state.signals[d.id];
  const coarse = findEdgeNear(d.pt, Infinity);
  if (!sig || !coarse) return;
  const hit = refineEdgeHit(coarse, d.pt);
  sig.edge = hit.edge.id;
  sig.t = hit.t;
  sig.side = signalSideAt(hit, d.pt);
  renderSignals();
  renderSelectionOutline();
}

let drag = null; // {kind:'move'|'connect'|'rotate'|'signal'|'marquee', ...}
let lastPointer = null; // letzte Zeigerposition über dem Plan (Ziel beim Einfügen)

const DRAG_THRESHOLD = 3;

/* Alle ausgewählten Knoten gemeinsam verschieben. Gerastet wird nur der angefasste
   Knoten, die übrigen folgen mit demselben Versatz – die Anordnung bleibt erhalten. */
function startMoveDrag(pt, grabNode, collapseTo) {
  drag = {
    kind: "move", start: pt, moved: false, collapseTo,
    grab: grabNode ? { x: grabNode.x, y: grabNode.y } : null,
    items: selectedNodes().map(n => ({ node: n, x: n.x, y: n.y }))
  };
}

function rotateNodesAbout(items, center, delta) {
  const rad = deg2rad(delta), cos = Math.cos(rad), sin = Math.sin(rad);
  const round = v => Math.round(v * 100) / 100;
  items.forEach(it => {
    const rx = it.x - center.x, ry = it.y - center.y;
    it.node.x = round(center.x + rx * cos - ry * sin);
    it.node.y = round(center.y + rx * sin + ry * cos);
    if (it.node.type !== "joint") it.node.rot = (((it.rot + delta) % 360) + 360) % 360;
  });
}

function marqueeRect(d, pt) {
  return {
    x: Math.min(d.start.x, pt.x), y: Math.min(d.start.y, pt.y),
    w: Math.abs(pt.x - d.start.x), h: Math.abs(pt.y - d.start.y)
  };
}
function applyMarquee(d, pt) {
  const r = marqueeRect(d, pt);
  const inside = p => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  clearSelection();
  if (d.base) {
    d.base.nodes.forEach(id => selection.nodes.add(id));
    d.base.edges.forEach(id => selection.edges.add(id));
    d.base.signals.forEach(id => selection.signals.add(id));
  }
  Object.values(state.nodes).forEach(n => { if (inside(n)) selection.nodes.add(n.id); });
  Object.values(state.signals).forEach(sig => {
    const f = signalFrame(sig);
    if (f && inside(f.center)) selection.signals.add(sig.id);
  });
  selectEdgesBetweenSelectedNodes();
  layerPreview.innerHTML = "";
  layerPreview.appendChild(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h }, "marquee"));
  renderNodes();
  renderTracks();
  renderSignals();
  renderHandles();
  renderSelectionOutline();
}

svg.addEventListener("pointerdown", (ev) => {
  // Ausschnitt verschieben: mittlere Maustaste oder Leertaste + Ziehen
  if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
    ev.preventDefault();
    drag = { kind: "pan", cx: ev.clientX, cy: ev.clientY, x: view.x, y: view.y };
    canvasWrap.classList.add("panning");
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button !== 0) return;
  const pt = toSvgPoint(ev);

  if (currentTool === "select") {
    if (ev.target.classList.contains("rotate-handle")) {
      const info = rotateHandleInfo();
      if (!info) return;
      drag = {
        kind: "rotate", group: info.group, center: info.center, radius: info.radius, delta: 0,
        startAngle: Math.atan2(pt.y - info.center.y, pt.x - info.center.x) * 180 / Math.PI,
        items: selectedNodes().map(n => ({ node: n, x: n.x, y: n.y, rot: n.rot || 0 }))
      };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    const handle = ev.target.classList.contains("port-handle") ? ev.target : null;
    if (handle) {
      const nodeId = handle.dataset.node;
      const portKey = handle.dataset.port || null;
      const fromPos = portWorldPos(state.nodes[nodeId], portKey);
      drag = { kind: "connect", from: { node: nodeId, port: portKey }, fromPos };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    const node = findNodeNear(pt, 22);
    if (node) {
      if (ev.shiftKey) {
        toggleSelected("node", node.id);
      } else {
        // Klick auf ein Element einer Mehrfachauswahl: Gruppe ziehen; ohne Bewegung
        // wird beim Loslassen auf dieses eine Element reduziert.
        const inGroup = isSelected("node", node.id) && selectionCount() > 1;
        if (!inGroup) selectOnly("node", node.id);
        startMoveDrag(pt, node, inGroup ? { kind: "node", key: node.id } : null);
        svg.setPointerCapture(ev.pointerId);
      }
      renderAll();
      return;
    }
    const edgeHit = ev.target.classList.contains("edge-hit") ? ev.target : null;
    if (edgeHit) {
      if (ev.shiftKey) toggleSelected("edge", edgeHit.dataset.edge);
      else selectOnly("edge", edgeHit.dataset.edge);
      renderAll();
      return;
    }
    const sig = findSignalNear(pt, 14);
    if (sig) {
      if (ev.shiftKey) {
        toggleSelected("signal", sig.id);
      } else if (isSelected("signal", sig.id) && selection.nodes.size > 0) {
        startMoveDrag(pt, null, { kind: "signal", key: sig.id });
        svg.setPointerCapture(ev.pointerId);
      } else {
        selectOnly("signal", sig.id);
        drag = { kind: "signal", id: sig.id };
        svg.setPointerCapture(ev.pointerId);
      }
      renderAll();
      return;
    }
    // Leere Fläche: Auswahlrahmen aufziehen (Umschalt erweitert die bestehende Auswahl)
    drag = {
      kind: "marquee", start: pt, moved: false,
      base: ev.shiftKey
        ? { nodes: [...selection.nodes], edges: [...selection.edges], signals: [...selection.signals] }
        : null
    };
    svg.setPointerCapture(ev.pointerId);
    return;
  }

  if (FIXED_PORT_TYPES.has(currentTool)) {
    createNodeAt(currentTool, pt);
    renderAll();
    return;
  }

  if (currentTool === "signal") {
    const hit = findEdgeNear(pt, 26);
    if (!hit) return;
    const near = Object.values(state.signals).find(s => s.edge === hit.edge.id && Math.abs(s.t - hit.t) < 0.06);
    if (near) {
      near.side = near.side === "L" ? "R" : "L";
      selectOnly("signal", near.id);
    } else {
      createSignalAt(hit, pt);
    }
    renderAll();
    return;
  }

  if (currentTool === "block") {
    if (!activeBlockId) return;
    const b = state.blocks[activeBlockId];
    if (!b) return;
    if (!b.nodes) b.nodes = [];
    const node = findNodeNear(pt, 26);
    if (node && node.type === "link") { showToast("Links können keinem Block zugeordnet werden"); return; }
    if (node && node.type !== "joint") {
      const idx = b.nodes.indexOf(node.id);
      if (idx >= 0) b.nodes.splice(idx, 1); else b.nodes.push(node.id);
      renderAll();
      return;
    }
    const hit = findEdgeNear(pt, 26);
    if (!hit) return;
    const idx = b.edges.indexOf(hit.edge.id);
    if (idx >= 0) b.edges.splice(idx, 1); else b.edges.push(hit.edge.id);
    renderAll();
    return;
  }

  if (currentTool === "erase") {
    const sig = findSignalNear(pt, 14);
    if (sig) { delete state.signals[sig.id]; renderAll(); return; }
    const node = findNodeNear(pt, 22);
    if (node) { deleteNode(node.id); renderAll(); return; }
    const hit = findEdgeNear(pt, 20);
    if (hit) { deleteEdge(hit.edge.id); renderAll(); return; }
    return;
  }
});

svg.addEventListener("pointerleave", () => { if (!drag) lastPointer = null; });

/* Wird beim Ziehen bis an den Rand des Arbeitsbereichs gezogen, wandert der
   Ausschnitt mit – so lässt sich der Plan in jede Richtung beliebig erweitern. */
const AUTO_PAN_KINDS = new Set(["move", "marquee", "connect", "signal"]);
const AUTO_PAN_MARGIN = 36;
let lastDragEvent = null; // {clientX, clientY, shiftKey}
let autoPanRaf = 0;

function autoPanTick() {
  autoPanRaf = 0;
  if (!drag || !lastDragEvent || !AUTO_PAN_KINDS.has(drag.kind) || drag.moved === false) return;
  const r = canvasWrap.getBoundingClientRect(), m = AUTO_PAN_MARGIN;
  const push = (v, lo, hi) => Math.max(-m, Math.min(m, v < lo + m ? v - (lo + m) : v > hi - m ? v - (hi - m) : 0));
  const px = push(lastDragEvent.clientX, r.left, r.right), py = push(lastDragEvent.clientY, r.top, r.bottom);
  if (!px && !py) return;
  view.x += px * 0.4 / view.zoom;
  view.y += py * 0.4 / view.zoom;
  applyView();
  handleDragMove(lastDragEvent);
  autoPanRaf = requestAnimationFrame(autoPanTick);
}

svg.addEventListener("pointermove", (ev) => {
  lastDragEvent = drag ? { clientX: ev.clientX, clientY: ev.clientY, shiftKey: ev.shiftKey } : null;
  handleDragMove(ev);
  if (drag && !autoPanRaf) autoPanRaf = requestAnimationFrame(autoPanTick);
});

function handleDragMove(ev) {
  const pt = toSvgPoint(ev);
  lastPointer = pt;
  if (!drag) return;
  if (drag.kind === "pan") {
    view.x = drag.x - (ev.clientX - drag.cx) / view.zoom;
    view.y = drag.y - (ev.clientY - drag.cy) / view.zoom;
    applyView();
  } else if (drag.kind === "move") {
    if (!drag.moved && dist(pt, drag.start) < DRAG_THRESHOLD) return;
    drag.moved = true;
    let dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (drag.grab) {
      dx = snap(drag.grab.x + dx) - drag.grab.x;
      dy = snap(drag.grab.y + dy) - drag.grab.y;
    } else {
      dx = snap(dx); dy = snap(dy);
    }
    drag.items.forEach(it => { it.node.x = it.x + dx; it.node.y = it.y + dy; });
    renderAll();
  } else if (drag.kind === "signal") {
    // Nur die letzte Mausposition pro Frame auswerten und nur die Signalebene neu
    // zeichnen – renderAll (kompletter Neuaufbau + Speichern) folgt beim Loslassen.
    drag.pt = pt;
    if (!drag.raf) drag.raf = requestAnimationFrame(() => applySignalDrag(drag));
  } else if (drag.kind === "rotate") {
    let angle = Math.atan2(pt.y - drag.center.y, pt.x - drag.center.x) * 180 / Math.PI;
    if (drag.group) {
      let delta = angle - drag.startAngle;
      if (ev.shiftKey) delta = Math.round(delta / 15) * 15;
      drag.delta = delta;
      rotateNodesAbout(drag.items, drag.center, delta);
    } else {
      angle = (angle + 360) % 360;
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15 % 360;
      drag.items[0].node.rot = angle;
    }
    renderAll();
  } else if (drag.kind === "marquee") {
    if (!drag.moved && dist(pt, drag.start) < DRAG_THRESHOLD) return;
    drag.moved = true;
    applyMarquee(drag, pt);
  } else if (drag.kind === "connect") {
    layerPreview.innerHTML = "";
    const target = findHandleNear(pt, 18);
    const endPos = target ? target.pos : pt;
    layerPreview.appendChild(el("line", {
      x1: drag.fromPos.x, y1: drag.fromPos.y, x2: endPos.x, y2: endPos.y
    }, "connect-preview" + (target ? " snap" : "")));
  }
}

function endDrag(ev) {
  if (!drag) return;
  const d = drag;
  drag = null; // vor renderAll: erst ohne laufenden Zieh-Vorgang wird der Schritt festgehalten
  lastDragEvent = null;
  if (d.kind === "pan") { canvasWrap.classList.remove("panning"); return; }
  layerPreview.innerHTML = "";
  if (d.kind === "connect") {
    const pt = toSvgPoint(ev);
    const target = findHandleNear(pt, 22);
    if (target && !(target.node === d.from.node && target.port === d.from.port)) {
      if (target.node !== d.from.node) {
        const id = newEdgeId();
        state.edges[id] = { id, a: { node: d.from.node, port: d.from.port }, b: { node: target.node, port: target.port } };
      }
    } else if (!target) {
      // Ins Leere gezogen: Gerade einfügen, in Zugrichtung ausgerichtet
      // (Port "a" zeigt zurück zum Ausgangspunkt).
      const sid = createNodeAt("straight", pt);
      const node = state.nodes[sid];
      let rot = Math.atan2(node.y - d.fromPos.y, node.x - d.fromPos.x) * 180 / Math.PI;
      rot = (rot + 360) % 360;
      if (snapEnabled) rot = Math.round(rot / 15) * 15 % 360;
      node.rot = rot;
      const eid = newEdgeId();
      state.edges[eid] = { id: eid, a: { node: d.from.node, port: d.from.port }, b: { node: sid, port: "a" } };
    }
  } else if (d.kind === "signal") {
    if (d.raf) { cancelAnimationFrame(d.raf); applySignalDrag(d); }
  } else if (d.kind === "move") {
    if (!d.moved && d.collapseTo) selectOnly(d.collapseTo.kind, d.collapseTo.key);
  } else if (d.kind === "marquee") {
    if (!d.moved && !d.base) clearSelection();
  }
  renderAll();
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

/* ---------- Zwischenablage ----------
   Die Kopie wird als JSON-Text abgelegt: in der System-Zwischenablage und zusätzlich
   im localStorage. So lässt sie sich auch nach "Plan laden"/"Neuer Plan" oder in
   einem anderen Fenster wieder einfügen. */
const CLIP_TYPE = "gleisplan-clip";
const CLIP_STORAGE_KEY = "gleisplan-editor-clipboard";
const NODE_ID_KIND = { straight: "straight", turnout_l: "turnout", turnout_r: "turnout", turnout_y: "turnout", cross: "cross", buffer: "buffer", link: "link", joint: "joint" };
const DEFAULT_PASTE_OPTIONS = { blocks: "none", entities: "keep" };

let memoryClip = null;
let pendingClip = null;  // {text, at}: per Tastendruck erzeugt, vom copy/cut-Ereignis abgeholt
let pendingPaste = null; // {withOptions}: per Tastendruck vorgemerkt, vom paste-Ereignis abgeholt
let lastPaste = null;    // {x, y, count}: wiederholtes Einfügen an derselben Stelle versetzen

function buildClip() {
  const nodeIds = new Set(selection.nodes);
  const pull = edge => { if (edge) { nodeIds.add(edge.a.node); nodeIds.add(edge.b.node); } };
  selection.edges.forEach(id => pull(state.edges[id]));
  // Ein Signal braucht sein Gleis – es nimmt Kante und Endpunkte mit
  selection.signals.forEach(id => { const sig = state.signals[id]; pull(sig && state.edges[sig.edge]); });
  const nodes = [...nodeIds].map(id => state.nodes[id]).filter(Boolean);
  if (!nodes.length) return null;
  const edges = Object.values(state.edges).filter(e => nodeIds.has(e.a.node) && nodeIds.has(e.b.node));
  const edgeIds = new Set(edges.map(e => e.id));
  const signals = [...selection.signals].map(id => state.signals[id]).filter(s => s && edgeIds.has(s.edge));
  const blocks = Object.values(state.blocks).map(b => ({
    id: b.id, name: b.name, entity: b.entity, color: b.color,
    edges: b.edges.filter(id => edgeIds.has(id)),
    nodes: (b.nodes || []).filter(id => nodeIds.has(id))
  })).filter(b => b.edges.length || b.nodes.length);
  return JSON.parse(JSON.stringify({ type: CLIP_TYPE, version: 1, planId: state.planId, nodes, edges, signals, blocks }));
}
function parseClip(text) {
  try {
    const c = JSON.parse(text);
    if (c && c.type === CLIP_TYPE && Array.isArray(c.nodes) && c.nodes.length) return c;
  } catch (e) { /* kein Gleisplan-Inhalt */ }
  return null;
}
function storedClip() {
  let text = null;
  try { text = localStorage.getItem(CLIP_STORAGE_KEY); } catch (e) { /* ignore */ }
  return parseClip(text || memoryClip || "");
}
function clipSummary(clip) {
  const fixed = clip.nodes.filter(n => n.type !== "joint").length;
  const parts = [`${fixed} Element${fixed === 1 ? "" : "e"}`];
  if (clip.signals && clip.signals.length) parts.push(`${clip.signals.length} Signal${clip.signals.length === 1 ? "" : "e"}`);
  return parts.join(", ");
}

function copySelection() {
  const clip = buildClip();
  if (!clip) return null;
  const text = JSON.stringify(clip);
  memoryClip = text;
  try { localStorage.setItem(CLIP_STORAGE_KEY, text); } catch (e) { /* ignore */ }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  } catch (e) { /* ignore */ }
  lastPaste = null;
  showToast(clipSummary(clip) + " kopiert");
  return text;
}
function cutSelection() {
  const text = copySelection();
  if (text) deleteSelection();
  return text;
}
function duplicateSelection() {
  const clip = buildClip();
  if (clip) pasteClip(clip, DEFAULT_PASTE_OPTIONS, { dx: GRID_SNAP, dy: GRID_SNAP });
}

// Zielpunkt fürs Einfügen: Mauszeiger, sonst Mitte des sichtbaren Ausschnitts
function pasteTarget() {
  if (lastPointer) return lastPointer;
  const r = canvasWrap.getBoundingClientRect();
  return toSvgPoint({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
}

function beginPaste(clip, withOptions) {
  if (!clip) { showToast("Zwischenablage enthält keine Gleisplan-Elemente"); return; }
  if (withOptions) openPasteDialog(clip, pasteTarget());
  else pasteClip(clip, DEFAULT_PASTE_OPTIONS, null, pasteTarget());
}

/* Fügt eine Kopie ein.
   opts.blocks:   "none" = nur Gleise | "new" = als neue Blöcke | "same" = selber Block
   opts.entities: "keep" = 1:1 | "free" = nur noch nicht vergebene | "clear" = leeren
   IDs bleiben erhalten, solange sie im Zielplan frei sind. */
function pasteClip(clip, opts, offset, target) {
  const b = nodesBounds(clip.nodes);
  let dx, dy;
  if (offset) {
    dx = offset.dx; dy = offset.dy;
  } else {
    dx = target.x - b.cx; dy = target.y - b.cy;
    if (snapEnabled) { dx = Math.round(dx / GRID_SNAP) * GRID_SNAP; dy = Math.round(dy / GRID_SNAP) * GRID_SNAP; }
    if (lastPaste && lastPaste.x === dx && lastPaste.y === dy) lastPaste.count++;
    else lastPaste = { x: dx, y: dy, count: 0 };
    dx += lastPaste.count * GRID_SNAP; dy += lastPaste.count * GRID_SNAP;
  }

  const usedEntities = new Set();
  [state.nodes, state.signals, state.blocks].forEach(coll =>
    Object.values(coll).forEach(o => { if (o.entity) usedEntities.add(o.entity); }));
  const entityFor = (entity) => {
    if (!entity || opts.entities === "clear") return "";
    if (opts.entities === "free") {
      if (usedEntities.has(entity)) return "";
      usedEntities.add(entity);
    }
    return String(entity);
  };
  const idFor = (wanted, kind) => {
    const id = sanitizeId(String(wanted || ""));
    return id && !idTaken(id) ? id : nextId(kind);
  };

  const nodeMap = {}, edgeMap = {};
  const pasted = { nodes: [], edges: [], signals: [] };
  clip.nodes.forEach(n => {
    if (!NODE_ID_KIND[n.type]) return;
    const id = idFor(n.id, NODE_ID_KIND[n.type]);
    state.nodes[id] = {
      id, type: n.type, x: (Number(n.x) || 0) + dx, y: (Number(n.y) || 0) + dy, rot: Number(n.rot) || 0,
      entity: entityFor(n.entity), label: String(n.label || "")
    };
    if (n.type === "link") state.nodes[id].target = String(n.target || "");
    nodeMap[n.id] = id;
    pasted.nodes.push(id);
  });
  const portOk = (ref) => {
    const node = state.nodes[nodeMap[ref.node]];
    return node && (node.type === "joint" ? !ref.port : ref.port in getPortDefs(node.type));
  };
  (clip.edges || []).forEach(e => {
    if (!e.a || !e.b || !portOk(e.a) || !portOk(e.b)) return;
    const id = newEdgeId();
    state.edges[id] = { id, a: { node: nodeMap[e.a.node], port: e.a.port || null }, b: { node: nodeMap[e.b.node], port: e.b.port || null } };
    edgeMap[e.id] = id;
    pasted.edges.push(id);
  });
  (clip.signals || []).forEach(sig => {
    if (!edgeMap[sig.edge]) return;
    const id = idFor(sig.id, "signal");
    state.signals[id] = {
      id, edge: edgeMap[sig.edge], t: Math.min(1, Math.max(0, Number(sig.t) || 0)), side: sig.side === "L" ? "L" : "R",
      entity: entityFor(sig.entity), label: String(sig.label || "")
    };
    pasted.signals.push(id);
  });

  if (opts.blocks !== "none") {
    (clip.blocks || []).forEach(cb => {
      const edges = (cb.edges || []).map(id => edgeMap[id]).filter(Boolean);
      const nodes = (cb.nodes || []).map(id => nodeMap[id]).filter(id => id && state.nodes[id].type !== "link");
      if (!edges.length && !nodes.length) return;
      // "Selber Block": im Ursprungsplan der Original-Block; in einem anderen Plan ein
      // gleichnamiger Block, der beim ersten Einfügen angelegt und danach weiterverwendet wird.
      const existing = opts.blocks === "same" ? state.blocks[cb.id] : null;
      if (existing && (clip.planId === state.planId || existing.name === cb.name)) {
        existing.edges = [...new Set(existing.edges.concat(edges))];
        existing.nodes = [...new Set((existing.nodes || []).concat(nodes))];
        return;
      }
      const id = idFor(cb.id, "block");
      const color = /^#[0-9a-fA-F]{6}$/.test(cb.color) ? cb.color : BLOCK_COLORS[Object.keys(state.blocks).length % BLOCK_COLORS.length];
      state.blocks[id] = { id, name: String(cb.name || id), entity: entityFor(cb.entity), color, edges, nodes };
    });
  }

  clearSelection();
  pasted.nodes.forEach(id => selection.nodes.add(id));
  pasted.edges.forEach(id => selection.edges.add(id));
  pasted.signals.forEach(id => selection.signals.add(id));
  showToast(clipSummary(clip) + " eingefügt");
  if (currentTool !== "select") setTool("select"); else renderAll();
}

function hasTextSelection() {
  const s = window.getSelection();
  return !!s && !s.isCollapsed && s.toString().length > 0;
}
function isTextTarget(t) {
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
function modalOpen() { return !helpOverlay.hidden || !pasteOverlay.hidden || ha.dialogOpen(); }

function onClipboardEvent(ev, cut) {
  if (modalOpen() || isTextTarget(ev.target) || hasTextSelection()) return;
  let text = pendingClip && Date.now() - pendingClip.at < 1000 ? pendingClip.text : null;
  const viaKey = !!pendingClip;
  pendingClip = null;
  if (!viaKey) text = cut ? cutSelection() : copySelection(); // z.B. über das Browser-Menü
  if (!text) return;
  ev.clipboardData.setData("text/plain", text);
  ev.preventDefault();
}
document.addEventListener("copy", ev => onClipboardEvent(ev, false));
document.addEventListener("cut", ev => onClipboardEvent(ev, true));
document.addEventListener("paste", (ev) => {
  if (modalOpen() || isTextTarget(ev.target)) return;
  const withOptions = pendingPaste ? pendingPaste.withOptions : false;
  pendingPaste = null;
  const clip = parseClip(ev.clipboardData.getData("text/plain")) || storedClip();
  ev.preventDefault();
  beginPaste(clip, withOptions);
});

// Das paste-Ereignis kennt die Umschalt-Taste nicht und bleibt je nach Browser bei
// Strg/Cmd+Umschalt+V aus – deshalb wird der Tastendruck vorgemerkt und notfalls
// aus der internen Ablage eingefügt.
function requestPaste(withOptions) {
  const req = pendingPaste = { withOptions };
  setTimeout(() => {
    if (pendingPaste !== req) return;
    pendingPaste = null;
    if (!modalOpen()) beginPaste(storedClip(), withOptions);
  }, 120);
}

/* ---------- Einfügen mit Optionen (Strg/Cmd+Umschalt+V) ---------- */
const pasteOverlay = document.getElementById("pasteOverlay");
let pasteDialogJob = null; // {clip, target}

function openPasteDialog(clip, target) {
  pasteDialogJob = { clip, target };
  const nBlocks = (clip.blocks || []).length;
  document.getElementById("pasteSummary").textContent =
    `Zwischenablage: ${clipSummary(clip)}` + (nBlocks ? `, Teile von ${nBlocks} Block${nBlocks === 1 ? "" : "abschnitten"}` : ", keine Blockzuordnungen");
  pasteOverlay.querySelectorAll('input[name="pasteBlocks"]').forEach(r => {
    r.disabled = !nBlocks && r.value !== "none";
    if (r.disabled && r.checked) pasteOverlay.querySelector('input[name="pasteBlocks"][value="none"]').checked = true;
  });
  pasteOverlay.hidden = false;
  document.getElementById("btnPasteConfirm").focus();
}
function closePasteDialog() {
  pasteOverlay.hidden = true;
  pasteDialogJob = null;
}
function confirmPasteDialog() {
  const job = pasteDialogJob;
  if (!job) return;
  const opts = {
    blocks: pasteOverlay.querySelector('input[name="pasteBlocks"]:checked').value,
    entities: pasteOverlay.querySelector('input[name="pasteEntities"]:checked').value
  };
  closePasteDialog();
  pasteClip(job.clip, opts, null, job.target);
}
document.getElementById("btnPasteConfirm").addEventListener("click", confirmPasteDialog);
document.getElementById("btnPasteCancel").addEventListener("click", closePasteDialog);
pasteOverlay.addEventListener("click", (ev) => { if (ev.target === pasteOverlay) closePasteDialog(); });
pasteOverlay.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); confirmPasteDialog(); }
});

/* ---------- Statusmeldung ---------- */
const toastEl = document.getElementById("toast");
let toastTimer = 0;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

/* ---------- Tastatur ---------- */
let spaceDown = false; // Leertaste gehalten: Ziehen verschiebt den Ausschnitt
function setSpaceDown(on) {
  spaceDown = on;
  canvasWrap.classList.toggle("pan-ready", on);
}
document.addEventListener("keyup", (ev) => { if (ev.key === " ") setSpaceDown(false); });
window.addEventListener("blur", () => setSpaceDown(false));

const ARROW_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!pasteOverlay.hidden) closePasteDialog();
    else if (ha.closeDialog()) return;
    else if (!helpOverlay.hidden) helpOverlay.hidden = true;
    else if (isTextTarget(ev.target)) ev.target.blur();
    else if (drag) return;
    else if (currentTool !== "select") setTool("select");
    else { clearSelection(); renderAll(); }
    return;
  }
  if (modalOpen() || isTextTarget(ev.target)) return;
  if (ev.key === " ") { ev.preventDefault(); setSpaceDown(true); return; }
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

  if (ev.metaKey || ev.ctrlKey) {
    if (ev.altKey) return;
    if (key === "a") {
      ev.preventDefault();
      if (currentTool !== "select") setTool("select");
      selectAll();
      renderAll();
    } else if (key === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
    else if (key === "y") { ev.preventDefault(); redo(); }
    else if (key === "d") { ev.preventDefault(); duplicateSelection(); }
    else if (key === "c" || key === "x") {
      if (hasTextSelection()) return;
      const text = key === "x" ? cutSelection() : copySelection();
      pendingClip = { text, at: Date.now() };
    } else if (key === "v") requestPaste(ev.shiftKey);
    return;
  }

  if (key === "r") rotateSelection(ev.shiftKey ? -15 : 15);
  else if (key === "Delete" || key === "Backspace") deleteSelection();
  else if (ARROW_KEYS[key] && selection.nodes.size) {
    // Pfeiltasten: ein Rasterschritt, mit Umschalt 1 px zum Feinjustieren
    ev.preventDefault();
    const step = ev.shiftKey ? 1 : GRID_SNAP;
    selectedNodes().forEach(n => { n.x += ARROW_KEYS[key][0] * step; n.y += ARROW_KEYS[key][1] * step; });
    renderAll();
  }
});

function rotateSelection(delta) {
  const nodes = selectedNodes();
  if (!nodes.length || (nodes.length === 1 && nodes[0].type === "joint")) return;
  const b = nodesBounds(nodes);
  rotateNodesAbout(nodes.map(n => ({ node: n, x: n.x, y: n.y, rot: n.rot || 0 })), { x: b.cx, y: b.cy }, delta);
  renderAll();
}

function deleteSelection() {
  if (!selectionCount()) return;
  if (selection.block) delete state.blocks[selection.block];
  selection.signals.forEach(id => { delete state.signals[id]; });
  selection.edges.forEach(id => { if (state.edges[id]) deleteEdge(id); });
  selection.nodes.forEach(id => { if (state.nodes[id]) deleteNode(id); });
  clearSelection();
  renderAll();
}

/* ---------- Eigenschaften-Panel ---------- */
const propsEmpty = document.getElementById("propsEmpty");
const propsForm = document.getElementById("propsForm");

function field(labelText, inputEl, hint) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(inputEl);
  if (hint) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}
function textInput(value, onChange, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value || "";
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("change", () => onChange(i.value));
  return i;
}

/* Entity-Feld: in Home Assistant mit Vorschlagsliste und aktuellem Zustand (ha.js) */
function entityField(labelText, obj, domains, hint) {
  const input = textInput(obj.entity, v => { obj.entity = v.trim(); renderAll(); });
  const wrap = field(labelText, input, hint);
  ha.decorateEntityField(wrap, input, obj.entity, domains);
  return wrap;
}

function renderProps() {
  propsForm.innerHTML = "";
  if (!selectionCount()) { propsEmpty.hidden = false; propsForm.hidden = true; return; }
  propsEmpty.hidden = true;
  propsForm.hidden = false;
  const sel = singleSelection();
  if (!sel) { renderMultiProps(); return; }

  if (sel.kind === "node") {
    const node = state.nodes[sel.key];
    if (!node) return;
    if (node.type === "joint") {
      propsForm.innerHTML = "<div><b>Verbindungspunkt</b></div>";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Frei verschiebbarer Punkt zum Formen der Kurve. Von hier aus kann eine zweite Verbindung weitergezogen werden.";
      propsForm.appendChild(hint);
    } else {
      const title = document.createElement("div");
      title.innerHTML = `<b>${TOOL_LABELS[node.type] || node.type}</b>`;
      propsForm.appendChild(title);
      if (TURNOUT_TYPES.has(node.type)) {
        propsForm.appendChild(field("Element-ID (für SVG/YAML)", textInput(node.id, v => {
          renameElement("node", node.id, sanitizeId(v)); renderAll();
        }), "Wird als SVG-Element-ID und in der YAML-Regel verwendet."));
        propsForm.appendChild(entityField("HA-Entity (switch.…)", node, ["switch", "input_boolean"], "z.B. switch.weiche_5"));
        const toggleBtn = ha.toggleButton(node.entity);
        if (toggleBtn) propsForm.appendChild(toggleBtn);
        propsForm.appendChild(field("Beschriftung (optional)", textInput(node.label, v => { node.label = v; renderAll(); }),
          "Wird neben der Weiche angezeigt – auch im exportierten SVG und damit in Home Assistant."));
      }
      if (node.type === "link") {
        propsForm.appendChild(field("Element-ID (für SVG/YAML)", textInput(node.id, v => {
          renameElement("node", node.id, sanitizeId(v)); renderAll();
        }), "Wird als SVG-Element-ID und in der YAML-Regel verwendet."));
        propsForm.appendChild(field("Zielseite in Home Assistant", textInput(node.target, v => {
          node.target = v.trim(); renderAll();
        }, "/lovelace/gleisplan-2"), "Pfad der Seite (Dashboard/Ansicht), die beim Anklicken in HA geöffnet wird – z.B. /lovelace/schattenbahnhof. Eine Adresse mit http(s):// wird als externer Link geöffnet."));
        propsForm.appendChild(field("Beschriftung (optional)", textInput(node.label, v => { node.label = v; renderAll(); }),
          "Wird neben dem Link angezeigt, z.B. der Name des anschließenden Plans."));
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.style.marginBottom = "10px";
        hint.textContent = "Gleisende mit Fortsetzung auf einem anderen Plan. Kann keinem Block zugeordnet werden.";
        propsForm.appendChild(hint);
      }
      const rotInput = document.createElement("input");
      rotInput.type = "number";
      rotInput.step = "1";
      rotInput.value = Math.round(node.rot * 10) / 10;
      rotInput.addEventListener("change", () => {
        const v = parseFloat(rotInput.value);
        node.rot = ((isNaN(v) ? 0 : v) % 360 + 360) % 360;
        renderAll();
      });
      propsForm.appendChild(field("Rotation (°)", rotInput, "Frei drehbar: am orangen Griff am Element ziehen, mit R in 15°-Schritten drehen, oder hier exakt eingeben."));
    }
    const delBtn = document.createElement("button");
    delBtn.className = "wide";
    delBtn.textContent = "Element löschen (Entf)";
    delBtn.addEventListener("click", deleteSelection);
    propsForm.appendChild(delBtn);
  }

  if (sel.kind === "edge") {
    propsForm.innerHTML = "<div><b>Gleisverbindung</b></div>";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Reines Verbindungsstück ohne eigene HA-Entity. Für Belegtmeldung dem Block zuweisen.";
    propsForm.appendChild(hint);
    const delBtn = document.createElement("button");
    delBtn.className = "wide";
    delBtn.style.marginTop = "8px";
    delBtn.textContent = "Verbindung löschen (Entf)";
    delBtn.addEventListener("click", deleteSelection);
    propsForm.appendChild(delBtn);
  }

  if (sel.kind === "signal") {
    const sig = state.signals[sel.key];
    if (!sig) return;
    propsForm.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<b>Signal</b>" }));
    propsForm.appendChild(field("Element-ID", textInput(sig.id, v => {
      renameElement("signal", sig.id, sanitizeId(v)); renderAll();
    })));
    propsForm.appendChild(entityField("HA-Entity (light./input_select.…)", sig, ["light", "input_select", "input_boolean", "switch"],
      "Zustand 'on' → grün, 'off' → rot (siehe YAML-Export)."));
    propsForm.appendChild(field("Label (optional)", textInput(sig.label, v => { sig.label = v; renderAll(); })));
    const delBtn = document.createElement("button");
    delBtn.className = "wide";
    delBtn.textContent = "Signal löschen (Entf)";
    delBtn.addEventListener("click", deleteSelection);
    propsForm.appendChild(delBtn);
  }

  if (sel.kind === "block") renderBlockProps(state.blocks[sel.key]);
}

/* Mehrfachauswahl: Übersicht und die wichtigsten Gruppen-Aktionen */
function renderMultiProps() {
  const fixed = selectedNodes().filter(n => n.type !== "joint").length;
  const title = document.createElement("div");
  title.innerHTML = "<b>Mehrfachauswahl</b>";
  propsForm.appendChild(title);
  const info = document.createElement("div");
  info.className = "field";
  info.textContent = `${fixed} Element(e), ${selection.edges.size} Verbindung(en), ${selection.signals.size} Signal(e)`;
  propsForm.appendChild(info);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.style.marginBottom = "10px";
  hint.textContent = "Gemeinsam verschieben: an einem ausgewählten Element ziehen oder Pfeiltasten. Gemeinsam drehen: am orangen Griff ziehen oder R.";
  propsForm.appendChild(hint);
  const actions = [
    ["Kopieren", copySelection],
    ["Duplizieren", duplicateSelection],
    ["Um 15° drehen (R)", () => rotateSelection(15)],
    ["Auswahl löschen (Entf)", deleteSelection]
  ];
  actions.forEach(([label, fn]) => {
    const btn = document.createElement("button");
    btn.className = "wide";
    btn.style.marginBottom = "6px";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    propsForm.appendChild(btn);
  });
}

function renderBlockProps(b) {
  if (!b) return;
  if (!b.nodes) b.nodes = [];
  propsForm.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<b>Blockabschnitt</b>" }));
  propsForm.appendChild(field("Element-ID", textInput(b.id, v => {
    renameElement("block", b.id, sanitizeId(v)); renderAll();
  })));
  propsForm.appendChild(field("Name", textInput(b.name, v => { b.name = v; renderAll(); })));
  propsForm.appendChild(entityField("HA-Entity (binary_sensor.…)", b, ["binary_sensor", "input_boolean"], "Zustand 'on' = belegt (rot eingefärbt)."));
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = b.color;
  colorInput.addEventListener("input", () => { b.color = colorInput.value; renderAll(); });
  propsForm.appendChild(field("Farbe", colorInput));
  const countRow = document.createElement("div");
  countRow.className = "field";
  countRow.innerHTML = `<label>Zugewiesene Elemente</label><div>${b.edges.length} Gleisstück(e), ${b.nodes.length} Element(e) (Weiche/Gerade/Prellbock/…)</div>`;
  propsForm.appendChild(countRow);
  const editBtn = document.createElement("button");
  editBtn.className = "wide";
  editBtn.textContent = (activeBlockId === b.id) ? "Auswahl beenden" : "Elemente bearbeiten";
  editBtn.addEventListener("click", () => {
    activeBlockId = (activeBlockId === b.id) ? null : b.id;
    setTool(activeBlockId ? "block" : "select");
  });
  propsForm.appendChild(editBtn);
  const delBtn = document.createElement("button");
  delBtn.className = "wide";
  delBtn.style.marginTop = "6px";
  delBtn.textContent = "Block löschen";
  delBtn.addEventListener("click", deleteSelection);
  propsForm.appendChild(delBtn);
}

/* ---------- Block-Liste ---------- */
const blockListEl = document.getElementById("blockList");
function renderBlockList() {
  blockListEl.innerHTML = "";
  Object.values(state.blocks).forEach(b => {
    const li = document.createElement("li");
    li.className = (isSelected("block", b.id) ? "active" : "") + (ha.isOn(b.entity) ? " occupied" : "");
    li.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="count"></span>';
    li.children[0].style.background = b.color;
    li.children[1].textContent = b.name;
    li.children[2].textContent = b.edges.length + (b.nodes || []).length;
    li.addEventListener("click", () => { selectOnly("block", b.id); setTool("select"); });
    blockListEl.appendChild(li);
  });
}
document.getElementById("btnNewBlock").addEventListener("click", () => {
  const id = nextId("block");
  const color = BLOCK_COLORS[(state.counters.block - 1) % BLOCK_COLORS.length];
  state.blocks[id] = { id, name: "Block " + state.counters.block, entity: "", color, edges: [], nodes: [] };
  activeBlockId = id;
  selectOnly("block", id);
  setTool("block");
});

/* ---------- Undo/Redo-Buttons ---------- */
const btnUndo = document.getElementById("btnUndo");
const btnRedo = document.getElementById("btnRedo");
btnUndo.addEventListener("click", undo);
btnRedo.addEventListener("click", redo);
function updateHistoryButtons() {
  btnUndo.disabled = historyIndex <= 0;
  btnRedo.disabled = historyIndex >= undoStack.length - 1;
}

/* ---------- Datei-Aktionen ---------- */
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function emptyState() {
  return { planId: uid(), name: "", nodes: {}, edges: {}, signals: {}, blocks: {}, counters: { straight: 0, turnout: 0, cross: 0, buffer: 0, link: 0, joint: 0, signal: 0, block: 0 } };
}

/* Plan komplett ersetzen (aus Home Assistant geladen); der Verlauf beginnt neu */
function openPlan(data) {
  state = normalizeState(data);
  clearSelection(); activeBlockId = null;
  undoStack = []; historyIndex = -1;
  renderAll();
  fitView();
}

document.getElementById("btnNew").addEventListener("click", () => {
  // In Home Assistant bleibt der bisherige Plan gespeichert – dort nichts zu verwerfen
  if (!ha.connected && !confirm("Aktuellen Plan verwerfen und neu beginnen?")) return;
  ha.flush();
  state = emptyState();
  clearSelection(); activeBlockId = null;
  renderAll();
  fitView();
});
document.getElementById("btnSaveJson").addEventListener("click", () => {
  downloadFile("gleisplan.json", JSON.stringify(state, null, 2), "application/json");
});
document.getElementById("btnLoadJson").addEventListener("click", () => {
  document.getElementById("fileLoadJson").click();
});
document.getElementById("fileLoadJson").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.nodes) throw new Error("ungültiges Format");
      ha.flush();
      state = normalizeState(parsed);
      clearSelection(); activeBlockId = null;
      renderAll();
      fitView();
    } catch (e) {
      alert("Datei konnte nicht geladen werden: " + e.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = "";
});

/* ---------- Export: SVG ---------- */
const EXPORT_LAYER_IDS = ["layer-blocks", "layer-tracks", "layer-nodes", "layer-signals"];

/* Tatsächlich gezeichnete Fläche: Knotenmittelpunkte allein reichen nicht, weil
   Kantenbögen, Weichenschenkel, Signale und Beschriftungen darüber hinausragen. */
function getUsedBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  EXPORT_LAYER_IDS.forEach(id => {
    const layer = document.getElementById(id);
    if (!layer.firstChild) return; // leere Ebene liefert eine 0/0-Box
    const bb = layer.getBBox();
    consider(bb.x, bb.y);
    consider(bb.x + bb.width, bb.y + bb.height);
  });
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  return { minX, minY, maxX, maxY };
}

function buildExportSvg() {
  const used = getUsedBounds();
  const margin = 30; // Rand inkl. Strichstärke (getBBox misst ohne Strich)
  const x0 = used.minX - margin, y0 = used.minY - margin;
  const w = used.maxX - used.minX + 2 * margin, h = used.maxY - used.minY + 2 * margin;

  const out = document.createElementNS(NS, "svg");
  out.setAttribute("viewBox", `${x0} ${y0} ${w} ${h}`);
  out.setAttribute("width", w);
  out.setAttribute("height", h);

  const styleEl = document.createElementNS(NS, "style");
  styleEl.textContent = "\n" + buildCss() + "\n";
  out.appendChild(styleEl);

  EXPORT_LAYER_IDS.forEach(id => {
    const clone = document.getElementById(id).cloneNode(true);
    clone.querySelectorAll(".node-selected,.edge-selected,.block-selected,.sig-selected,.block-editing")
      .forEach(node => node.classList.remove("node-selected", "edge-selected", "block-selected", "sig-selected", "block-editing"));
    // Live-Zustände aus Home Assistant gehören nicht in die Datei
    clone.querySelectorAll(".turnout-straight,.turnout-diverging,.signal-red,.signal-green")
      .forEach(node => node.classList.remove("turnout-straight", "turnout-diverging", "signal-red", "signal-green"));
    clone.querySelectorAll(".edge-hit").forEach(node => node.remove());
    clone.querySelectorAll(".fp-joint").forEach(node => node.remove());
    // Blöcke: alle in die gemeinsame Gruppe, Grundzustand unsichtbar
    const blocks = clone.querySelector(".fp-blocks");
    if (blocks) {
      blocks.removeAttribute("opacity");
      clone.querySelectorAll(".fp-block").forEach(node => { node.setAttribute("opacity", "0"); blocks.appendChild(node); });
    }
    out.appendChild(clone);
  });
  return out;
}

function exportSvgXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(buildExportSvg());
}
document.getElementById("btnExportSvg").addEventListener("click", () => {
  downloadFile("gleisplan.svg", exportSvgXml(), "image/svg+xml");
});

/* ---------- Export: CSS ---------- */
function buildCss() {
  return `.fp-track, .fp-through { stroke: #cfd8dc; stroke-width: 7; fill: none; stroke-linecap: round; }
.fp-diverge { stroke: #78909c; stroke-width: 7; fill: none; stroke-linecap: round; }

/* Weichen: Zustand wird von ha-floorplan per class_set gesetzt */
.turnout-straight .fp-through { stroke: #ffb300; }
.turnout-straight .fp-diverge { stroke: #546069; }
.turnout-diverging .fp-through { stroke: #546069; }
.turnout-diverging .fp-diverge { stroke: #ffb300; }
/* Kopie des Abzweigs über dem Stammgleis: der gelbe Strang liegt immer oben */
.fp-diverge-top { display: none; }
.turnout-diverging .fp-diverge-top { display: inline; }

/* Links: Klick wechselt in HA auf eine andere Seite (tap_action: navigate) */
.fp-link { cursor: pointer; }
.fp-link-arrow { stroke: #4fc3f7; stroke-width: 5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.fp-link-hit, .fp-turnout-hit { fill: transparent; stroke: none; pointer-events: all; }

/* Weichen-Beschriftung */
.fp-label { fill: #cfd8dc; stroke: none; font: 600 11px sans-serif; }

/* Blockabschnitte: Grundzustand transparent, "belegt" wird per class_set gesetzt */
/* Transparent ist die gemeinsame Gruppe, nicht der einzelne Block: so mischen
   sich die Farben benachbarter belegter Blöcke an der Grenze nicht. */
.fp-blocks { opacity: 0.55; }
.fp-blocks > g { transition: opacity .3s ease; }
.fp-block-seg { fill: none; stroke-width: 16; stroke-linecap: round; }
/* Blöcke und Signale sind reine Anzeige: Klicks gehen durch sie hindurch */
#layer-blocks, #layer-signals { pointer-events: none; }
.block-free { opacity: 0 !important; }
.block-occupied { opacity: 1 !important; }

/* Signale */
/* ha-floorplan ersetzt per class_set die Klasse des Elements ("fp-signal" geht dabei
   verloren) – die Regeln dürfen deshalb nicht an der Klasse der Gruppe hängen. */
.mast { stroke: #8a959e; stroke-width: 2.5; stroke-linecap: round; fill: none; }
.housing { fill: #1b2026; stroke: #46515b; stroke-width: 1.5; }
/* Beide Lampen sind immer sichtbar: grau = aus, per class_set wird eine eingeschaltet */
.lamp { fill: #5a646d; stroke: #0a0d10; stroke-width: 0.75; transition: fill .2s ease; }
.signal-red .lamp-red { fill: #ff3b30; filter: drop-shadow(0 0 3px #ff3b30); }
.signal-green .lamp-green { fill: #34d058; filter: drop-shadow(0 0 3px #34d058); }
`;
}
document.getElementById("btnExportCss").addEventListener("click", () => {
  downloadFile("gleisplan.css", buildCss(), "text/css");
});

/* ---------- Export: ha-floorplan YAML ---------- */
function yamlStr(s) { return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

// fileBase: Dateiname von SVG/CSS ohne Endung (beim Veröffentlichen aus dem Plannamen)
function buildYaml(fileBase = "gleisplan") {
  const lines = [];
  lines.push("# Automatisch generierte ha-floorplan Konfiguration");
  lines.push("# Pfade an eure www/floorplan-Ablage in Home Assistant anpassen.");
  lines.push(`image: /local/floorplan/${fileBase}.svg`);
  lines.push(`stylesheet: /local/floorplan/${fileBase}.css`);
  lines.push("rules:");
  let any = false;

  Object.values(state.blocks).forEach(b => {
    if (!b.entity) return;
    any = true;
    lines.push(`  - name: ${yamlStr(b.name)}`);
    lines.push(`    entity: ${yamlStr(b.entity)}`);
    lines.push(`    element: ${yamlStr(b.id)}`);
    lines.push(`    tap_action: false`); // reine Anzeige, in HA nicht anklickbar
    lines.push(`    state_action:`);
    lines.push(`      action: call-service`);
    lines.push(`      service: floorplan.class_set`);
    lines.push(`      service_data:`);
    lines.push(`        class: '\${(entity.state === "on") ? "block-occupied" : "block-free"}'`);
  });

  Object.values(state.nodes).forEach(node => {
    if (!TURNOUT_TYPES.has(node.type) || !node.entity) return;
    any = true;
    lines.push(`  - name: ${yamlStr(node.label || node.id)}`);
    lines.push(`    entity: ${yamlStr(node.entity)}`);
    lines.push(`    element: ${yamlStr(node.id)}`);
    lines.push(`    tap_action:`);
    lines.push(`      action: call-service`);
    lines.push(`      service: switch.toggle`);
    lines.push(`      service_data:`);
    lines.push(`        entity_id: ${yamlStr(node.entity)}`);
    lines.push(`    state_action:`);
    lines.push(`      action: call-service`);
    lines.push(`      service: floorplan.class_set`);
    lines.push(`      service_data:`);
    lines.push(`        class: '\${(entity.state === "on") ? "turnout-diverging" : "turnout-straight"}'`);
  });

  // Links: keine Entity, ein Klick wechselt auf die Zielseite
  Object.values(state.nodes).forEach(node => {
    if (node.type !== "link" || !node.target) return;
    any = true;
    const external = /^https?:\/\//i.test(node.target);
    lines.push(`  - name: ${yamlStr(node.label || node.id)}`);
    lines.push(`    element: ${yamlStr(node.id)}`);
    lines.push(`    tap_action:`);
    lines.push(`      action: ${external ? "url" : "navigate"}`);
    lines.push(`      ${external ? "url_path" : "navigation_path"}: ${yamlStr(node.target)}`);
  });

  Object.values(state.signals).forEach(sig => {
    if (!sig.entity) return;
    any = true;
    lines.push(`  - name: ${yamlStr(sig.label || sig.id)}`);
    lines.push(`    entity: ${yamlStr(sig.entity)}`);
    lines.push(`    element: ${yamlStr(sig.id)}`);
    lines.push(`    tap_action: false`); // reine Anzeige, in HA nicht anklickbar
    lines.push(`    state_action:`);
    lines.push(`      action: call-service`);
    lines.push(`      service: floorplan.class_set`);
    lines.push(`      service_data:`);
    lines.push(`        class: '\${(entity.state === "on") ? "signal-green" : (entity.state === "off") ? "signal-red" : "signal-unknown"}'`);
  });

  if (!any) lines.push("  []  # Noch keine Elemente mit HA-Entity oder Link-Ziel verknüpft.");
  // Als komplette Karte ausgeben, damit sich das YAML direkt in eine Lovelace-Karte einfügen lässt
  const head = ["type: custom:floorplan-card", "full_height: true", "config:"];
  return head.concat(lines.map(l => "  " + l)).join("\n") + "\n";
}
document.getElementById("btnExportYaml").addEventListener("click", () => {
  downloadFile("gleisplan-floorplan.yaml", buildYaml(), "text/yaml");
});

/* ---------- Hilfe-Overlay ---------- */
const helpOverlay = document.getElementById("helpOverlay");
document.getElementById("btnHelp").addEventListener("click", () => { helpOverlay.hidden = false; });
document.getElementById("btnCloseHelp").addEventListener("click", () => { helpOverlay.hidden = true; });
helpOverlay.addEventListener("click", (ev) => { if (ev.target === helpOverlay) helpOverlay.hidden = true; });

/* ---------- Init ---------- */
initToolbarIcons();
if (!loadFromStorage()) state = normalizeState(state);
setTool("select");
if (loadView()) applyView(); else fitView();
if (Object.keys(state.nodes).length === 0) helpOverlay.hidden = false;
