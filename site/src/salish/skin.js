// "Sonar Room" design skin for Salish Sea Live.
// Night: a submarine sonar console. Day: a Canadian Hydrographic Service nautical chart.
// Everything here only exists while <html data-skin="alt"> is set, and uses data the page already loaded.
import * as d3 from "d3";

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const isNight = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const SVGNS = "http://www.w3.org/2000/svg";
const DATA_LAYERS = new Set(["ships", "inat", "whales", "phones"]);
const SWEEP_S = 8;                                   // seconds per sweep revolution (matches skin.css)

let D = null, ships = null, listening = null, built = [], timer = 0;

// ------------------------------------------------------------------ spectrogram colormaps
// Night: phosphor (black -> deep teal -> bright mint). Day: printed-chart ink (paper -> shallows blue -> navy -> black).
// Both are monotonic in lightness; loud = bright on the console, loud = dark ink on paper.
const lut = (stops) => { const i = d3.interpolateRgbBasis(stops); return d3.range(256).map((v) => d3.color(i(v / 255)).formatHex()); };
let LUT_NIGHT, LUT_DAY;
export function skinSpectro() {
  if (!on()) return null;
  const t = isNight() ? (LUT_NIGHT ||= lut(["#000000", "#021a16", "#06463a", "#0f8a6e", "#2fd0a2", "#5ef2c8", "#d9fff1"]))
    : (LUT_DAY ||= lut(["#fdf9ec", "#e4eef0", "#a9cbdc", "#5b8fb0", "#1f4f72", "#0f2234", "#050608"]));
  return (v) => t[Math.max(0, Math.min(255, v | 0))];
}

// ------------------------------------------------------------------ basemap
const PAL = {
  night: { land: "#020b10", sea: "#072638", green: "#04161c", built: "#05181f", road: "#0e3a3a", major: "#155048", rail: "#0c3034",
    river: "#0b3b55", border: "#2a7f6c", label: "#4fbf9f", halo: "#020b10", water: "#3fa7b8", coast: "#2fd3a8", glow: "#5ef2c8" },
  day: { land: "#f3ead2", sea: "#ffffff", green: "#e9dcb6", built: "#e8dbb6", road: "#d9cba6", major: "#c4b287", rail: "#9a8e70",
    river: "#a9cbdc", border: "#b0187b", label: "#15130e", halo: "#f3ead2", water: "#1d5a7e", coast: "#15130e", glow: "#bcdbe8" },
};
export function skinBasemap(map, dark) {
  if (!on() || !map?.getStyle()) return;
  const P = dark ? PAL.night : PAL.day;
  const set = (id, k, v) => { try { map.setPaintProperty(id, k, v); } catch { /* property not on this layer */ } };
  const lay = (id, k, v) => { try { map.setLayoutProperty(id, k, v); } catch { /* ignore */ } };
  let src = null;
  for (const l of map.getStyle().layers) {
    const id = l.id, sl = l["source-layer"] || "";
    if (DATA_LAYERS.has(id)) continue;
    if (l.type === "background") set(id, "background-color", P.land);
    else if (l.type === "raster") set(id, "raster-opacity", 0);
    else if (l.type === "fill") {
      if (sl === "water") { set(id, "fill-color", P.sea); set(id, "fill-opacity", 1); src = l.source; }
      else if (sl === "building") set(id, "fill-color", P.built);
      else if (sl === "landuse" && /residential/.test(id)) { set(id, "fill-color", P.built); set(id, "fill-opacity", 0.6); }
      else { set(id, "fill-color", P.green); set(id, "fill-opacity", 0.4); }
      set(id, "fill-outline-color", "rgba(0,0,0,0)");
    } else if (l.type === "line") {
      if (sl === "waterway") set(id, "line-color", P.river);
      else if (sl === "boundary") { set(id, "line-color", P.border); set(id, "line-opacity", dark ? 0.6 : 0.8); }
      else if (/rail/.test(id)) { set(id, "line-color", P.rail); set(id, "line-opacity", 0.6); }
      else if (/casing/.test(id)) set(id, "line-color", P.land);
      else if (/motorway|major/.test(id)) set(id, "line-color", P.major);
      else set(id, "line-color", P.road);
    } else if (l.type === "symbol") {
      const wet = /water/.test(id);
      set(id, "text-color", wet ? P.water : P.label);
      set(id, "text-halo-color", P.halo);
      if (/shield|oneway/.test(id) || sl === "transportation_name") { set(id, "icon-opacity", 0); set(id, "text-opacity", 0); }
    }
  }
  // Coastline: a soft shallows band plus a hairline (teal phosphor at night, black ink by day).
  const before = map.getStyle().layers.find((l) => DATA_LAYERS.has(l.id))?.id;
  if (src && !map.getLayer("skin-shallows")) {
    map.addLayer({ id: "skin-shallows", type: "line", source: src, "source-layer": "water", filter: ["==", ["get", "class"], "ocean"], paint: {
      "line-color": P.glow, "line-opacity": dark ? 0.16 : 1, "line-blur": dark ? 4 : 2,
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, dark ? 5 : 6, 11, dark ? 9 : 14],
      "line-offset": ["interpolate", ["linear"], ["zoom"], 6, dark ? 0 : 3, 11, dark ? 0 : 7] } }, before);
    map.addLayer({ id: "skin-coast", type: "line", source: src, "source-layer": "water", paint: {
      "line-color": P.coast, "line-opacity": dark ? 0.85 : 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 11, 1.1] } }, before);
  }
  // Whale marks keep their fill colours; by day a black hairline ring keeps the pale ones >=3:1 on white water.
  if (map.getLayer("whales") && !dark) { set("whales", "circle-stroke-color", "#15130e"); set("whales", "circle-stroke-width", 1.2); }
}

