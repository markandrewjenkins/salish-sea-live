import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import Hls from "hls.js";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt } from "../shared/ui.js";
import { skinSpectro, skinBasemap } from "./skin.js";

const DATA = "./data/salish/";
const S3 = "https://s3-us-west-2.amazonaws.com/audio-orcasound-net";
const TZ = "America/Los_Angeles";
// Vessel categories in their established order. Colours keep their meaning: blue = passenger, orange = cargo
// (tanker a deeper shade of it), green = tugs, amber = fishing / pleasure / other (pleasure and other as shades).
const SHIP_CATS = [
  ["Passenger & ferry", "--ship-1", 0], ["Cargo", "--ship-2", 0], ["Tanker", "--ship-2", 0.32],
  ["Tug & tow", "--ship-3", 0], ["Fishing", "--ship-4", 0], ["Pleasure & sail", "--ship-4", 0.34], ["Other", "--ship-4", -0.6],
];
// Sighting species groups (same order as pipelines/salish/build.py SPECIES)
const SP_COLOURS = ["var(--orca)", "var(--orca-2)", "#e87ba4", "#9085e9", "#3fa7c9", "#8a9a5b", "var(--muted)"];
const SP_SHORT = ["Southern Resident orca", "Other orca", "Humpback", "Grey whale", "Minke", "Porpoise / dolphin", "Other / unknown"];
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const TIER_ORDER = ["S", "A", "B", "C", "D"];

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();
let D, inat, sights, shipIdx, map;
const layers = { ships: true, whales: true, inat: false, phones: true, others: true };
const player = { audio: null, hls: null, ctx: null, analyser: null, raf: 0, node: null };
const clip = { audio: null, hls: null, btn: null, url: null };
const shipCache = new Map();                       // day -> decoded GeoJSON features
const state = { from: null, to: null, shipSel: null, cats: new Set(SHIP_CATS.map((c) => c[0])), shipFeatures: [] };

const pct = (v) => `${Math.round(v * 100)}%`;
const axisClean = (a) => a.select(".domain").remove();
const localDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (iso, opt = { month: "short", day: "numeric" }) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { ...opt, timeZone: "UTC" });
const fmtWhen = (t) => new Date(t).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
const ago = (t) => { const m = Math.max(0, (Date.now() - new Date(t)) / 60000);
  return m < 90 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  [D, inat, sights, shipIdx] = await Promise.all([loadJSON(`${DATA}salish.json`), loadJSON(`${DATA}whales_inat.json`).catch(() => []),
    loadJSON(`${DATA}sightings.json`).catch(() => null), loadJSON(`${DATA}ships/index.json`).catch(() => null)]);
  prepSightings();
  const today = localDay(new Date());
  state.to = today;
  state.from = addDays(today, -6);
  state.shipSel = shipIdx?.days?.length ? `d:${shipIdx.days.at(-1).date}` : D.live_ships ? "live" : null;
  window.dispatchEvent(new CustomEvent("salish:data", { detail: { D, ships: null } }));  // for the design skin
  renderPhones();
  renderFresh();
  renderDates();
  buildLayers();
  renderShipList();
  renderCoverage();
  initMap();
  renderTiers();
  renderAll();
  await loadShips();
  document.getElementById("generated").textContent = `Pipeline last ran ${fmtWhen(D.generated)} Pacific. Whale dates on this page are when the whale was reported, not when the page was built.`;
  let raf, lastW = 0;
  new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(renderAll); })
    .observe(document.querySelector("main"));
  window.addEventListener("themechange", () => { map?.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light); renderShipList(); renderAll(); });
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

// Ship colours come from the skin's four tokens; the three extra categories are shades of their group's colour.
function shipColours() {
  const dark = isDark();
  return Object.fromEntries(SHIP_CATS.map(([cat, v, k]) => {
    const base = cssVar(v) || "#888";
    if (!k) return [cat, base];
    if (k < 0) return [cat, d3.interpolateLab(base, cssVar("--muted") || "#888")(-k)];
    return [cat, d3.interpolateLab(base, dark ? "#ffffff" : "#000000")(k)];
  }));
}

// ------------------------------------------------------------------ data prep
function prepSightings() {
  const cols = sights?.cols || [];
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  sights = (sights?.rows || []).map((r) => {
    const t = r[ix.t], timed = t.length > 10;
    const date = timed ? new Date(t) : null;
    return { t, timed, date, day: timed ? localDay(date) : t, lon: r[ix.lon], lat: r[ix.lat], sp: r[ix.sp], n: r[ix.n], src: r[ix.src], ref: r[ix.ref] };
  });
  // legacy shape for the design skin's scope and strip: Acartia reports of the last 7 days
  const cut = Date.now() - 7 * 864e5;
  D.sightings = sights.filter((s) => s.src === 0 && s.timed && s.date >= cut)
    .map((s) => ({ type: SP_SHORT[s.sp], count: s.n, lat: s.lat, lon: s.lon, created: s.t.replace("T", " ").replace("Z", ""), source: "Acartia" }));
}
const inRange = (day) => day >= state.from && day <= state.to;

