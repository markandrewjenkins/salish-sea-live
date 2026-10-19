import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import Hls from "hls.js";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt } from "../shared/ui.js";
import { skinSpectro, skinBasemap } from "./skin.js";

const DATA = "./data/salish/";
const S3 = "https://s3-us-west-2.amazonaws.com/audio-orcasound-net";
const SHIP_GROUPS = [
  ["Ferries & passenger", ["Passenger & ferry"], "--ship-1"],
  ["Cargo & tankers", ["Cargo", "Tanker"], "--ship-2"],
  ["Tugs & tows", ["Tug & tow"], "--ship-3"],
  ["Fishing, pleasure & other", ["Fishing", "Pleasure & sail", "Other"], "--ship-4"],
];
const WHALES = [["Orca", "var(--orca)"], ["Humpback", "#e87ba4"], ["Gray Whale", "#9085e9"]];
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();
let D, ships, inat, map;
const layers = { ships: true, whales: true, inat: false, phones: true };
const player = { audio: null, hls: null, ctx: null, analyser: null, raf: 0, node: null };

const fmt1 = d3.format(",.1f"), pct = (v) => `${Math.round(v * 100)}%`;
const axisClean = (a) => a.select(".domain").remove();

init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  [D, ships, inat] = await Promise.all([loadJSON(`${DATA}salish.json`), loadJSON(`${DATA}ships_day.json`).catch(() => null), loadJSON(`${DATA}whales_inat.json`).catch(() => [])]);
  window.dispatchEvent(new CustomEvent("salish:data", { detail: { D, ships } }));  // for the design skin
  renderPhones();
  renderSide();
  buildLayers();
  initMap();
  renderCalls();
  renderAll();
  document.getElementById("generated").textContent = `Data refreshed ${new Date(D.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;
  let raf, lastW = 0;
  new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(renderAll); })
    .observe(document.querySelector("main"));
  window.addEventListener("themechange", () => { map?.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light); renderAll(); });
}

function renderAll() { renderOutlook(); renderMonths(); renderWeekly(); renderTriage(); renderInat(); renderShips(); }

function frame(id, height, m) {
  const host = document.getElementById(id);
  const width = Math.max(240, host.clientWidth);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: width - m.l - m.r, ih: height - m.t - m.b, width };
}
const colPath = (x0, w, y0, base, r = 3) => { const h = base - y0, rr = Math.min(r, h, w / 2);
  return h <= 0 ? "" : `M${x0},${base}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + w - rr}Q${x0 + w},${y0} ${x0 + w},${y0 + rr}V${base}Z`; };
const barPath = (w, y0, h, r = 4) => { const rr = Math.min(r, w); return `M0,${y0}H${w - rr}Q${w},${y0} ${w},${y0 + rr}V${y0 + h - rr}Q${w},${y0 + h} ${w - rr},${y0 + h}H0Z`; };

// ------------------------------------------------------------------ live hydrophones
function renderPhones() {
  const host = document.getElementById("phones");
  host.replaceChildren(...Object.entries(D.hydrophones).map(([id, h]) => {
    const fc = D.outlook.forecast[id];
    return el("button", { type: "button", class: "phone", "data-id": id, "aria-pressed": "false", onclick: () => toggle(id) },
      el("span", { class: "btn", "aria-hidden": "true" }, "▶"),
      el("span", { class: "nm" }, h.name),
      el("span", { class: "st" }, fc ? el("b", {}, pct(fc.p)) : "", fc ? " chance of whale sounds this week" : `${h.reports_30d} whale reports in 30 days`));
  }));
}

async function toggle(id) {
  const same = player.node === id;
  stop();
  if (same) return;
  player.node = id;
  document.querySelectorAll(".phone").forEach((b) => { const on = b.dataset.id === id; b.setAttribute("aria-pressed", on); b.querySelector(".btn").textContent = on ? "■" : "▶"; });
  const wrap = document.getElementById("spectro-wrap");
  wrap.hidden = false;
  document.getElementById("now-playing").textContent = D.hydrophones[id].name;
  document.getElementById("now-sub").textContent = "connecting…";
  try {
    const ts = (await (await fetch(`${S3}/${id}/latest.txt`, { cache: "no-store" })).text()).trim();
    const url = `${S3}/${id}/hls/${ts}/live.m3u8`;
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    player.audio = audio;
    if (Hls.isSupported()) { player.hls = new Hls({ liveSyncDurationCount: 3 }); player.hls.loadSource(url); player.hls.attachMedia(audio); }
    else audio.src = url;
    player.ctx = player.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const src = player.ctx.createMediaElementSource(audio);
    player.analyser = player.ctx.createAnalyser();
    player.analyser.fftSize = 1024;
    src.connect(player.analyser).connect(player.ctx.destination);
    await player.ctx.resume();
    await audio.play();
    const ageMin = Math.round((Date.now() / 1000 - +ts) / 60);
    document.getElementById("now-sub").textContent = ageMin > 60 * 6 ? "the stream may be offline: the newest segment is old" : "live";
    window.dispatchEvent(new CustomEvent("salish:listen", { detail: { name: D.hydrophones[id].name, live: ageMin <= 60 * 6 } }));
    drawSpectrogram();
  } catch (e) {
    console.warn(e);
    document.getElementById("now-sub").textContent = "This hydrophone isn't streaming right now. Try another.";
  }
}
function stop() {
  cancelAnimationFrame(player.raf);
  player.hls?.destroy(); player.hls = null;
  if (player.audio) { player.audio.pause(); player.audio.src = ""; player.audio = null; }
  player.node = null;
  window.dispatchEvent(new CustomEvent("salish:listen", { detail: null }));
  document.querySelectorAll(".phone").forEach((b) => { b.setAttribute("aria-pressed", "false"); b.querySelector(".btn").textContent = "▶"; });
}
function drawSpectrogram() {
  const c = document.getElementById("spectro");
  const ctx = c.getContext("2d");
  c.width = c.clientWidth * devicePixelRatio; c.height = 160 * devicePixelRatio;
  const bins = player.analyser.frequencyBinCount;
  const data = new Uint8Array(bins);
  const inferno = d3.scaleSequential(d3.interpolateInferno).domain([0, 255]);
  const step = () => {
    const color = skinSpectro() || inferno;           // the design skin swaps in its own colormap
    player.analyser.getByteFrequencyData(data);
    ctx.drawImage(c, -2, 0);                          // scroll left
    const h = c.height;
    for (let y = 0; y < h; y++) {
      const v = data[Math.floor(((h - 1 - y) / h) * bins)];
      ctx.fillStyle = color(v);
      ctx.fillRect(c.width - 2, y, 2, 1);
    }
    player.raf = requestAnimationFrame(step);
  };
  step();
}

// ------------------------------------------------------------------ map
function buildLayers() {
  const defs = [
    ["whales", "Whale reports, this week", WHALES.map(([n, c]) => [n, c, "dot"])],
    ["inat", "Whale photos, iNaturalist (all years)", [["observation", "var(--muted)", "dot"]]],
    ["ships", "Ship tracks, a summer weekday", SHIP_GROUPS.map(([n, , v]) => [n, `var(${v})`, "ln"])],
    ["phones", "Hydrophones (click to listen)", [["hydrophone", "var(--sea)", "dot"]]],
  ];
  document.getElementById("layers").replaceChildren(...defs.map(([k, label, keys]) => el("div", {},
    el("label", {}, el("input", { type: "checkbox", checked: layers[k], onchange: (e) => { layers[k] = e.target.checked; applyVis(); } }), label),
    el("div", { class: "key" }, ...keys.map(([t, c, shape]) => el("span", {}, el("i", { class: shape === "ln" ? "ln" : "", style: { background: c, outline: t === "Orca" ? "1.5px solid var(--axis)" : "" } }), t))))));
}
function renderSide() {
  const s = D.sightings || [];
  const by = d3.rollup(s, (v) => d3.sum(v, (x) => x.count || 1), (x) => x.type);
  const last = D.recent_confirmed[0];
  document.getElementById("tiles-side").replaceChildren(...[
    el("div", { class: "stat-mini" }, el("b", {}, `${s.length}`), el("span", {}, `whale reports this week: ${[...by].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`)),
    last ? el("div", { class: "stat-mini" }, el("b", {}, new Date(last.time).toLocaleDateString("en-CA", { month: "short", day: "numeric" })), el("span", {}, `last AI-detected, volunteer-confirmed orca call, ${last.name}`)) : null,
    el("div", { class: "stat-mini" }, el("b", {}, fmtInt.format(d3.sum(Object.values(D.hydrophones), (h) => h.reports_30d))), el("span", {}, "listener reports of whale sounds in the last 30 days")),
    D.ship_stats ? el("div", { class: "stat-mini" }, el("b", {}, fmtInt.format(d3.sum(Object.values(D.ship_stats)))), el("span", {}, "vessels moving on a typical summer weekday")) : null].filter(Boolean));
}
function initMap() {
  map = new maplibregl.Map({ container: "map", style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light, center: [-123.0, 48.35], zoom: 7.6,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  map.on("style.load", () => { addLayers(); skinBasemap(map, isDark()); });
  const pop = new maplibregl.Popup({ maxWidth: "280px" });
  map.on("click", "phones", (e) => { toggle(e.features[0].properties.id); window.scrollTo({ top: 0, behavior: "smooth" }); });
  map.on("click", "whales", (e) => { const p = e.features[0].properties;
    pop.setLngLat(e.lngLat).setDOMContent(el("div", {}, el("b", {}, `${p.type}${p.count > 1 ? ` × ${p.count}` : ""}`), el("div", { class: "note" }, `${p.created} · via ${p.source}`))).addTo(map); });
  for (const l of ["phones", "whales"]) {
    map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("mousemove", "phones", (e) => { const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name), tipRow(null, "click", "to listen live"))); });
  map.on("mouseleave", "phones", () => tip.hide());
  map.on("mousemove", "ships", (e) => { const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name || "Vessel"), tipRow(null, p.cat, p.len ? `${Math.round(p.len)} m` : ""))); });
  map.on("mouseleave", "ships", () => tip.hide());
}
function addLayers() {
  const pt = (lon, lat, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
  if (ships) {
    map.addSource("ships", { type: "geojson", data: ships });
    map.addLayer({ id: "ships", type: "line", source: "ships", paint: {
      "line-color": ["match", ["get", "cat"], ...SHIP_GROUPS.flatMap(([, cats, v]) => cats.flatMap((c) => [c, cssVar(v)])), cssVar("--ship-4")],
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 11, 1.6], "line-opacity": 0.55 } });
  }
  map.addSource("inat", { type: "geojson", data: { type: "FeatureCollection", features: inat.map(([sp, date, lat, lon]) => pt(lon, lat, { sp, date })) } });
  map.addLayer({ id: "inat", type: "circle", source: "inat", layout: { visibility: "none" }, paint: { "circle-radius": 2.5, "circle-color": cssVar("--muted"), "circle-opacity": 0.5 } });
  map.addSource("whales", { type: "geojson", data: { type: "FeatureCollection", features: (D.sightings || []).filter((s) => s.lat).map((s) => pt(s.lon, s.lat, s)) } });
  map.addLayer({ id: "whales", type: "circle", source: "whales", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5, 11, 9],
    "circle-color": ["match", ["get", "type"], "Orca", cssVar("--orca"), "Humpback", "#e87ba4", "Gray Whale", "#9085e9", cssVar("--muted")],
    "circle-stroke-color": isDark() ? "#000" : "#fff", "circle-stroke-width": 2 } });
  map.addSource("phones", { type: "geojson", data: { type: "FeatureCollection", features: Object.entries(D.hydrophones).map(([id, h]) => pt(h.lon, h.lat, { id, name: h.name })) } });
  map.addLayer({ id: "phones", type: "circle", source: "phones", paint: { "circle-radius": 9, "circle-color": cssVar("--sea"), "circle-stroke-color": cssVar("--surface"), "circle-stroke-width": 3 } });
  applyVis();
}
function applyVis() {
  if (!map?.getLayer("phones")) return;
  for (const [k, on] of Object.entries(layers)) if (map.getLayer(k)) map.setLayoutProperty(k, "visibility", on ? "visible" : "none");
}

// ------------------------------------------------------------------ calls
function renderCalls() {
  if (!D.recent_confirmed.length) {
    document.getElementById("calls").replaceChildren(el("div", { class: "card note" }, "Recorded clips come from the OrcaHello detection service, which is temporarily unavailable. They'll appear here on the next refresh after it's back."));
    return;
  }
  document.getElementById("calls").replaceChildren(...D.recent_confirmed.slice(0, 8).map((c) => el("div", { class: "card call" },
    el("img", { src: c.spectrogram, alt: `Spectrogram of an orca call at ${c.name}`, loading: "lazy" }),
    el("div", { class: "b" }, el("div", { class: "nm" }, c.name),
      el("div", { class: "t" }, `${new Date(c.time).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}${c.tags ? ` · ${String(c.tags).replace(/;/g, ", ")}` : ""}`),
      el("audio", { controls: true, preload: "none", src: c.audio })))));
}

// ------------------------------------------------------------------ charts
function renderOutlook() {
  const o = D.outlook;
  document.getElementById("outlook-sub").textContent = `Based on ${fmtInt.format(D.n_reports)} reports of whale sounds from Orcasound's live listeners. Week of ${new Date(o.next_week + "T12:00").toLocaleDateString("en-CA", { month: "long", day: "numeric" })}. On 2025–2026 weeks the model's Brier score was ${o.brier.toFixed(3)}. That's ${Math.round(o.skill_recent * 100)}% better than using each hydrophone's share of recent weeks with reports (${o.brier_recent.toFixed(3)}), and ${Math.round(o.skill * 100)}% better than its usual rate for the month (${o.brier_clim.toFixed(3)}). Listening grew in 2025–26, which flatters that second baseline.`;
  const rows = Object.entries(o.forecast).map(([id, f]) => ({ id, name: D.hydrophones[id].name, ...f })).sort((a, b) => b.p - a.p);
  const rowH = 34, m = { l: 170, r: 60, t: 4, b: 4 };
  const { g, iw } = frame("outlook", m.t + m.b + rowH * rows.length, m);
  const x = d3.scaleLinear([0, 1], [0, iw]);
  const r_ = g.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  r_.append("rect").attr("x", 0).attr("width", iw).attr("y", 8).attr("height", rowH - 16).attr("rx", 4).style("fill", "var(--surface-2)");
  r_.append("path").attr("d", (d) => barPath(Math.max(2, x(d.p)), 8, rowH - 16)).style("fill", "var(--sea)");
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.name);
  r_.append("text").attr("class", "label strong").attr("x", iw + 8).attr("y", rowH / 2).attr("dy", "0.35em").text((d) => pct(d.p));
  r_.append("rect").attr("x", -m.l).attr("width", iw + m.l + m.r).attr("height", rowH).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d.name),
      tipRow(cssVar("--sea"), pct(d.p), "chance listeners report whale sounds this week"), tipRow(null, d.heard_last_week ? "yes" : "no", "heard last week"),
      tipRow(null, `${d.weeks_heard_last4} of 4`, "recent weeks with calls"))))
    .on("pointerleave", () => tip.hide());
}

function renderMonths() {
  const total = d3.range(12).map((i) => d3.sum(Object.values(D.outlook.by_month), (arr) => arr[i]));
  const m = { l: 36, r: 8, t: 14, b: 22 };
  const { g, iw, ih } = frame("months", 220, m);
  const x = d3.scaleBand(d3.range(12), [0, iw]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(total)]).nice().range([ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((i) => d3.timeFormat("%b")(new Date(2001, i, 1))).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.min(24, x.bandwidth());
  g.selectAll("path").data(total).join("path").attr("d", (v, i) => colPath(x(i) + (x.bandwidth() - bw) / 2, bw, y(v), ih)).style("fill", "var(--sea)")
    .on("pointermove", (e, v) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d3.timeFormat("%B")(new Date(2001, total.indexOf(v), 1))), tipRow(cssVar("--sea"), fmtInt.format(v), "whale reports"))))
    .on("pointerleave", () => tip.hide());
}

function renderWeekly() {
  const all = D.outlook.weekly.map(([d, v]) => ({ d: new Date(d + "T12:00"), v }));
  const first = all.findIndex((r) => r.v > 0);
  const rows = all.slice(Math.max(0, first - 2));
  document.getElementById("weekly-title").textContent = `Every week since ${d3.timeFormat("%B %Y")(rows[0].d)}`;
  const m = { l: 36, r: 8, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame("weekly", 180, m);
  const x = d3.scaleTime(d3.extent(rows, (r) => r.d), [0, iw]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.v)]).nice().range([ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(7).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.max(1, iw / rows.length - 1);
  g.selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.d)).attr("width", bw).attr("y", (r) => y(r.v)).attr("height", (r) => ih - y(r.v)).style("fill", "var(--sea)");
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const r = rows[d3.bisector((q) => q.d).center(rows, x.invert(px))];
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Week of ${d3.timeFormat("%b %-d, %Y")(r.d)}`), tipRow(cssVar("--sea"), String(r.v), "whale reports"))); })
    .on("pointerleave", () => tip.hide());
}