// ------------------------------------------------------------------ data from main.js
window.addEventListener("salish:data", (e) => { ({ D, ships } = e.detail); if (on()) build(); });
window.addEventListener("salish:listen", (e) => { listening = e.detail; paintListen(); });
window.addEventListener("skinchange", () => (on() ? build() : teardown()));
if (on()) build();

function teardown() {
  built.forEach((n) => n.remove());
  built = [];
  clearInterval(timer);
}

function build() {
  teardown();
  const strip = buildStrip();
  document.querySelector(".topbar").after(strip);
  built.push(strip);
  paintStrip();
  paintListen();
  const heroWrap = document.querySelector(".hero .wrap");
  const sea = contours();
  document.querySelector(".hero").prepend(sea);
  built.push(sea);
  if (D) {
    const scope = buildScope();
    heroWrap.querySelector(".hero-text").after(scope);
    built.push(scope);
  }
  const hud = h("div", { class: "sr-maphud", "aria-hidden": "true" },
    h("span", { class: "sr-n" }, "TACTICAL PLOT // SALISH SECTOR"), h("span", { class: "sr-d" }, "Haro Strait to Puget Sound · Soundings in whale reports"));
  document.querySelector(".map-shell").append(hud);
  built.push(hud);
  const foot = h("div", { class: "sr-flavour", "aria-hidden": "true" },
    h("span", { class: "sr-n" }, "// SONAR ROOM · PASSIVE ARRAY ONLY · NO PINGS WERE EMITTED IN THE MAKING OF THIS PAGE"),
    h("span", { class: "sr-d" }, "Not to be used for navigation. Whales have right of way."));
  document.querySelector("footer.site .wrap").append(foot);
  built.push(foot);
  timer = setInterval(paintStrip, 60_000);
}

function h(tag, attrs = {}, ...kids) {
  const n = tag.startsWith("svg:") ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}