// ------------------------------------------------------------------ freshness
function renderFresh() {
  const host = document.getElementById("fresh");
  const fresh = D.freshness || [];
  const chip = (f) => {
    let cls = "ok", val = "—", sub = "";
    if (f.id === "ais") {
      val = f.newest ? `to ${fmtDay(f.newest, { month: "short", day: "numeric", year: "numeric" })}` : "none";
      sub = "NOAA publishes AIS in batches, months later";
      cls = f.newest ? "info" : "bad";
    } else if (f.id === "live") {
      if (f.skipped || !D.live_ships) { val = "not configured"; sub = "needs a free aisstream.io key"; cls = "info"; }
      else { val = fmtWhen(f.newest); sub = "snapshot"; }
    } else {
      val = f.newest ? fmtWhen(f.newest) : "none";
      sub = f.newest ? `newest record, ${ago(f.newest)}` : "";
      const ageH = f.newest ? (Date.now() - new Date(f.newest)) / 36e5 : Infinity;
      cls = f.ok === false ? "bad" : ageH > 72 ? "warn" : "ok";
      if (f.ok === false) sub = `last fetch failed; data from ${f.last_ok ? fmtWhen(f.last_ok) : "an earlier run"}`;
    }
    return el("div", { class: `fr ${cls}`, title: f.error || "" }, el("i", { "aria-hidden": "true" }),
      el("span", { class: "fr-l" }, f.label), el("b", {}, val), el("span", { class: "fr-s" }, sub));
  };
  host.replaceChildren(
    el("div", { class: "fr-head" }, el("b", {}, `Pipeline ran ${fmtWhen(D.generated)}`), el("span", { class: "note" }, "Pacific time. Each source shows its newest record, so a quiet day for whales doesn't look like a broken page.")),
    el("div", { class: "fr-row" }, ...fresh.map(chip)));
}

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
  stopClip();
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

// ------------------------------------------------------------------ map controls
function renderDates() {
  const host = document.getElementById("dates");
  const today = localDay(new Date());
  const first = sights.length ? d3.min(sights, (s) => s.day) : addDays(today, -30);
  const from = el("input", { type: "date", min: first, max: today, value: state.from, "aria-label": "First day" });
  const to = el("input", { type: "date", min: first, max: today, value: state.to, "aria-label": "Last day" });
  const presets = [["Today", 0], ["3 days", 2], ["7 days", 6], ["30 days", 29], ["90 days", 89]];
  const chips = el("div", { class: "chips" }, ...presets.map(([label, n]) => el("button", { type: "button", class: "dchip", "data-n": n, onclick: () => {
    state.to = today; state.from = addDays(today, -n) < first ? first : addDays(today, -n); from.value = state.from; to.value = state.to; paint(); applyDates(); } }, label)));
  const paint = () => chips.querySelectorAll(".dchip").forEach((c) => c.setAttribute("aria-pressed", String(state.to === today && state.from === (addDays(today, -c.dataset.n) < first ? first : addDays(today, -c.dataset.n)))));
  const onInput = () => {
    if (!from.value || !to.value) return;
    state.from = from.value < first ? first : from.value; state.to = to.value > today ? today : to.value;
    if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
    from.value = state.from; to.value = state.to; paint(); applyDates();
  };
  from.addEventListener("change", onInput); to.addEventListener("change", onInput);
  // ship days: NOAA archive days (newest first), multi-day spans, and today's live snapshot
  const days = (shipIdx?.days || []).map((d) => d.date);
  const opts = [];
  opts.push(el("option", { value: "live" }, D.live_ships ? `Today, live (${D.live_ships.length} ships)` : "Today, live (needs an aisstream.io key)"));
  if (days.length > 1) {
    opts.push(el("option", { value: `r:${days.at(-Math.min(7, days.length))}:${days.at(-1)}` }, `Latest ${Math.min(7, days.length)} AIS days (${fmtDay(days.at(-Math.min(7, days.length)))}–${fmtDay(days.at(-1))})`));
    if (days.length > 7) opts.push(el("option", { value: `r:${days[0]}:${days.at(-1)}` }, `All ${days.length} AIS days (${fmtDay(days[0])}–${fmtDay(days.at(-1))})`));
  }
  for (const d of [...days].reverse()) opts.push(el("option", { value: `d:${d}` }, fmtDay(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })));
  const sel = el("select", { "aria-label": "Ship-track days", onchange: (e) => { state.shipSel = e.target.value; loadShips(); } }, ...opts);
  sel.value = state.shipSel || "live";
  host.replaceChildren(
    el("div", { class: "dgroup" }, el("div", { class: "dlab" }, "Whale sightings & listener reports"), chips,
      el("div", { class: "drange" }, from, el("span", { "aria-hidden": "true" }, "to"), to),
      el("div", { class: "note" }, `Reports run up to today. Acartia history here starts ${fmtDay(sights.find((s) => s.src === 0)?.day || first)}, iNaturalist ${fmtDay(sights.find((s) => s.src === 1)?.day || first)}.`)),
    el("div", { class: "dgroup" }, el("div", { class: "dlab" }, "Ship tracks"), sel, el("div", { class: "note", id: "ship-note" })));
  paint();
}

