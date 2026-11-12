"""Routable road networks from OpenStreetMap, per travel mode (car, bike, foot).

build(elements, bbox) splits OSM ways at intersections into edges and works out who may use each edge in which
direction. It also records speed, lanes, surface, cycle infrastructure and geometry. Projects then attach their own
per-edge scores (`feat`) and write a compact JSON the browser routes on (see site/src/shared/route.js).
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import numpy as np

MODES = ("car", "bike", "foot")
CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
           "service", "link", "cycleway", "path", "footway", "pedestrian", "track", "steps", "bridleway"]
CLS = {c: i for i, c in enumerate(CLASSES)}
DRIVE = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
NONMOTOR = {"cycleway", "path", "footway", "pedestrian", "track", "steps", "bridleway"}
DEFAULT_SPEED = {"motorway": 100, "trunk": 80, "primary": 60, "secondary": 50, "tertiary": 50, "unclassified": 50,
                 "residential": 50, "living_street": 20, "service": 20, "link": 50}
DEFAULT_LANES = {"motorway": 4, "trunk": 4, "primary": 4, "secondary": 2, "tertiary": 2, "unclassified": 2,
                 "residential": 2, "living_street": 1, "service": 1, "link": 1}
NO = {"no", "private"}
YES = {"yes", "designated", "permissive"}

# Overpass selector (with {bbox}) for every way any mode might use; sidewalks and crossings are dropped because
# pedestrians are routed on the streets themselves
ROAD_SELECTOR = ('way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|'
                 'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|cycleway|path|footway|pedestrian|'
                 'track|steps|bridleway)$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"]({bbox});'
                 'way["highway"="service"]["name"][!"service"]["area"!="yes"]({bbox});')


def _speed(tags: dict, cls: str) -> int:
    v = tags.get("maxspeed", "")
    m = re.match(r"\s*(\d+)\s*(mph)?", v)
    if m:
        s = int(m.group(1))
        return round(s * 1.609) if m.group(2) else s
    return DEFAULT_SPEED.get(cls, 30)


def _lanes(tags: dict, cls: str) -> int:
    try:
        return max(1, int(float(tags.get("lanes", "").split(";")[0])))
    except ValueError:
        n = DEFAULT_LANES.get(cls, 1)
        return 1 if tags.get("oneway") in ("yes", "1", "-1") and n == 2 else n


def access(tags: dict) -> dict[str, tuple[bool, bool]]:
    """Per mode: (forward allowed, backward allowed)."""
    hw = tags.get("highway", "")
    gen = tags.get("access", "")
    out = {}
    oneway = tags.get("oneway", "") in ("yes", "1", "true") or tags.get("junction") in ("roundabout", "circular") \
        or hw in ("motorway", "motorway_link") and tags.get("oneway") != "no"
    reverse = tags.get("oneway") == "-1"
    # car
    car = (hw in DRIVE or hw == "service") and gen not in NO and tags.get("motor_vehicle") not in NO \
        and tags.get("motorcar") not in NO
    if car and gen in NO and tags.get("motorcar") in YES:
        car = True
    out["car"] = (car and not reverse, car and (not oneway or reverse)) if car else (False, False)
    # bike
    b = tags.get("bicycle", "")
    bike = b not in NO and (gen not in NO or b in YES) and (
        hw in {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "cycleway",
               "path", "track", "bridleway", "primary_link", "secondary_link", "tertiary_link"}
        or hw in {"footway", "pedestrian"} and b in YES or hw in {"trunk", "trunk_link"} and b in YES)
    b_two = tags.get("oneway:bicycle") == "no" or str(tags.get("cycleway", "")).startswith("opposite")
    b_oneway = oneway and not b_two and hw != "cycleway" or hw == "cycleway" and tags.get("oneway") == "yes"
    out["bike"] = (bike and not (reverse and b_oneway), bike and (not b_oneway or reverse)) if bike else (False, False)
    # foot
    f = tags.get("foot", "")
    foot_ok = f not in NO and (gen not in NO or f in YES)
    if hw in {"motorway", "motorway_link"}:
        foot = False
    elif hw in {"trunk", "trunk_link"}:
        foot = f in YES
    else:
        foot = foot_ok
    out["foot"] = (foot, foot)
    return out


def _cls(hw: str) -> str:
    return "link" if hw.endswith("_link") else hw


def build(elements: list[dict], bbox, *, min_component: int = 60) -> dict:
    """Split ways at shared nodes into edges. Returns numpy columns plus per-mode masks."""
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in elements if e["type"] == "node"}
    ways = [e for e in elements if e["type"] == "way" and "nodes" in e and len(e["nodes"]) >= 2]
    use = {}
    for w in ways:
        for i, n in enumerate(w["nodes"]):
            use[n] = use.get(n, 0) + (2 if i in (0, len(w["nodes"]) - 1) else 1)
    lon0, lat0 = (bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    edges = []
    for w in ways:
        t = w.get("tags", {})
        hw = t.get("highway", "")
        acc = access(t)
        if not any(a[0] or a[1] for a in acc.values()):
            continue
        cls = _cls(hw)
        info = dict(cls=CLS.get(cls, CLS["path"]), speed=_speed(t, cls) if hw not in NONMOTOR else 15,
                    lanes=_lanes(t, cls) if hw not in NONMOTOR else 1, name=t.get("name", "") or t.get("ref", ""),
                    unpaved=t.get("surface", "") in ("gravel", "dirt", "ground", "unpaved", "compacted", "fine_gravel", "grass", "sand", "mud", "woodchips"),
                    bridge=t.get("bridge", "no") not in ("no", ""), signals=0,
                    bikeinfra=hw == "cycleway" or any(str(t.get(k, "")).startswith(("lane", "track", "separate", "shared_lane"))
                                                       for k in ("cycleway", "cycleway:both", "cycleway:left", "cycleway:right")) or t.get("bicycle") == "designated",
                    scenic=t.get("scenic") == "yes", acc=acc)
        seg = [w["nodes"][0]]
        for n in w["nodes"][1:]:
            seg.append(n)
            if use.get(n, 0) >= 2 and n != w["nodes"][-1] or n == w["nodes"][-1]:
                if all(x in nodes for x in seg):
                    edges.append((seg, info))
                seg = [n]
    # columns
    node_ids = sorted({s[0] for s, _ in edges} | {s[-1] for s, _ in edges})
    nidx = {n: i for i, n in enumerate(node_ids)}
    N = len(node_ids)
    nlon = np.array([nodes[n][0] for n in node_ids]); nlat = np.array([nodes[n][1] for n in node_ids])
    E = len(edges)
    a = np.array([nidx[s[0]] for s, _ in edges]); b = np.array([nidx[s[-1]] for s, _ in edges])
    geom = [np.array([nodes[n] for n in s]) for s, _ in edges]
    length = np.array([float(np.hypot(np.diff(g[:, 0]) * kx, np.diff(g[:, 1]) * ky).sum()) for g in geom])
    col = lambda k: np.array([inf[k] for _, inf in edges])
    G = {"bbox": bbox, "proj": (lon0, lat0, kx, ky), "nlon": nlon, "nlat": nlat, "a": a, "b": b, "geom": geom,
         "length": length, "cls": col("cls"), "speed": col("speed"), "lanes": col("lanes"), "unpaved": col("unpaved"),
         "bridge": col("bridge"), "bikeinfra": col("bikeinfra"), "scenic": col("scenic"),
         "name": [inf["name"] for _, inf in edges], "osm_nodes": [s for s, _ in edges], "node_ids": node_ids}
    for m in MODES:
        fwd = np.array([inf["acc"][m][0] for _, inf in edges]); bwd = np.array([inf["acc"][m][1] for _, inf in edges])
        keep = _largest_components(N, a, b, fwd | bwd, min_component)
        G[f"fwd_{m}"], G[f"bwd_{m}"] = fwd & keep, bwd & keep
        print(f"    {m}: {int((fwd | bwd).sum()):,} edges, {int(keep.sum()):,} in connected network", flush=True)
    return G


def _largest_components(N, a, b, ok, min_size):
    """Keep edges in the largest connected component (plus any component with at least min_size edges)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    idx = np.where(ok)[0]
    m = coo_matrix((np.ones(len(idx)), (a[idx], b[idx])), shape=(N, N))
    _, lab = connected_components(m, directed=False)
    el = lab[a]
    counts = np.bincount(el[idx], minlength=lab.max() + 1)
    big = counts.argmax()
    good = (counts >= min_size)
    good[big] = True
    return ok & good[el]