// ------------------------------------------------------------------ live strip
const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}M AGO` : m < 48 * 60 ? `${Math.round(m / 60)}H AGO` : `${Math.round(m / 1440)}D AGO`; };
const utc = (s) => new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

function buildStrip() {
  const cell = (key, label) => h("div", { class: "sr-cell", "data-k": key }, h("span", { class: "sr-lab" }, label), h("span", { class: "sr-val" }, "—"));
  return h("div", { class: "sr-strip", role: "group", "aria-label": "Live readouts" },
    h("div", { class: "sr-strip-in" },
      h("span", { class: "sr-live" }, h("i", { class: "sr-dot", "aria-hidden": "true" }), "LIVE"),
      cell("phones", "Hydrophones"), cell("whale", "Last whale report"), cell("ships", "Ship transits · sample day"),
      cell("listen", "Listener"), h("span", { class: "sr-spacer" }), cell("asof", "Data as of")));
}
function setCell(key, text, cls) {
  const v = document.querySelector(`.sr-cell[data-k="${key}"] .sr-val`);
  if (!v) return;
  v.textContent = text;
  v.className = `sr-val${cls ? ` ${cls}` : ""}`;
}
function paintStrip() {
  if (!D) return;
  const hp = Object.values(D.hydrophones);
  setCell("phones", `${hp.filter((p) => p.reports_30d > 0).length}/${hp.length} ACTIVE · 30D`);
  const last = (D.sightings || []).map((s) => ({ ...s, t: utc(s.created) })).filter((s) => !isNaN(s.t)).sort((a, b) => b.t - a.t)[0];
  setCell("whale", last ? `${last.type.toUpperCase()} · ${ago(Date.now() - last.t)}` : "NONE THIS WEEK", last?.type === "Orca" ? "hot" : "");
  const n = D.ship_stats ? d3.sum(Object.values(D.ship_stats)) : ships?.features?.length;
  setCell("ships", n ? `${d3.format(",")(n)} VESSELS` : "NO AIS");
  const g = new Date(D.generated);
  setCell("asof", `${g.toLocaleDateString("en-CA", { month: "short", day: "numeric" }).toUpperCase()} ${g.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}`);
  paintListen();
}
function paintListen() {
  const strip = document.querySelector(".sr-strip");
  if (!strip) return;
  strip.classList.toggle("is-listening", !!listening);
  setCell("listen", listening ? `● LISTENING · ${listening.name}` : "○ STANDBY", listening ? (listening.live ? "hot" : "warn") : "");
}

// ------------------------------------------------------------------ hero: sonar scope / compass rose
function buildScope() {
  // Centre the plot between the San Juans and Puget Sound so this week's reports fall inside the rings.
  const lat0 = 48.13, lon0 = -122.76, kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const contacts = (D.sightings || []).filter((s) => s.lat).map((s) => {
    const dx = (s.lon - lon0) * kx, dy = (s.lat - lat0) * ky;
    return { ...s, km: Math.hypot(dx, dy), brg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
  }).filter((c) => c.km <= 200);                     // the Salish Sea sector only (the feed also carries a few California reports)
  const range = Math.max(40, Math.ceil((d3.max(contacts, (c) => c.km) || 40) / 20) * 20);
  const R = 96, rr = (km) => (km / range) * R;
  const pol = (b, r) => [Math.sin((b * Math.PI) / 180) * r, -Math.cos((b * Math.PI) / 180) * r];
  const svg = h("svg:svg", { viewBox: "-122 -122 244 244", class: "sr-scope-svg" });

  // range rings + crosshair + bearing ticks (console)
  const rings = h("svg:g", { class: "sr-rings" });
  for (let i = 1; i <= 4; i++) rings.append(h("svg:circle", { r: (R * i) / 4 }));
  rings.append(h("svg:path", { d: `M${-R},0H${R}M0,${-R}V${R}`, class: "sr-cross" }));
  for (let b = 0; b < 360; b += 5) {
    const [x1, y1] = pol(b, R), [x2, y2] = pol(b, R + (b % 30 === 0 ? 7 : b % 10 === 0 ? 4 : 2));
    rings.append(h("svg:line", { x1, y1, x2, y2, class: b % 30 === 0 ? "maj" : "" }));
    if (b % 30 === 0) { const [x, y] = pol(b, R + 15); rings.append(h("svg:text", { x, y, "dominant-baseline": "middle", "text-anchor": "middle" }, String(b).padStart(3, "0"))); }
  }
  for (let i = 1; i <= 3; i++) { const [x, y] = pol(45, (R * i) / 4); rings.append(h("svg:text", { x: x + 2, y: y - 2, class: "rng" }, `${(range * i) / 4}`)); }

  // compass rose (chart): true ring outside, magnetic ring inside rotated by the local variation (~15°E)
  const VAR = 15;
  const rose = h("svg:g", { class: "sr-rose" });
  rose.append(h("svg:circle", { r: R }), h("svg:circle", { r: R - 9 }), h("svg:circle", { r: R * 0.62 }), h("svg:circle", { r: R * 0.62 - 6 }));
  for (let b = 0; b < 360; b += 2) {
    const len = b % 10 === 0 ? 7 : 3.5, [x1, y1] = pol(b, R), [x2, y2] = pol(b, R - len);
    rose.append(h("svg:line", { x1, y1, x2, y2 }));
    if (b % 30 === 0) { const [x, y] = pol(b, R - 15); rose.append(h("svg:text", { x, y, "dominant-baseline": "middle", "text-anchor": "middle", transform: `rotate(${b} ${x} ${y})` }, String(b))); }
  }
  const mag = h("svg:g", { transform: `rotate(${VAR})` });
  for (let b = 0; b < 360; b += 5) { const r1 = R * 0.62, [x1, y1] = pol(b, r1), [x2, y2] = pol(b, r1 - (b % 30 === 0 ? 6 : 3)); mag.append(h("svg:line", { x1, y1, x2, y2 })); }
  mag.append(h("svg:path", { class: "sr-arrow", d: `M0,${-R * 0.62 + 7}L4,${-R * 0.62 + 18}L-4,${-R * 0.62 + 18}Z` }));
  rose.append(mag);
  const star = (len, w, rot, cls) => h("svg:path", { class: cls, transform: `rotate(${rot})`, d: `M0,${-len}L${w},0L0,${len}L${-w},0Z` });
  rose.append(star(R * 0.5, 5, 45, "st2"), star(R * 0.5, 5, 135, "st2"), star(R * 0.78, 7, 0, "st1"), star(R * 0.78, 7, 90, "st1"));
  rose.append(h("svg:path", { class: "st-half", d: `M0,${-R * 0.78}L7,0L0,0Z M0,${R * 0.78}L-7,0L0,0Z M${R * 0.78},0L0,7L0,0Z M${-R * 0.78},0L0,-7L0,0Z` }));
  rose.append(h("svg:circle", { r: 2.2, class: "hub" }));
  rose.append(h("svg:rect", { x: -27, y: R * 0.47 - 6, width: 54, height: 8.5, class: "rose-plate" }),
    h("svg:text", { x: 0, y: R * 0.47, class: "rose-var", "text-anchor": "middle" }, `VAR ${VAR}°E (2026)`));
  const [nx, ny] = pol(0, R + 10);
  rose.append(h("svg:text", { x: nx, y: ny, class: "rose-n", "text-anchor": "middle", "dominant-baseline": "middle" }, "N"));

  // sweep: stacked thin sectors fading behind a leading edge
  const sweep = h("svg:g", { class: "sr-sweep" });
  sweep.append(h("svg:circle", { r: R, class: "sr-hitbox" }));
  for (let i = 0; i < 18; i++) {
    const a0 = -(i + 1) * 2.5, a1 = -i * 2.5, [x0, y0] = pol(a0, R), [x1, y1] = pol(a1, R);
    sweep.append(h("svg:path", { d: `M0,0L${x0},${y0}A${R},${R} 0 0 1 ${x1},${y1}Z`, style: `opacity:${(0.34 * (1 - i / 18) ** 1.6).toFixed(3)}` }));
  }
  sweep.append(h("svg:line", { x1: 0, y1: 0, x2: 0, y2: -R, class: "edge" }));

  // contacts (real bearings and ranges of this week's reports) + hydrophones
  const blips = h("svg:g", { class: "sr-blips" });
  for (const p of Object.values(D.hydrophones)) {
    const dx = (p.lon - lon0) * kx, dy = (p.lat - lat0) * ky, [x, y] = [rr(dx), -rr(dy)];
    if (Math.hypot(dx, dy) <= range) blips.append(h("svg:rect", { x: x - 2, y: y - 2, width: 4, height: 4, class: "hp" }));
  }
  for (const c of contacts.filter((c) => c.km <= range)) {
    const [x, y] = pol(c.brg, rr(c.km));
    const delay = -(SWEEP_S * (1 - c.brg / 360)).toFixed(2);
    blips.append(h("svg:circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: c.type === "Orca" ? 2.6 : 2, class: `bl ${c.type === "Orca" ? "orca" : ""}`, style: `animation-delay:${delay}s` }));
  }
  svg.append(rings, rose, sweep, blips);
  const n = contacts.filter((c) => c.km <= range).length;
  return h("figure", { class: "sr-scope", "aria-hidden": "true" }, svg,
    h("figcaption", {}, h("span", { class: "sr-n" }, `${n} CONTACTS THIS WEEK · RANGE ${range} KM · CTR PORT TOWNSEND`),
      h("span", { class: "sr-d" }, `${n} whale reports this week, plotted by true bearing from Port Townsend`)));
}

// Decorative depth contours + soundings behind the hero (dotted chart contours by day, faint bathymetry trace at night).
function contours() {
  const W = 1600, H = 520, svg = h("svg:svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid slice", class: "sr-contours", "aria-hidden": "true" });
  const rnd = d3.randomLcg(0.4207);
  for (let k = 0; k < 6; k++) {
    const base = 120 + k * 72, a = 18 + rnd() * 26, f = 0.003 + rnd() * 0.004, ph = rnd() * 6;
    const pts = d3.range(0, W + 40, 40).map((x) => [x, base + a * Math.sin(x * f + ph) + 12 * Math.sin(x * f * 3.1 + ph * 2)]);
    svg.append(h("svg:path", { d: d3.line().curve(d3.curveBasis)(pts), class: `c c${k}` }));
  }
  for (let i = 0; i < 46; i++) {
    const x = 30 + rnd() * (W - 60), y = 40 + rnd() * (H - 60), d = Math.round(8 + (y / H) * 160 + rnd() * 30);
    svg.append(h("svg:text", { x: x.toFixed(0), y: y.toFixed(0), class: "snd" }, String(d)));
  }
  return svg;
}