function renderTriage() {
  const T = D.triage;
  document.getElementById("pr").closest(".grid").hidden = !T;
  if (!T) {
    document.getElementById("tri-metrics").replaceChildren(el("div", { class: "card note" }, "The OrcaHello detection service was unavailable when this page was built, so the triage model is waiting for its training data. It will train automatically on the next refresh once the service is back."));
    for (const id of ["pr", "tri-imp"]) document.getElementById(id).replaceChildren();
    return;
  }
  const w95 = T.workload["95"], w90 = T.workload["90"];
  document.getElementById("tri-metrics").replaceChildren(...[
    ["Ranking skill (AUC)", T.auc_model.toFixed(3), `vs ${T.auc_base.toFixed(3)} using the AI's confidence alone`],
    ["Average precision", T.ap_model.toFixed(3), `vs ${T.ap_base.toFixed(3)} baseline · ${pct(T.pos_rate_test)} of test flags were real orcas`],
    ["Clips to review for 95% of calls", pct(w95.model_share), `vs ${pct(w95.base_share)} sorting by AI confidence`],
    ["Clips to review for 90% of calls", pct(w90.model_share), `vs ${pct(w90.base_share)} sorting by AI confidence`],
  ].map(([l, v, s]) => el("div", { class: "card metric" }, el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
  // PR curves
  const m = { l: 40, r: 12, t: 10, b: 34 };
  const { g, iw, ih } = frame("pr", 280, m);
  const x = d3.scaleLinear([0, 1], [0, iw]), y = d3.scaleLinear([0, 1], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 30).attr("text-anchor", "middle").text("Recall: share of real orca calls caught");
  const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
  g.append("path").datum(T.pr_base).attr("d", line).style("fill", "none").style("stroke", "var(--pr-base, var(--muted))").style("stroke-width", 2).style("stroke-dasharray", "7 4");
  g.append("path").datum(T.pr_model).attr("d", line).style("fill", "none").style("stroke", "var(--sea)").style("stroke-width", 2.5);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(T.pos_rate_test)).attr("y2", y(T.pos_rate_test)).style("stroke", "var(--axis)").style("stroke-dasharray", "3 3");
  g.append("text").attr("class", "label").attr("x", 4).attr("y", y(T.pos_rate_test) - 4).style("font-size", "10.5px").text("random");
  document.getElementById("pr-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--sea)" } }), "Second-stage model"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "repeating-linear-gradient(90deg, var(--pr-base, var(--muted)) 0 7px, transparent 7px 11px)" } }), "AI confidence alone"));
  // importance
  const imp = Object.entries(T.importance).map(([k, v]) => [k, Math.max(0, v)]).sort((a, b) => b[1] - a[1]).slice(0, 9);
  const rowH = 26, mm = { l: 200, r: 50, t: 4, b: 4 };
  const fr = frame("tri-imp", mm.t + mm.b + rowH * imp.length, mm);
  const xx = d3.scaleLinear([0, d3.max(imp, (d) => d[1]) || 1], [0, fr.iw]);
  const rr = fr.g.selectAll("g").data(imp).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  rr.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d[0]);
  rr.append("path").attr("d", (d) => barPath(Math.max(2, xx(d[1])), (rowH - 14) / 2, 14)).style("fill", "var(--sea)");
  rr.append("text").attr("class", "label strong").attr("x", (d) => xx(d[1]) + 6).attr("y", rowH / 2).attr("dy", "0.35em").style("font-size", "11px").text((d) => d[1].toFixed(3));
}