def signals_per_edge(G: dict, signal_node_ids: set[int]) -> np.ndarray:
    """Traffic signals and stop signs on or at the ends of each edge."""
    return np.array([sum(1 for n in s if n in signal_node_ids) for s in G["osm_nodes"]])


def sample_points(G: dict, spacing: float = 20.0):
    """Points every `spacing` m along every edge, in local metres → (x, y, edge index)."""
    lon0, lat0, kx, ky = G["proj"]
    xs, ys, es = [], [], []
    for i, g in enumerate(G["geom"]):
        x = (g[:, 0] - lon0) * kx; y = (g[:, 1] - lat0) * ky
        d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
        if d[-1] <= 0:
            continue
        t = np.arange(spacing / 2, d[-1], spacing) if d[-1] > spacing else np.array([d[-1] / 2])
        xs.append(np.interp(t, d, x)); ys.append(np.interp(t, d, y)); es.append(np.full(len(t), i))
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(es)


def project(G: dict, lon, lat):
    lon0, lat0, kx, ky = G["proj"]
    return (np.asarray(lon) - lon0) * kx, (np.asarray(lat) - lat0) * ky


def _rdp(pts: np.ndarray, eps: float) -> np.ndarray:
    if len(pts) < 3:
        return pts
    s, e = pts[0], pts[-1]
    d = e - s
    n = np.hypot(*d) or 1e-9
    dist = np.abs(d[0] * (pts[1:-1, 1] - s[1]) - d[1] * (pts[1:-1, 0] - s[0])) / n
    i = int(dist.argmax()) + 1
    if dist[i - 1] > eps:
        return np.vstack([_rdp(pts[:i + 1], eps)[:-1], _rdp(pts[i:], eps)])
    return np.vstack([s, e])


