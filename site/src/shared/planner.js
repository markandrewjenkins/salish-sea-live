// Trip-planner panel: one per page, wired to the page's MapLibre map. The page supplies how to score edges
// (0–1, higher = nicer), its stops and preset routes; this module handles the rest.
import maplibregl from "maplibre-gl";
import { el, fmtInt } from "./ui.js";
import { MODES, loadGraph, nearestNode, baseSeconds, routeVia, summarise, buildLoop, gpx, googleMapsUrl, download, fmtKm, fmtDur } from "./route.js";

export function createPlanner(opts) {
  const { host, map, graphUrl, scoreFor, stopsFor = () => [], presetsFor = () => [], describe = () => [],
    title = "Trip planner", modes = ["car", "bike", "foot"], initialMode, scoreLabel = "Scenery", defaultScenic = 3, clickToAdd = true, onRoute } = opts;
  const st = { city: null, mode: initialMode || modes[0], graphs: new Map(), pts: [], markers: [], route: null, scenic: defaultScenic,
    arm: clickToAdd, busy: false, presetId: null, loopMin: 60 };
  let G, secs, score, cost;

  // ---------------- panel
  const modeSeg = el("div", { class: "seg small pl-modes", role: "group", "aria-label": "Travel mode" },
    ...modes.map((m) => el("button", { type: "button", "data-m": m, "aria-pressed": String(m === st.mode), onclick: () => setMode(m) }, `${MODES[m].icon} ${MODES[m].label}`)));
  const armBtn = el("button", { type: "button", class: "pl-arm", "aria-pressed": String(st.arm), onclick: () => { st.arm = !st.arm; armBtn.setAttribute("aria-pressed", String(st.arm)); hint(); } }, "📍 Click map to add stops");
  const slider = el("input", { type: "range", min: "0", max: "6", step: "0.5", value: String(st.scenic), "aria-label": "Direct or scenic" });
  slider.addEventListener("change", () => { st.scenic = +slider.value; rebuildCost(); recompute(); });
  const loopSel = el("select", { "aria-label": "Loop length" }, ...[30, 45, 60, 90, 120].map((m) => el("option", { value: String(m), selected: m === st.loopMin ? "" : null }, `${m} min`)));
  loopSel.addEventListener("change", () => { st.loopMin = +loopSel.value; });
  const status = el("p", { class: "pl-status note" });
  const presetsBox = el("div", { class: "pl-presets" });
  const result = el("div", { class: "pl-result" });
  host.classList.add("planner");
  host.replaceChildren(
    el("div", { class: "pl-head" }, el("h3", { class: "pl-title" }, title), modeSeg),
    el("div", { class: "pl-row" }, armBtn, el("button", { type: "button", class: "pl-btn", onclick: clearAll }, "Clear")),
    el("label", { class: "pl-slider" }, el("span", {}, "Direct"), slider, el("span", {}, "Scenic")),
    el("div", { class: "pl-row" }, el("button", { type: "button", class: "pl-btn primary", onclick: () => makeLoop() }, "↻ Build a loop from the start"), loopSel),
    status, presetsBox, result);

  function hint(msg) {
    status.textContent = msg ?? (st.busy ? "Loading the road network…"
      : !st.pts.length ? (st.arm ? "Click the map to set a start point, then click again to add stops, or pick a ready-made route below." : "Pick a ready-made route below, or turn on “Click map to add stops”.")
      : st.pts.length === 1 ? "Add a stop, or build a loop from this start." : "Drag the pins to adjust. Shift-click a pin to remove it.");
  }

  // ---------------- map layers
  function addLayers() {
    if (map.getSource("plan-route")) return;
    map.addSource("plan-route", { type: "geojson", data: fc() });
    map.addLayer({ id: "plan-route-casing", type: "line", source: "plan-route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 12], "line-opacity": 0.85 } });
    map.addLayer({ id: "plan-route", type: "line", source: "plan-route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": getComputedStyle(document.body).getPropertyValue("--route").trim() || "#1f6feb",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 16, 7] } });
  }
  const fc = () => ({ type: "FeatureCollection", features: st.route ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: st.route.coords } }] : [] });
  const draw = () => map.getSource("plan-route")?.setData(fc());
  map.on("style.load", () => { addLayers(); draw(); });
  if (map.isStyleLoaded()) addLayers();

  map.on("click", (e) => {
    if (!st.arm || !G) return;
    const hits = map.queryRenderedFeatures(e.point).filter((f) => !String(f.layer.id).startsWith("plan-") && f.layer.type !== "background" && f.source !== "openmaptiles");
    if (hits.length && opts.ignoreClicksOn?.some((id) => hits.some((h) => h.layer.id === id))) return;
    addPoint([e.lngLat.lng, e.lngLat.lat]);
  });

  function addPoint(ll, { route = true } = {}) {
    const n = nearestNode(G, ll[0], ll[1]);
    if (n < 0) { hint(`No ${MODES[st.mode].label.toLowerCase()}-friendly road within 600 m of that spot.`); return; }
    st.pts.push(n);
    st.presetId = null;
    renderMarkers();
    if (route) recompute();
  }
  function renderMarkers() {
    st.markers.forEach((m) => m.remove());
    st.markers = st.pts.map((n, i) => {
      const loopEnd = i === st.pts.length - 1 && st.pts.length > 2 && n === st.pts[0];
      const pin = el("div", { class: `pl-pin${i === 0 ? " start" : ""}`, title: i === 0 ? "Start" : `Stop ${i}` }, i === 0 ? "S" : String(i));
      const m = new maplibregl.Marker({ element: pin, draggable: true }).setLngLat([G.lon[n], G.lat[n]]);
      if (!loopEnd) m.addTo(map);
      m.on("dragend", () => { const ll = m.getLngLat(); const nn = nearestNode(G, ll.lng, ll.lat); if (nn >= 0) { st.pts[i] = nn; if (loopEnd) st.pts[0] = nn; } renderMarkers(); recompute(); });
      pin.addEventListener("click", (ev) => { if (!ev.shiftKey) return; ev.stopPropagation(); st.pts.splice(i, 1); renderMarkers(); recompute(); });
      return m;
    });
  }
  function clearAll() { st.pts = []; st.route = null; st.presetId = null; renderMarkers(); draw(); result.replaceChildren(); presets(); hint(); onRoute?.(null); }

  // ---------------- routing
  // Routing uses each edge's rank (share of road length scoring lower), not the raw score: raw scores bunch together,
  // and a rank makes "scenic" mean "better than most roads here" whatever the scoring recipe.
  let rank;
  function rebuildCost() {
    if (!G) return;
    score = scoreFor(G, st.mode);
    const idx = Array.from({ length: G.E }, (_, i) => i).sort((p, q) => score[p] - score[q]);
    let total = 0, acc = 0;
    for (let e = 0; e < G.E; e++) total += G.len[e];
    rank = new Float32Array(G.E);
    for (const e of idx) { acc += G.len[e]; rank[e] = acc / total; }
    cost = new Float32Array(G.E);
    for (let e = 0; e < G.E; e++) cost[e] = secs[e] * (1 + st.scenic * (1 - rank[e]) ** 1.5);
  }
  const minPerM = () => 1 / ((MODES[st.mode].kmh ?? 90 * 0.85) / 3.6);
  function recompute() {
    if (!G || st.pts.length < 2) { st.route = null; draw(); renderResult(); hint(); return; }
    const steps = routeVia(G, cost, st.pts, minPerM());
    st.route = steps ? summarise(G, steps, secs, score) : null;
    draw(); renderResult(); hint(steps ? undefined : "Couldn't connect those points for this travel mode.");
    onRoute?.(st.route);
  }
  function makeLoop() {
    if (!G) return;
    if (!st.pts.length) { hint("Set a start point on the map first (turn on “Click map to add stops”)."); return; }
    hint("Building a loop…");
    setTimeout(() => {
      const cand = opts.loopCandidates ? opts.loopCandidates(G, score) : defaultCandidates();
      const lp = buildLoop(G, cost, secs, score, st.pts[0], st.loopMin * 60, cand, { rank });
      if (!lp) { hint("Couldn't find a good loop of that length from here. Try another start or length."); return; }
      st.pts = lp.waypoints; st.presetId = null; st.route = lp;
      renderMarkers(); draw(); renderResult(); hint(); onRoute?.(st.route);
    }, 20);
  }
  // default loop waypoints: the best-scoring stretches, one per ~400 m square
  // default loop waypoints: in each ~800 m square, the best stretch among the top 10% of roads, valued by its
  // quality with a bonus for having more good road around it
  function defaultCandidates() {
    const cells = new Map();
    for (let e = 0; e < G.E; e++) {
      if (G.len[e] < 60 || rank[e] < 0.9) continue;
      const k = `${Math.round(G.lon[G.a[e]] / 0.01)}_${Math.round(G.lat[G.a[e]] / 0.0072)}`;
      const c = cells.get(k) || { node: G.a[e], good: 0, best: 0 };
      c.good += G.len[e];
      if (rank[e] > c.best) { c.best = rank[e]; c.node = G.a[e]; }
      cells.set(k, c);
    }
    return [...cells.values()].map((c) => ({ node: c.node, value: c.best * Math.min(1.5, 0.5 + c.good / 1500) }));
  }

  function renderResult() {
    const r = st.route;
    if (!r) { result.replaceChildren(); return; }
    const near = stopsNear(r);
    const name = st.presetId ? presetsFor(st.city, st.mode).find((p) => p.id === st.presetId)?.name : null;
    result.replaceChildren(...[
      el("div", { class: "pl-stats" },
        el("div", {}, el("b", {}, fmtKm(r.metres)), el("span", {}, "distance")),
        el("div", {}, el("b", {}, fmtDur(r.seconds)), el("span", {}, `${MODES[st.mode].label.toLowerCase()} time`)),
        el("div", {}, el("b", {}, r.score == null ? "—" : `${Math.round(r.score * 100)}`), el("span", {}, `${scoreLabel.toLowerCase()} score`))),
      ...describe(r, G, st.mode, st.city).map(([k, v]) => el("div", { class: "pl-line" }, el("span", {}, k), el("b", {}, v))),
      near.length ? el("div", { class: "pl-stops" }, el("div", { class: "pl-sub" }, `Along the way (${near.length})`),
        el("ul", {}, ...near.slice(0, 10).map((s) => el("li", {}, el("span", { class: "pl-ico" }, s.icon || "•"), el("span", {}, s.name), el("i", {}, fmtKm(s.at)))))) : null,
      el("div", { class: "pl-row pl-export" },
        el("a", { class: "pl-btn", href: googleMapsUrl(r, st.mode), target: "_blank", rel: "noopener" }, "Open in Google Maps ↗"),
        el("button", { type: "button", class: "pl-btn", onclick: () => download(gpx(r, name || "Trip"), `${(name || "trip").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.gpx`) }, "Download GPX")),
      el("p", { class: "note pl-fine" }, "Google Maps may adjust the path between the sampled points. The GPX file follows this route exactly.")].filter(Boolean));
  }
  function stopsNear(r) {
    const list = stopsFor(st.city, st.mode) || [];
    if (!list.length) return [];
    const lat0 = r.coords[0][1], kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const pts = [], cum = [0];
    for (let i = 0; i < r.coords.length; i += 1) {
      pts.push([r.coords[i][0] * kx, r.coords[i][1] * 110540]);
      if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const lim = st.mode === "car" ? 150 : 90;
    const out = [];
    for (const s of list) {
      const x = s.lon * kx, y = s.lat * 110540;
      let bd = Infinity, at = 0;
      for (let i = 0; i < pts.length; i += 2) { const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2; if (d < bd) { bd = d; at = cum[i]; } }
      if (Math.sqrt(bd) <= lim) out.push({ ...s, at });
    }
    return out.sort((p, q) => p.at - q.at);
  }

  // ---------------- presets
  function presets() {
    const list = presetsFor(st.city, st.mode);
    presetsBox.replaceChildren(...(list.length ? [el("div", { class: "pl-sub" }, "Ready-made routes"),
      ...list.map((p) => el("button", { type: "button", class: `pl-preset${p.id === st.presetId ? " on" : ""}`, onclick: () => loadPreset(p) },
        p.tier ? el("span", { class: `pl-tier tier-${p.tier}` }, p.tier) : null,
        el("span", { class: "pl-pname" }, p.name), p.meta ? el("span", { class: "pl-pmeta" }, p.meta) : null))] : []));
  }
  function loadPreset(p) {
    if (!G) return;
    if (p.mode && p.mode !== st.mode) { setMode(p.mode, () => loadPreset(p)); return; }
    st.presetId = p.id;
    st.pts = p.waypoints.map(([x, y]) => nearestNode(G, x, y, 1500)).filter((n) => n >= 0);
    if (p.steps?.length) {                     // precomputed route: show exactly the path its rating describes
      st.route = summarise(G, p.steps, secs, score);
      renderMarkers(); draw(); renderResult(); hint(); onRoute?.(st.route);
    } else { renderMarkers(); recompute(); }
    presets();
    const b = st.route?.coords.reduce((bb, [x, y]) => [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)], [180, 90, -180, -90]);
    if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, duration: 900 });
  }

  // ---------------- city & mode
  async function ensure() {
    const key = `${st.city}/${st.mode}`;
    if (!st.graphs.has(key)) {
      st.busy = true; hint();
      try { st.graphs.set(key, await loadGraph(graphUrl(st.city, st.mode))); } catch (err) { st.busy = false; hint(`Couldn't load the road network (${err.message}).`); return false; }
      st.busy = false;
    }
    G = st.graphs.get(key); secs = baseSeconds(G, st.mode); rebuildCost();
    opts.onGraph?.(G, st.mode, st.city);
    return true;
  }
  async function setMode(m, then) {
    const ll = st.pts.map((n) => [G.lon[n], G.lat[n]]);
    st.mode = m;
    for (const b of modeSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.m === m));
    if (!(await ensure())) return;
    st.pts = ll.map(([x, y]) => nearestNode(G, x, y, 1500)).filter((n) => n >= 0);
    renderMarkers(); recompute(); presets(); hint();
    then?.();
  }
  async function setCity(c) {
    st.city = c; st.pts = []; st.route = null; st.presetId = null; renderMarkers(); draw(); result.replaceChildren();
    if (!(await ensure())) return;
    presets(); hint();
  }
  hint();
  return {
    setCity, loadPreset,
    rescore() {
      rebuildCost();
      if (st.presetId && st.route) { st.route = summarise(G, st.route.steps, secs, score); renderResult(); onRoute?.(st.route); }
      else recompute();
      presets();
    },
    // score of a fixed list of [edge, reversed] steps under the current scoring (for rating preset routes)
    rate(steps) { if (!G) return null; return summarise(G, steps, secs, score); },
    refreshPresets: () => presets(),
    get graph() { return G; }, get mode() { return st.mode; }, get route() { return st.route; }, get armed() { return st.arm; },
  };
}