function applyDates() {
  if (map?.getSource("whales")) map.getSource("whales").setData(whaleGeo());
  if (map?.getSource("phones")) map.getSource("phones").setData(phoneGeo());
  renderSide();
}

async function loadShips() {
  const sel = state.shipSel || "live";
  const note = document.getElementById("ship-note");
  let days = [];
  if (sel.startsWith("d:")) days = [sel.slice(2)];
  else if (sel.startsWith("r:")) { const [, a, b] = sel.split(":"); days = shipIdx.days.map((d) => d.date).filter((d) => d >= a && d <= b); }
  if (sel === "live") {
    state.shipFeatures = [];
    note.textContent = D.live_ships
      ? `Snapshot of ${D.live_ships.length} ships from aisstream.io at ${fmtWhen(D.live_fetched)}. Positions only, no tracks.`
      : "Live ship positions need a free aisstream.io API key (the AISSTREAM_API_KEY secret). None is configured, so no ships are shown for today. Whale sightings and listener reports for today are still on the map.";
  } else {
    note.textContent = days.length ? "Loading…" : "";
    const feats = [];
    for (const d of days) {
      if (!shipCache.has(d)) {
        try { shipCache.set(d, decodeDay(await loadJSON(`${DATA}ships/${d}.json`))); }
        catch (e) { console.warn(e); shipCache.set(d, []); }
      }
      feats.push(...shipCache.get(d));
    }
    if (state.shipSel !== sel) return;                 // a newer choice arrived while loading
    state.shipFeatures = feats;
    note.textContent = `${days.length > 1 ? `${days.length} days` : fmtDay(days[0], { weekday: "long", month: "long", day: "numeric", year: "numeric" })} of US Coast Guard AIS, the latest NOAA has published. Ship dates can't match the whale dates: the archive runs months behind.`;
  }
  if (map?.getSource("ships")) map.getSource("ships").setData({ type: "FeatureCollection", features: state.shipFeatures });
  if (map?.getSource("live")) map.getSource("live").setData(liveGeo());
  renderShipList();
  renderSide();
  renderShips();
  window.dispatchEvent(new CustomEvent("salish:ships", { detail: { vessels: selectedShipCounts().total, live: sel === "live" } }));
}

function decodeDay(d) {
  const feats = [];
  for (const [ci, vi, flat] of d.tracks) {
    let x = 0, y = 0;
    const coords = new Array(flat.length / 2);
    for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; coords[i / 2] = [x / 1e4, y / 1e4]; }
    const [name, len] = d.vessels[vi];
    feats.push({ type: "Feature", properties: { cat: d.cats[ci], name, len, day: d.date }, geometry: { type: "LineString", coordinates: coords } });
  }
  return feats;
}

function selectedShipCounts() {
  const sel = state.shipSel || "live";
  const by = Object.fromEntries(SHIP_CATS.map(([c]) => [c, 0]));
  let days = [];
  if (sel === "live") { for (const s of D.live_ships || []) by[s.cat || "Other"] = (by[s.cat || "Other"] || 0) + 1; }
  else {
    days = sel.startsWith("d:") ? [sel.slice(2)] : shipIdx.days.map((d) => d.date).filter((d) => d >= sel.split(":")[1] && d <= sel.split(":")[2]);
    for (const d of shipIdx.days.filter((x) => days.includes(x.date))) for (const [c, n] of Object.entries(d.by_cat)) by[c] = (by[c] || 0) + n;
  }
  return { by, total: d3.sum(Object.values(by)), days: days.length, live: sel === "live" };
}