def write(G: dict, mode: str, path: Path, feat: dict[str, np.ndarray] | None = None, extra: dict | None = None,
          sparse: dict[str, list[list[tuple[int, int]]]] | None = None) -> dict:
    """Compact JSON for the browser router: integer coordinates (1e-5°), delta-coded; one column per attribute.
    feat holds per-edge scores already scaled to 0–100 (uint8)."""
    keep = G[f"fwd_{mode}"] | G[f"bwd_{mode}"]
    ei = np.where(keep)[0]
    used = np.unique(np.concatenate([G["a"][ei], G["b"][ei]]))
    remap = -np.ones(len(G["nlon"]), dtype=int)
    remap[used] = np.arange(len(used))
    q = lambda v: np.round(np.asarray(v) * 1e5).astype(np.int64)
    nx, ny = q(G["nlon"][used]), q(G["nlat"][used])
    lon0, lat0, kx, ky = G["proj"]
    gc, g = [], []
    for i in ei:
        pts = G["geom"][i]
        xy = np.c_[(pts[:, 0] - lon0) * kx, (pts[:, 1] - lat0) * ky]
        keep_pts = _rdp(xy, 2.0)
        mid = q(keep_pts[1:-1] / [kx, ky] + [lon0, lat0]) if len(keep_pts) > 2 else np.zeros((0, 2), dtype=np.int64)
        prev = np.array([nx[remap[G["a"][i]]], ny[remap[G["a"][i]]]])
        for p in mid:
            g += [int(p[0] - prev[0]), int(p[1] - prev[1])]
            prev = p
        gc.append(len(mid))
    names = sorted({G["name"][i] for i in ei})
    nm = {n: j for j, n in enumerate(names)}
    flags = (G[f"fwd_{mode}"][ei].astype(int) | G[f"bwd_{mode}"][ei].astype(int) << 1 | G["bridge"][ei].astype(int) << 2
             | G["unpaved"][ei].astype(int) << 3 | G["bikeinfra"][ei].astype(int) << 4)
    sp = {}
    for k, per_edge in (sparse or {}).items():     # per-edge lists of (id, count) → offsets + flat ids + counts
        off, ids, cnt = [0], [], []
        for i in ei:
            for a_, c_ in per_edge[i]:
                ids.append(int(a_)); cnt.append(int(c_))
            off.append(len(ids))
        sp[k] = {"off": off, "id": ids, "n": cnt}
    out = {"v": 1, "mode": mode, "classes": CLASSES, "sparse": sp,
           "nx": np.diff(nx, prepend=0).tolist(), "ny": np.diff(ny, prepend=0).tolist(),
           "a": remap[G["a"][ei]].tolist(), "b": remap[G["b"][ei]].tolist(),
           "len": np.round(G["length"][ei]).astype(int).tolist(), "cls": G["cls"][ei].tolist(),
           "speed": G["speed"][ei].tolist(), "lanes": G["lanes"][ei].tolist(), "flags": flags.tolist(),
           "name": [nm[G["name"][i]] for i in ei], "names": names, "gc": gc, "g": g,
           "feat": {k: np.clip(np.round(v[ei]), 0, 100).astype(int).tolist() for k, v in (feat or {}).items()},
           **(extra or {})}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return {"edges": int(len(ei)), "nodes": int(len(used)), "kb": path.stat().st_size // 1024, "index": ei}


# ------------------------------------------------------------------ routing in Python (curated routes)

def router(G: dict, mode: str, cost: np.ndarray):
    """Directed sparse graph for `mode` with per-edge cost; returns (matrix, edge lookup)."""
    from scipy.sparse import csr_matrix
    fwd, bwd = G[f"fwd_{mode}"], G[f"bwd_{mode}"]
    src = np.concatenate([G["a"][fwd], G["b"][bwd]]); dst = np.concatenate([G["b"][fwd], G["a"][bwd]])
    eid = np.concatenate([np.where(fwd)[0], np.where(bwd)[0]]); c = np.concatenate([cost[fwd], cost[bwd]])
    best = {}
    for s_, d_, e_, c_ in zip(src, dst, eid, c):
        k = (int(s_), int(d_))
        if k not in best or c_ < best[k][1]:
            best[k] = (int(e_), float(c_))
    ks = list(best)
    N = len(G["nlon"])
    M = csr_matrix(([best[k][1] + 1e-6 for k in ks], ([k[0] for k in ks], [k[1] for k in ks])), shape=(N, N))
    return M, {k: v[0] for k, v in best.items()}


def nearest_node(G: dict, mode: str, lon: float, lat: float) -> int:
    ok = G[f"fwd_{mode}"] | G[f"bwd_{mode}"]
    cand = np.unique(np.concatenate([G["a"][ok], G["b"][ok]]))
    x, y = project(G, G["nlon"][cand], G["nlat"][cand])
    px, py = project(G, lon, lat)
    return int(cand[np.argmin((x - px) ** 2 + (y - py) ** 2)])


def route(G: dict, mode: str, M, lookup, waypoints: list[tuple[float, float]]) -> list[tuple[int, bool]] | None:
    """[(edge id, traversed backwards)] of the cheapest path through the waypoints (lon, lat), in order."""
    from scipy.sparse.csgraph import dijkstra
    nodes = [nearest_node(G, mode, lo, la) for lo, la in waypoints]
    path = []
    for s, t in zip(nodes[:-1], nodes[1:]):
        _, pred = dijkstra(M, indices=s, return_predecessors=True)
        if pred[t] < 0 and s != t:
            return None
        seq, v = [], t
        while v != s:
            u = pred[v]
            e = lookup[(int(u), int(v))]
            seq.append((e, bool(G["a"][e] != u)))
            v = u
        path += seq[::-1]
    return path


def file_steps(info: dict, steps: list[tuple[int, bool]]) -> list[list]:
    """Re-index route steps from build() edge ids to the edge order of a written graph file (see write())."""
    inv = {int(g): f for f, g in enumerate(info["index"])}
    return [[inv[e], int(rev)] for e, rev in steps if e in inv]

