// Trip planner shared by the dashboards: a road network per city and travel mode (built by
// pipelines/common/roadgraph.py), scenic routing in the browser, loop building, and GPX / Google Maps export.
import { el } from "./ui.js";

export const MODES = {
  car: { label: "Car", icon: "🚗", kmh: null, google: "driving" },
  bike: { label: "Bike", icon: "🚲", kmh: 16, google: "bicycling" },
  foot: { label: "Walk", icon: "🚶", kmh: 4.8, google: "walking" },
};

// ------------------------------------------------------------------ graph
export async function loadGraph(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const j = await r.json();
  const N = j.nx.length, E = j.a.length;
  const lon = new Float64Array(N), lat = new Float64Array(N);
  for (let i = 0, x = 0, y = 0; i < N; i++) { x += j.nx[i]; y += j.ny[i]; lon[i] = x / 1e5; lat[i] = y / 1e5; }
  const a = Int32Array.from(j.a), b = Int32Array.from(j.b), len = Float32Array.from(j.len);
  const flags = Uint8Array.from(j.flags), speed = Uint8Array.from(j.speed), cls = Uint8Array.from(j.cls), lanes = Uint8Array.from(j.lanes);
  const name = Int32Array.from(j.name);
  const gStart = new Int32Array(E + 1);
  for (let e = 0; e < E; e++) gStart[e + 1] = gStart[e] + j.gc[e];
  const g = Int32Array.from(j.g);
  const feat = Object.fromEntries(Object.entries(j.feat || {}).map(([k, v]) => [k, Uint8Array.from(v)]));
  // adjacency (CSR), each entry an edge traversed forward (+e+1) or backward (-(e+1))
  const deg = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) { if (flags[e] & 1) deg[a[e] + 1]++; if (flags[e] & 2) deg[b[e] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[N]), fill = deg.slice(0, N);
  for (let e = 0; e < E; e++) { if (flags[e] & 1) adj[fill[a[e]]++] = e + 1; if (flags[e] & 2) adj[fill[b[e]]++] = -(e + 1); }
  // spatial index of nodes on a 0.004° grid
  const cell = 0.004, grid = new Map();
  for (let i = 0; i < N; i++) {
    const k = `${Math.floor(lon[i] / cell)}_${Math.floor(lat[i] / cell)}`;
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  }
  return { mode: j.mode, N, E, lon, lat, a, b, len, flags, speed, cls, lanes, name, names: j.names, classes: j.classes,
    gStart, g, feat, deg, adj, grid, cell, extra: j };
}

const KX = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
export function nearestNode(G, lon, lat, maxM = 600) {
  const cx = Math.floor(lon / G.cell), cy = Math.floor(lat / G.cell);
  let best = -1, bd = Infinity;
  const kx = KX(lat);
  for (let r = 0; r <= 3 && (best < 0 || r <= 1); r++)
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      for (const i of G.grid.get(`${cx + dx}_${cy + dy}`) || []) {
        if (G.deg[i + 1] - G.deg[i] === 0 && !hasIncoming(G, i)) continue;
        const d = ((G.lon[i] - lon) * kx) ** 2 + ((G.lat[i] - lat) * 110540) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
  return Math.sqrt(bd) <= maxM ? best : -1;
}
function hasIncoming(G, i) { return G.deg[i + 1] > G.deg[i]; }

export function edgeCoords(G, e, rev) {
  const pts = [[G.lon[G.a[e]], G.lat[G.a[e]]]];
  let x = Math.round(G.lon[G.a[e]] * 1e5), y = Math.round(G.lat[G.a[e]] * 1e5);
  for (let k = G.gStart[e]; k < G.gStart[e + 1]; k++) { x += G.g[2 * k]; y += G.g[2 * k + 1]; pts.push([x / 1e5, y / 1e5]); }
  pts.push([G.lon[G.b[e]], G.lat[G.b[e]]]);
  return rev ? pts.reverse() : pts;
}

// travel time (s) of each edge for the mode, before any scenic weighting
export function baseSeconds(G, mode) {
  const t = new Float32Array(G.E);
  for (let e = 0; e < G.E; e++) {
    let kmh = MODES[mode].kmh ?? Math.min(G.speed[e], 90) * 0.85;
    if (G.flags[e] & 8) kmh *= mode === "car" ? 0.6 : 0.8;            // unpaved
    t[e] = G.len[e] / (kmh / 3.6);
  }
  return t;
}

// ------------------------------------------------------------------ search (binary heap Dijkstra / A*)
class Heap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  push(key, val) {
    if (this.n >= this.k.length) { const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[0], lk = this.k[--this.n], lv = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lk) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    return [key, top];
  }
}

// cost: Float32Array per edge; minPerM: lower bound of cost per metre (for the A* heuristic; 0 → Dijkstra)
export function shortest(G, cost, src, dst, minPerM = 0) {
  const dist = new Float64Array(G.N).fill(Infinity), via = new Int32Array(G.N);
  const tx = G.lon[dst], ty = G.lat[dst], kx = KX(ty);
  const h = (i) => (minPerM ? Math.hypot((G.lon[i] - tx) * kx, (G.lat[i] - ty) * 110540) * minPerM : 0);
  const heap = new Heap(1024);
  dist[src] = 0; heap.push(h(src), src);
  while (heap.n) {
    const [f, u] = heap.pop();
    if (u === dst) break;
    if (f - h(u) > dist[u] + 1e-6) continue;
    for (let k = G.deg[u]; k < G.deg[u + 1]; k++) {
      const s = G.adj[k], e = Math.abs(s) - 1, v = s > 0 ? G.b[e] : G.a[e];
      const nd = dist[u] + cost[e];
      if (nd < dist[v]) { dist[v] = nd; via[v] = s; heap.push(nd + h(v), v); }
    }
  }
  if (!isFinite(dist[dst])) return null;
  const steps = [];
  for (let v = dst; v !== src;) { const s = via[v], e = Math.abs(s) - 1; steps.push([e, s < 0]); v = s > 0 ? G.a[e] : G.b[e]; }
  return steps.reverse();
}