function renderShipList() {
  const host = document.getElementById("ship-list");
  if (!host) return;
  const col = shipColours();
  const { by, days, live } = selectedShipCounts();
  const unit = live ? "ships" : days > 1 ? "vessel-days" : "vessels";
  const rows = SHIP_CATS.map(([cat]) => {
    const box = el("input", { type: "checkbox", checked: state.cats.has(cat), onchange: (e) => { e.target.checked ? state.cats.add(cat) : state.cats.delete(cat); applyShipFilter(); paint(); } });
    return el("li", { class: `tl-item${by[cat] ? "" : " tl-zero"}` }, el("label", {}, box, el("i", { class: "tl-sw sw-ln", style: { background: col[cat] } }),
      el("span", { class: "tl-name" }, cat), el("span", { class: "tl-n", title: `${by[cat] || 0} ${unit}` }, fmtInt.format(by[cat] || 0))));
  });
  const summary = el("span", { class: "tl-summary" });
  const paint = () => { summary.textContent = state.cats.size === SHIP_CATS.length ? `All types · ${unit}` : `${state.cats.size} of ${SHIP_CATS.length} types`;
    rows.forEach((r, i) => { r.querySelector("input").checked = state.cats.has(SHIP_CATS[i][0]); }); };
  const bulk = (on) => { state.cats = new Set(on ? SHIP_CATS.map((c) => c[0]) : []); applyShipFilter(); paint(); };
  host.replaceChildren(el("div", { class: "tl-head" }, summary, el("span", { class: "tl-bulk" },
    el("button", { type: "button", onclick: () => bulk(true) }, "All"), el("button", { type: "button", onclick: () => bulk(false) }, "None"))),
  el("ul", { class: "tl-list", "aria-label": "Ship types shown on the map" }, ...rows));
  paint();
}
function applyShipFilter() {
  const f = ["in", ["get", "cat"], ["literal", [...state.cats]]];
  if (map?.getLayer("ships")) map.setFilter("ships", f);
  if (map?.getLayer("live")) map.setFilter("live", f);
}

function renderCoverage() {
  const host = document.getElementById("coverage");
  const cov = shipIdx?.coverage || [];
  const max = d3.max(cov, (c) => c.vessels_per_day) || 1;
  const thin = cov.filter((c) => c.vessels_per_day < max * 0.1).map((c) => c.region);
  host.replaceChildren(
    el("div", { class: "side-title" }, "What the map covers"),
    el("p", {}, "Sightings, iNaturalist photos, listener reports and hydrophones: 47–51° N, 122–128.6° W. Ship tracks are US Coast Guard receivers only, so they fade with distance from US shores. Average moving vessels per AIS day:"),
    el("ul", { class: "cov" }, ...cov.map((c) => el("li", {}, el("span", {}, c.region),
      el("i", { style: { width: `${Math.max(2, (c.vessels_per_day / max) * 100)}%` } }), el("b", {}, c.vessels_per_day < 1 ? "<1" : fmtInt.format(Math.round(c.vessels_per_day)))))),
    el("p", {}, `${thin.length ? `${thin.join(" and ")} ${thin.length > 1 ? "get" : "gets"} under a tenth of the busiest region's count: little or no US reception, so empty water there means no data, not no ships. ` : ""}West-coast numbers are mostly ships offshore heading for Juan de Fuca, not the inlets. Canadian Coast Guard AIS isn't openly published.`));
}

function buildLayers() {
  const others = D.other_hydrophones || [];
  const defs = [
    ["whales", "Whale sightings, chosen dates", SP_SHORT.map((n, i) => [n, SP_COLOURS[i], "dot"])],
    ["phones", "Orcasound hydrophones (click to listen; size = listener whale reports in the dates)", [["hydrophone", "var(--sea)", "dot"]]],
    ["others", `Other hydrophones (${others.length}, links only)`, [["public stream", "var(--surface)", "ring"], ["login or no public audio", "var(--surface)", "ring-dash"]]],
    ["inat", "Whale photos, iNaturalist (all years)", [["observation", "var(--muted)", "dot"]]],
    ["ships", "Ship tracks (types below)", []],
  ];
  document.getElementById("layers").replaceChildren(...defs.map(([k, label, keys]) => el("div", {},
    el("label", {}, el("input", { type: "checkbox", checked: layers[k], onchange: (e) => { layers[k] = e.target.checked; applyVis(); } }), label),
    keys.length ? el("div", { class: "key" }, ...keys.map(([t, c, shape]) => el("span", {}, el("i", { class: shape, style: { background: c, outline: shape === "dot" && /orca/i.test(t) ? "1.5px solid var(--axis)" : "" } }), t))) : null)));
}

function renderSide() {
  const s = sights.filter((x) => inRange(x.day));
  const by = d3.rollup(s, (v) => v.length, (x) => x.sp);            // reports, not animals: group counts overlap between reports
  const nAc = s.filter((x) => x.src === 0).length, nIn = s.length - nAc;
  let listen = 0;
  for (const days of Object.values(D.listener_daily || {})) for (const [d, n] of Object.entries(days)) if (inRange(d)) listen += n;
  const span = state.from === state.to ? fmtDay(state.from) : `${fmtDay(state.from)}–${fmtDay(state.to)}`;
  const { total, days, live } = selectedShipCounts();
  document.getElementById("tiles-side").replaceChildren(...[
    el("div", { class: "stat-mini" }, el("b", {}, fmtInt.format(s.length)), el("span", {}, `whale sightings, ${span}: ${nAc} Acartia, ${nIn} iNaturalist${by.size ? ` · reports of ${[...by].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${SP_SHORT[k].toLowerCase()} ${v}`).join(", ")}` : ""}`)),
    el("div", { class: "stat-mini" }, el("b", {}, fmtInt.format(listen)), el("span", {}, `Orcasound listener reports of whale sounds, ${span}`)),
    el("div", { class: "stat-mini" }, el("b", {}, fmtInt.format(total)), el("span", {}, live ? (D.live_ships ? "ships in today's live snapshot" : "live ships: no aisstream.io key configured") : `moving ${days > 1 ? "vessel-days" : "vessels"} in the chosen AIS ${days > 1 ? "days" : "day"}`)),
  ]);
}