function renderInat() {
  const host = document.getElementById("inat-season");
  document.getElementById("inat-sub").textContent = `${fmtInt.format(D.inat_total)} research-grade observations by month in the Salish Sea.`;
  host.replaceChildren(...Object.entries(D.inat_season).map(([sp, arr]) => {
    const id = `inat-${sp.replace(/\W/g, "")}`;
    return el("div", {}, el("div", { class: "sp-title" }, sp), el("div", { class: "chart", id }));
  }));
  for (const [sp, arr] of Object.entries(D.inat_season)) {
    const id = `inat-${sp.replace(/\W/g, "")}`;
    const m = { l: 4, r: 4, t: 8, b: 18 };
    const { g, iw, ih } = frame(id, 90, m);
    const x = d3.scaleBand(d3.range(12), [0, iw]).padding(0.2);
    const y = d3.scaleLinear([0, d3.max(arr) || 1], [ih, 0]);
    const bw = Math.min(16, x.bandwidth());
    g.selectAll("path").data(arr).join("path").attr("d", (v, i) => colPath(x(i) + (x.bandwidth() - bw) / 2, bw, y(v), ih, 2)).style("fill", "var(--sea)");
    g.selectAll("text").data(arr).join("text").attr("class", "label").attr("x", (_, i) => x(i) + x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle")
      .style("font-size", "9.5px").text((_, i) => "JFMAMJJASOND"[i]);
  }
}

function renderShips() {
  if (!D.ship_stats) return;
  const rows = SHIP_GROUPS.map(([name, cats, v]) => ({ name, v, n: d3.sum(cats, (c) => D.ship_stats[c] || 0) })).sort((a, b) => b.n - a.n);
  const rowH = 34, m = { l: 170, r: 60, t: 4, b: 4 };
  const { g, iw } = frame("ships", m.t + m.b + rowH * rows.length, m);
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r.n)], [0, iw]);
  const r_ = g.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  r_.append("path").attr("d", (d) => barPath(Math.max(2, x(d.n)), 9, rowH - 18)).style("fill", (d) => `var(${d.v})`);
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.name);
  r_.append("text").attr("class", "label strong").attr("x", (d) => x(d.n) + 8).attr("y", rowH / 2).attr("dy", "0.35em").text((d) => fmtInt.format(d.n));
}