// all costs from src (up to maxCost) — used to pick loop waypoints
export function costsFrom(G, cost, src, maxCost) {
  const dist = new Float64Array(G.N).fill(Infinity);
  const heap = new Heap(4096);
  dist[src] = 0; heap.push(0, src);
  while (heap.n) {
    const [d, u] = heap.pop();
    if (d > dist[u] || d > maxCost) continue;
    for (let k = G.deg[u]; k < G.deg[u + 1]; k++) {
      const s = G.adj[k], e = Math.abs(s) - 1, v = s > 0 ? G.b[e] : G.a[e];
      const nd = d + cost[e];
      if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
    }
  }
  return dist;
}

// ------------------------------------------------------------------ routes
export function routeVia(G, cost, nodes, minPerM = 0) {
  const steps = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    if (nodes[i] === nodes[i + 1]) continue;
    const s = shortest(G, cost, nodes[i], nodes[i + 1], minPerM);
    if (!s) return null;
    steps.push(...s);
  }
  return steps;
}

export function summarise(G, steps, secs, score) {
  let m = 0, t = 0, good = 0;
  const coords = [];
  for (const [e, rev] of steps) {
    m += G.len[e]; t += secs[e];
    if (score) good += G.len[e] * score[e];
    const pts = edgeCoords(G, e, rev);
    coords.push(...(coords.length ? pts.slice(1) : pts));
  }
  return { steps, coords, metres: m, seconds: t, score: score && m ? good / m : null };
}

// Loop of roughly `targetSec` from `start`: try pairs of high-value waypoints that make a triangle of about the
// right size, route each with the scenic cost, and keep the loop with the best score that fits the time.
export function buildLoop(G, cost, secs, score, start, targetSec, candidates, { tries = 16, rank } = {}) {
  const rankOrScore = rank || score;
  const fromStart = costsFrom(G, secs, start, targetSec * 0.75);
  const kx = KX(G.lat[start]);
  const pool = candidates.map((c) => ({ ...c, t: fromStart[c.node] }))
    .filter((c) => isFinite(c.t) && c.t > targetSec * 0.12 && c.t < targetSec * 0.45);
  if (pool.length < 2) return null;
  const ang = (c) => Math.atan2((G.lat[c.node] - G.lat[start]) * 110540, (G.lon[c.node] - G.lon[start]) * kx);
  pool.sort((p, q) => q.value - p.value);
  const top = pool.slice(0, 40);
  const pairs = [];
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    let d = Math.abs(ang(top[i]) - ang(top[j])); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < 0.5 || d > 2.4) continue;
    const est = top[i].t + top[j].t + Math.hypot((G.lon[top[i].node] - G.lon[top[j].node]) * kx, (G.lat[top[i].node] - G.lat[top[j].node]) * 110540) / 8;
    const fit = 1 - Math.min(1, Math.abs(est - targetSec) / targetSec);
    pairs.push({ i, j, rank: (top[i].value + top[j].value) * fit });
  }
  pairs.sort((p, q) => q.rank - p.rank);
  let best = null;
  for (const p of pairs.slice(0, tries)) {
    // visit in angular order so the loop doesn't cross itself
    const [w1, w2] = ang(top[p.i]) < ang(top[p.j]) ? [top[p.i], top[p.j]] : [top[p.j], top[p.i]];
    const steps = routeVia(G, cost, [start, w1.node, w2.node, start]);
    if (!steps) continue;
    const r = summarise(G, steps, secs, rankOrScore);
    const fit = 1 - Math.min(1, Math.abs(r.seconds - targetSec) / targetSec);
    const val = (r.score ?? 0) * 0.6 + fit * 0.4;
    if (!best || val > best.val) best = { ...summarise(G, steps, secs, score), val, waypoints: [start, w1.node, w2.node, start], via: [w1, w2] };
  }
  return best;
}

// ------------------------------------------------------------------ export
export function gpx(route, name) {
  const pts = route.coords.map(([x, y]) => `<trkpt lat="${y.toFixed(6)}" lon="${x.toFixed(6)}"/>`).join("");
  const esc = (s) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="trip planner" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
export function googleMapsUrl(route, mode) {
  // Google allows up to 9 waypoints in a directions link; sample them evenly along the route so it follows our path
  const c = route.coords, n = Math.min(8, Math.max(0, Math.floor(c.length / 20)));
  const pick = Array.from({ length: n }, (_, i) => c[Math.round(((i + 1) * (c.length - 1)) / (n + 1))]);
  const f = ([x, y]) => `${y.toFixed(5)},${x.toFixed(5)}`;
  const q = new URLSearchParams({ api: "1", origin: f(c[0]), destination: f(c.at(-1)), travelmode: MODES[mode].google });
  if (pick.length) q.set("waypoints", pick.map(f).join("|"));
  return `https://www.google.com/maps/dir/?${q}`;
}
export function download(text, filename, type = "application/gpx+xml") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString("en-CA")} km`);
export const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