// ------------------------------------------------------------------ map
const pt = (lon, lat, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
function whaleGeo() {
  return { type: "FeatureCollection", features: sights.filter((s) => inRange(s.day)).map((s) => pt(s.lon, s.lat, { sp: s.sp, n: s.n, src: s.src, t: s.t, ref: s.ref })) };
}
function phoneGeo() {
  return { type: "FeatureCollection", features: Object.entries(D.hydrophones).map(([id, h]) => {
    const n = d3.sum(Object.entries(D.listener_daily?.[id] || {}), ([d, v]) => (inRange(d) ? v : 0));
    return pt(h.lon, h.lat, { id, name: h.name, n });
  }) };
}
function liveGeo() {
  return { type: "FeatureCollection", features: state.shipSel === "live" ? (D.live_ships || []).map((s) => pt(s.lon, s.lat, { cat: s.cat || "Other", name: s.name, sog: s.sog })) : [] };
}
function initMap() {
  const narrow = matchMedia("(max-width: 700px)").matches;
  map = new maplibregl.Map({ container: "map", style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light, bounds: [[-128.6, 47.0], [-122.0, 51.0]],
    fitBoundsOptions: { padding: narrow ? 8 : 24 }, attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  if (import.meta.env.DEV) window.__map = map;   // handle for headless visual checks
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  map.on("style.load", () => { addLayers(); skinBasemap(map, isDark()); });
  const pop = new maplibregl.Popup({ maxWidth: "290px" });
  map.on("click", "phones", (e) => { toggle(e.features[0].properties.id); window.scrollTo({ top: 0, behavior: "smooth" }); });
  map.on("click", "whales", (e) => { const p = e.features[0].properties;
    const when = p.t.length > 10 ? fmtWhen(p.t) : `${fmtDay(p.t)} (day only)`;
    const [id, grade] = String(p.ref || "").split("|");
    pop.setLngLat(e.lngLat).setDOMContent(el("div", {}, el("b", {}, `${SP_SHORT[p.sp]}${p.n > 1 ? ` × ${p.n}` : ""}`),
      el("div", { class: "note" }, `${when} Pacific · ${p.src === 0 ? `Acartia${p.ref ? ` (${p.ref})` : ""}` : `iNaturalist, ${grade === "research" ? "research grade" : "needs ID"}`}`),
      p.src === 1 && id ? el("a", { href: `https://www.inaturalist.org/observations/${id}`, target: "_blank", rel: "noopener" }, "View the observation") : null)).addTo(map); });
  map.on("click", "others", (e) => { const p = e.features[0].properties;
    pop.setLngLat(e.lngLat).setDOMContent(el("div", {}, el("b", {}, p.name), el("div", { class: "note" }, `${p.operator}${p.approx ? " · position approximate" : ""}`),
      el("p", { style: { margin: "6px 0" } }, p.note), el("div", { class: "note" }, p.access === "public" ? "Public live audio on the operator's site" : p.access === "login" ? "Audio needs a free account and token" : "No public audio"),
      el("a", { href: p.url, target: "_blank", rel: "noopener" }, "Open the operator's page"))).addTo(map); });
  for (const l of ["phones", "whales", "others"]) {
    map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("mousemove", "phones", (e) => { const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name), tipRow(null, fmtInt.format(p.n), "listener whale reports in the dates"), tipRow(null, "click", "to listen live"))); });
  map.on("mouseleave", "phones", () => tip.hide());
  map.on("mousemove", "ships", (e) => { const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name || "Vessel"), tipRow(shipColours()[p.cat], p.cat, `${p.len ? `${Math.round(p.len)} m · ` : ""}${fmtDay(p.day)}`))); });
  map.on("mouseleave", "ships", () => tip.hide());
}
function addLayers() {
  const col = shipColours();
  const catColour = ["match", ["get", "cat"], ...SHIP_CATS.flatMap(([c]) => [c, col[c]]), col.Other];
  map.addSource("ships", { type: "geojson", data: { type: "FeatureCollection", features: state.shipFeatures } });
  map.addLayer({ id: "ships", type: "line", source: "ships", paint: { "line-color": catColour,
    "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 11, 1.6], "line-opacity": 0.55 } });
  map.addSource("live", { type: "geojson", data: liveGeo() });
  map.addLayer({ id: "live", type: "circle", source: "live", paint: { "circle-radius": 3, "circle-color": catColour, "circle-stroke-color": cssVar("--surface"), "circle-stroke-width": 1 } });
  map.addSource("inat", { type: "geojson", data: { type: "FeatureCollection", features: inat.map(([sp, date, lat, lon]) => pt(lon, lat, { sp, date })) } });
  map.addLayer({ id: "inat", type: "circle", source: "inat", layout: { visibility: "none" }, paint: { "circle-radius": 2.5, "circle-color": cssVar("--muted"), "circle-opacity": 0.5 } });
  map.addSource("others", { type: "geojson", data: { type: "FeatureCollection", features: (D.other_hydrophones || []).map((h) => pt(h.lon, h.lat, h)) } });
  map.addLayer({ id: "others", type: "circle", source: "others", paint: { "circle-radius": 6.5, "circle-color": cssVar("--surface"),
    "circle-stroke-color": ["match", ["get", "access"], "public", cssVar("--sea"), cssVar("--muted")], "circle-stroke-width": ["match", ["get", "access"], "public", 3, 2] } });
  map.addSource("whales", { type: "geojson", data: whaleGeo() });
  const spCol = SP_COLOURS.map((c) => (c.startsWith("var(") ? cssVar(c.slice(4, -1)) : c));
  map.addLayer({ id: "whales", type: "circle", source: "whales", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["match", ["get", "src"], 0, 4.5, 3.2], 11, ["match", ["get", "src"], 0, 9, 6]],
    "circle-color": ["match", ["get", "sp"], ...spCol.flatMap((c, i) => [i, c]), spCol[6]],
    "circle-stroke-color": isDark() ? "#000" : "#fff", "circle-stroke-width": ["match", ["get", "src"], 0, 2, 1] } });
  map.addSource("phones", { type: "geojson", data: phoneGeo() });
  map.addLayer({ id: "phones", type: "circle", source: "phones", paint: { "circle-radius": ["+", 7, ["*", 1.4, ["sqrt", ["get", "n"]]]],
    "circle-color": cssVar("--sea"), "circle-opacity": 0.9, "circle-stroke-color": cssVar("--surface"), "circle-stroke-width": 3 } });
  applyShipFilter();
  applyVis();
}
function applyVis() {
  if (!map?.getLayer("phones")) return;
  for (const [k, on] of Object.entries(layers)) if (map.getLayer(k)) map.setLayoutProperty(k, "visibility", on ? "visible" : "none");
  if (map.getLayer("live")) map.setLayoutProperty("live", "visibility", layers.ships ? "visible" : "none");
}

// ------------------------------------------------------------------ whale-sound tier list
function renderTiers() {
  const T = D.tiers;
  const host = document.getElementById("tiers");
  if (!T || !d3.sum(Object.values(T.counts || {}))) {
    host.replaceChildren(el("div", { class: "card note" }, "No OrcaHello clips or listener reports in the last 30 days could be fetched for this build. They'll appear on the next refresh."));
    return;
  }
  document.getElementById("tiers-sub").textContent = `${fmtInt.format(T.n_ai)} OrcaHello encounters (best clip of each) and ${fmtInt.format(T.n_listener)} Orcasound listener events from the last ${T.window_days} days, scored out of 100. S is the best. Hover or focus a card for its score breakdown, and press play to hear it. ${T.rejected ? `${fmtInt.format(T.rejected)} clips a moderator rejected aren't listed. ` : ""}The recipe is editorial, explained under Method.${T.carried_over ? " (Carried over from the previous build: this run couldn't fetch new clips.)" : ""}`;
  host.replaceChildren(...TIER_ORDER.map((t) => {
    const items = (T.items[t] || []).slice(0, 5);
    const n = T.counts[t] || 0;
    return el("div", { class: "tier-row" },
      el("div", { class: `tier-badge tier-${t}`, title: `${t} tier: score ${T.thresholds[t]}+` }, el("b", {}, t), el("span", {}, `${T.thresholds[t]}+`)),
      el("div", { class: "tier-items" }, ...(items.length ? items.map(tierCard) : [el("div", { class: "note tier-empty" }, "Nothing scored this high in the last 30 days.")]),
        n > items.length ? el("div", { class: "note tier-more" }, `+ ${fmtInt.format(n - items.length)} more`) : null));
  }));
}
function tierCard(it) {
  const play = el("button", { type: "button", class: "tc-play", "aria-label": `Play ${it.kind === "ai" ? "clip" : "recording"} from ${it.name}`,
    disabled: !(it.audio || it.hls), onclick: (e) => playClip(it, e.currentTarget) }, "▶");
  const card = el("div", { class: "tier-card", tabindex: "0", "data-tier": it.tier },
    it.spectrogram ? el("img", { src: it.spectrogram, alt: "", loading: "lazy" }) : el("div", { class: "tc-noimg", "aria-hidden": "true" }, it.kind === "listener" ? "listener reports" : "no spectrogram"),
    el("div", { class: "tc-b" }, play,
      el("div", { class: "tc-t" }, el("div", { class: "tc-nm" }, it.name), el("div", { class: "tc-m" }, `${fmtWhen(it.time)} · ${it.species}`),
        el("div", { class: "tc-m" }, el("span", { class: `tier-pill tier-${it.tier}` }, `${it.tier} · ${Math.round(it.score)}`), ` ${it.verdict}${it.kind === "listener" ? ` (${it.n_reports})` : ""}`))));
  const show = (x, y) => tip.show(x, y, (t) => t.append(el("div", { class: "t-title" }, `${it.tier} tier · ${it.score.toFixed(1)} / 100`),
    ...it.parts.map(([label, p, mx, why]) => el("div", { class: "t-part" }, el("span", { class: "tp-l" }, label), el("span", { class: "tp-bar" }, el("i", { style: { width: `${(p / mx) * 100}%` } })),
      el("b", {}, `${p % 1 ? p.toFixed(1) : p}/${mx}`), el("span", { class: "tp-why" }, why)))));
  card.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") show(e.clientX, e.clientY); });
  card.addEventListener("pointerleave", () => tip.hide());
  card.addEventListener("focusin", () => { const r = card.getBoundingClientRect(); show(r.left, r.bottom - 10); });
  card.addEventListener("focusout", () => tip.hide());
  card.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") { const r = card.getBoundingClientRect(); show(r.left, r.bottom - 10); } });
  return card;
}
function stopClip() {
  clip.hls?.destroy(); clip.hls = null;
  if (clip.audio) { clip.audio.pause(); clip.audio.removeAttribute("src"); clip.audio.load(); }
  if (clip.url) { URL.revokeObjectURL(clip.url); clip.url = null; }
  if (clip.btn) { clip.btn.textContent = "▶"; clip.btn.classList.remove("on"); }
  clip.btn = null;
}
async function playClip(it, btn) {
  const same = clip.btn === btn;
  stopClip();
  if (same) return;
  if (player.node) stop();
  clip.audio ||= new Audio();
  clip.btn = btn;
  btn.textContent = "■"; btn.classList.add("on");
  clip.audio.onended = () => stopClip();
  try {
    if (it.audio) { clip.audio.src = it.audio; await clip.audio.play(); return; }
    // Listener report: rebuild a 30-second playlist around the moment from Orcasound's HLS archive
    const base = `${S3}/${it.hls.node}/hls/${it.hls.playlist}/`;
    const txt = await (await fetch(`${base}live.m3u8`)).text();
    const lines = txt.split("\n"), segs = [];
    let t = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("#EXTINF:")) { const d = parseFloat(lines[i].slice(8)); segs.push({ t, d, uri: lines[i + 1].trim() }); t += d; }
    const start = Math.max(0, it.hls.offset - 8), end = it.hls.offset + 22;
    const pick = segs.filter((s) => s.t + s.d > start && s.t < end);
    if (!pick.length) throw new Error("That moment is no longer in the Orcasound archive");
    const m3u = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:11", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD",
      ...pick.flatMap((s) => [`#EXTINF:${s.d},`, base + s.uri]), "#EXT-X-ENDLIST"].join("\n");
    clip.url = URL.createObjectURL(new Blob([m3u], { type: "application/vnd.apple.mpegurl" }));
    if (Hls.isSupported()) {
      clip.hls = new Hls();
      clip.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stopClip(); btn.textContent = "!"; btn.title = "Couldn't load this recording from the Orcasound archive"; } });
      clip.hls.loadSource(clip.url); clip.hls.attachMedia(clip.audio);
    } else clip.audio.src = clip.url;
    await clip.audio.play();
  } catch (e) {
    console.warn(e);
    btn.textContent = "!"; btn.title = e.message || "Couldn't play this clip";
    clip.btn = null;
  }
}

