"""Trip-planner networks for the tree dashboards (Cherry Blossom Watch, Fall Foliage Watch).

For each city: the road network for car, bike and foot, with every street tree attached to its nearest road segment
(within 30 m) as a sparse list of (tree type, count). The page turns those counts into "in bloom" or "in colour"
for the chosen date.

Ready-made routes are data-driven. The streets with the most top-tier trees are grouped into neighbourhood clusters,
and each cluster becomes a route through its best streets, for every travel mode.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.neighbors import KDTree

from . import roadgraph as rg
from .osm import fetch_tiled


def roads(bbox, raw: Path, shared: list[Path] = (), pbf_city: str | None = None, osm_dir: Path | None = None) -> list[dict]:
    """Road elements for bbox: cut from a larger cached download when one covers it, else read from the city's
    OpenStreetMap extract (cached as raw/roads.json), else fetched from Overpass."""
    s, w, n, e = bbox
    for f in shared:
        if f.exists():
            els = json.loads(f.read_text(encoding="utf-8"))["elements"]
            nodes = {x["id"]: x for x in els if x["type"] == "node"}
            inside = {i for i, x in nodes.items() if s <= x["lat"] <= n and w <= x["lon"] <= e}
            ways = [x for x in els if x["type"] == "way" and any(m in inside for m in x.get("nodes", []))]
            need = {m for x in ways for m in x["nodes"]}
            print(f"    roads cut from {f.parent.name}/{f.name}: {len(ways):,} ways", flush=True)
            return ways + [nodes[i] for i in need if i in nodes]
    cache = raw / "roads.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))["elements"]
    if pbf_city:
        from . import osm_pbf
        d = osm_pbf.extract(osm_pbf.download(pbf_city, osm_dir or raw), bbox)["roads"]
        raw.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d), encoding="utf-8")
        return d["elements"]
    return fetch_tiled(rg.ROAD_SELECTOR, bbox, raw / "roads_tiles", step=0.1)["elements"]


def attach(G, lon, lat, cls, radius=30.0):
    """Each tree to its nearest road sample within radius → per-edge sorted [(cls, count)]."""
    sx, sy, se = rg.sample_points(G, 10.0)
    tx, ty = rg.project(G, lon, lat)
    d, i = KDTree(np.c_[sx, sy]).query(np.c_[tx, ty], k=1)
    ok = d[:, 0] <= radius
    df = pd.DataFrame({"e": se[i[ok, 0]], "c": np.asarray(cls)[ok]})
    per = [[] for _ in range(len(G["geom"]))]
    for (e, c), n in df.groupby(["e", "c"]).size().items():
        per[int(e)].append((int(c), int(n)))
    print(f"    {ok.sum():,} of {len(ok):,} trees within {radius:.0f} m of a road or path", flush=True)
    return per


def presets(G, infos, per, good: set[int], trees: pd.DataFrame, *, n_clusters=3, per_cluster=5, label="trees"):
    """Routes through the streets whose best stretch is most densely lined with `good` trees.

    Streets are the road network's own named ways, so long arterials don't win just by being long. Each street's
    best ~600 m (its densest blocks) is scored by good trees per 100 m, and the route passes through that stretch."""
    good_e = np.array([sum(n for c, n in p if c in good) for p in per], dtype=float)
    L = np.maximum(G["length"], 1)
    walk = G["fwd_foot"] | G["bwd_foot"]
    cls = np.array(rg.CLASSES)[G["cls"]]
    ok = walk & np.isin(cls, ["residential", "tertiary", "unclassified", "living_street", "secondary", "service", "pedestrian", "footway", "path"])
    df = pd.DataFrame({"name": G["name"], "good": good_e, "len": L, "e": np.arange(len(L))})[ok]
    df = df[df.name.str.len() > 0]
    rows = []
    for name, g in df.groupby("name"):
        g = g.assign(d=g.good / g.len).sort_values("d", ascending=False)
        top = g[g.len.cumsum() <= max(600, g.len.iloc[0])]
        gs, ls = top.good.sum(), top.len.sum()
        if gs < 12:
            continue
        best = int(top.e.iloc[0])
        mid = G["geom"][best][len(G["geom"][best]) // 2]
        rows.append({"street": name, "good": gs, "density": gs / ls * 100, "score": gs / ls * 100 * min(1, gs / 40),
                     "lon": float(mid[0]), "lat": float(mid[1])})
    st = pd.DataFrame(rows).sort_values("score", ascending=False).head(60) if rows else pd.DataFrame()
    if len(st) < 4:
        return []
    # compact, walkable groups: seed with the best remaining street, gather the best others within 1.5 km
    x, y = rg.project(G, st.lon.to_numpy(), st.lat.to_numpy())
    st = st.assign(x=x, y=y, cl=-1)
    cl = 0
    while cl < n_clusters:
        free = st[st.cl == -1]
        if len(free) < 3:
            break
        seed = free.iloc[0]
        near = free[np.hypot(free.x - seed.x, free.y - seed.y) <= 2000].head(per_cluster)
        if len(near) < 3:
            st.loc[seed.name, "cl"] = -2          # isolated street: skip it as a seed
            continue
        st.loc[near.index, "cl"] = cl
        cl += 1
    out = []
    for cl, grp in st[st.cl >= 0].groupby("cl"):
        top = grp.sort_values("score", ascending=False).head(per_cluster).set_index("street")
        order, rest = [top.index[0]], list(top.index[1:])
        while rest:
            px, py = rg.project(G, top.loc[order[-1], "lon"], top.loc[order[-1], "lat"])
            qx, qy = rg.project(G, top.loc[rest, "lon"].to_numpy(), top.loc[rest, "lat"].to_numpy())
            order.append(rest.pop(int(np.argmin((qx - px) ** 2 + (qy - py) ** 2))))
        wps = [(float(top.loc[s_, "lon"]), float(top.loc[s_, "lat"])) for s_ in order]
        names = [str(s_) for s_ in order]
        entry = {"id": f"best-{cl}", "name": f"{names[0]}, {names[1]} & more" if len(names) > 2 else " & ".join(names),
                 "streets": names, "waypoints": wps, "good": int(top.good.sum()), "steps": {}}
        dens = good_e / L * 100
        for mode in rg.MODES:
            kmh = {"bike": 16, "foot": 4.8}.get(mode)
            secs = G["length"] / (((np.minimum(G["speed"], 90) * 0.85) if kmh is None else kmh) / 3.6)
            M, look = rg.router(G, mode, secs * (1 + 2.5 * np.exp(-dens / 4)))
            path = rg.route(G, mode, M, look, wps)
            if path:
                entry["steps"][mode] = rg.file_steps(infos[mode], path)
        out.append(entry)
        print(f"    route {entry['name']}: {entry['good']} {label} on its best blocks", flush=True)
    return out


def build_city(key, bbox, raw: Path, out: Path, prefix: str, trees: pd.DataFrame, good: set[int], *, shared=(), label="trees",
               pbf_city=None, osm_dir=None):
    """trees: lon, lat, cls (int id the page understands), street. Writes <prefix><key>_<mode>.json; returns presets."""
    G = rg.build(roads(bbox, raw, shared, pbf_city, osm_dir), bbox)
    per = attach(G, trees.lon.to_numpy(), trees.lat.to_numpy(), trees.cls.to_numpy())
    infos = {}
    for mode in rg.MODES:
        infos[mode] = rg.write(G, mode, out / f"{prefix}{key}_{mode}.json", sparse={"trees": per})
        print(f"    {key} {mode}: {infos[mode]['edges']:,} edges, {infos[mode]['kb']:,} KB", flush=True)
    return presets(G, infos, per, good, trees, label=label)