// ------------------------------------------------------------------ charts
function renderOutlook() {
  const o = D.outlook;
  document.getElementById("outlook-sub").textContent = `Based on ${fmtInt.format(D.n_reports)} whale reports in the Orcasound live app (people pressing "whale", plus the AI detections posted there). Week of ${new Date(o.next_week + "T12:00").toLocaleDateString("en-CA", { month: "long", day: "numeric" })}. On 2025–2026 weeks the model's Brier score was ${o.brier.toFixed(3)}. That's ${Math.round(o.skill_recent * 100)}% better than using each hydrophone's share of recent weeks with reports (${o.brier_recent.toFixed(3)}), and ${Math.round(o.skill * 100)}% better than its usual rate for the month (${o.brier_clim.toFixed(3)}). Listening grew in 2025–26, which flatters that second baseline.`;
  const rows = Object.entries(o.forecast).filter(([id]) => D.hydrophones[id]).map(([id, f]) => ({ id, name: D.hydrophones[id].name, ...f })).sort((a, b) => b.p - a.p);
  const narrow = document.getElementById("outlook").clientWidth < 420;
  const rowH = 34, m = { l: narrow ? 128 : 170, r: 48, t: 4, b: 4 };
  const { g, iw } = frame("outlook", m.t + m.b + rowH * rows.length, m);
  const x = d3.scaleLinear([0, 1], [0, iw]);
  const r_ = g.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  r_.append("rect").attr("x", 0).attr("width", iw).attr("y", 8).attr("height", rowH - 16).attr("rx", 4).style("fill", "var(--surface-2)");
  r_.append("path").attr("d", (d) => barPath(Math.max(2, x(d.p)), 8, rowH - 16)).style("fill", "var(--sea)");
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => (narrow && d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name));
  r_.append("text").attr("class", "label strong").attr("x", iw + 8).attr("y", rowH / 2).attr("dy", "0.35em").text((d) => pct(d.p));
  r_.append("rect").attr("x", -m.l).attr("width", iw + m.l + m.r).attr("height", rowH).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d.name),
      tipRow(cssVar("--sea"), pct(d.p), "chance of whale reports this week"), tipRow(null, d.heard_last_week ? "yes" : "no", "heard last week"),
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
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((i) => (iw < 300 ? "JFMAMJJASOND"[i] : d3.timeFormat("%b")(new Date(2001, i, 1)))).tickSize(0).tickPadding(6)).call(axisClean);
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
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(iw < 400 ? 4 : 7).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.max(1, iw / rows.length - 1);
  g.selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.d)).attr("width", bw).attr("y", (r) => y(r.v)).attr("height", (r) => ih - y(r.v)).style("fill", "var(--sea)");
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const r = rows[d3.bisector((q) => q.d).center(rows, x.invert(px))];
    const last = r === rows.at(-1);
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Week of ${d3.timeFormat("%b %-d, %Y")(r.d)}${last ? " (so far)" : ""}`), tipRow(cssVar("--sea"), String(r.v), "whale reports"))); })
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
  const narrow = document.getElementById("tri-imp").clientWidth < 420;
  const rowH = 26, mm = { l: narrow ? 150 : 200, r: 50, t: 4, b: 4 };
  const fr = frame("tri-imp", mm.t + mm.b + rowH * imp.length, mm);
  const xx = d3.scaleLinear([0, d3.max(imp, (d) => d[1]) || 1], [0, fr.iw]);
  const rr = fr.g.selectAll("g").data(imp).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  rr.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").style("font-size", narrow ? "11px" : null).text((d) => d[0]);
  rr.append("path").attr("d", (d) => barPath(Math.max(2, xx(d[1])), (rowH - 14) / 2, 14)).style("fill", "var(--sea)");
  rr.append("text").attr("class", "label strong").attr("x", (d) => xx(d[1]) + 6).attr("y", rowH / 2).attr("dy", "0.35em").style("font-size", "11px").text((d) => d[1].toFixed(3));
}

function renderInat() {
  const host = document.getElementById("inat-season");
  document.getElementById("inat-sub").textContent = `${fmtInt.format(D.inat_total)} research-grade cetacean observations around Vancouver Island and the Salish Sea, by month (orca includes every ecotype).`;
  host.replaceChildren(...Object.keys(D.inat_season).map((sp) => {
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
  if (!shipIdx && !D.live_ships) return;
  const col = shipColours();
  const { by, days, live, total } = selectedShipCounts();
  const sel = state.shipSel || "";
  const span = live ? "today's live snapshot" : sel.startsWith("d:") ? fmtDay(sel.slice(2), { month: "long", day: "numeric", year: "numeric" })
    : `${fmtDay(sel.split(":")[1])}–${fmtDay(sel.split(":")[2], { month: "short", day: "numeric", year: "numeric" })}`;
  document.getElementById("ships-title").textContent = live ? "Ships on the water today" : days > 1 ? `Vessels on the water, ${days} days` : "Vessels on the water in a day";
  document.getElementById("ships-sub").textContent = live && !D.live_ships ? "Live ships need an aisstream.io key, so there's nothing to count for today. Pick an AIS day on the map."
    : `Moving ${live ? "ships" : days > 1 ? "vessel-days (each vessel counted once per day)" : "vessels"} by type, ${span}. US Coast Guard receivers, so Canadian waters far from the border are under-counted.`;
  const rows = SHIP_CATS.map(([name]) => ({ name, n: by[name] || 0 }));
  const narrow = document.getElementById("ships").clientWidth < 420;
  const rowH = 30, m = { l: narrow ? 118 : 150, r: 56, t: 4, b: 4 };
  const { g } = frame("ships", m.t + m.b + rowH * rows.length, m);
  const iw = document.getElementById("ships").clientWidth - m.l - m.r;
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r.n) || 1], [0, Math.max(10, iw)]);
  const r_ = g.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  r_.append("path").attr("d", (d) => barPath(Math.max(2, x(d.n)), 8, rowH - 16)).style("fill", (d) => col[d.name]);
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.name);
  r_.append("text").attr("class", "label strong").attr("x", (d) => x(d.n) + 8).attr("y", rowH / 2).attr("dy", "0.35em").text((d) => fmtInt.format(d.n));
  if (!total) g.append("text").attr("class", "label").attr("x", 0).attr("y", -2).text("");
}
