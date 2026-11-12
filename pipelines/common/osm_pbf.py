"""OpenStreetMap from a city extract (.osm.pbf) instead of the Overpass API.

BBBike publishes weekly extracts for many cities (https://download.bbbike.org/osm/bbbike/). One download per city is
quicker and far gentler on shared servers than thousands of Overpass queries. extract() returns the same element
structures the Overpass path produces, so the rest of the pipeline doesn't care which source was used.
"""
from __future__ import annotations

import time
from pathlib import Path

import osmium
import requests

from .http import USER_AGENT
from .roadgraph import ROAD_SELECTOR  # noqa: F401  (documents the equivalent Overpass query)

BBBIKE = "https://download.bbbike.org/osm/bbbike/{city}/{city}.osm.pbf"
ROAD_HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "motorway_link",
           "trunk_link", "primary_link", "secondary_link", "tertiary_link", "cycleway", "path", "footway", "pedestrian", "track",
           "steps", "bridleway"}
STOP_TAGS = {"amenity": {"ice_cream", "cafe", "bakery", "toilets", "drinking_water"}, "shop": {"ice_cream", "bakery", "farm", "confectionery", "chocolate"},
             "tourism": {"viewpoint", "picnic_site", "attraction", "museum", "artwork", "gallery"}, "natural": {"beach"},
             "man_made": {"lighthouse", "pier"}, "highway": {"rest_area", "traffic_signals", "stop"}}


def download(city: str, dest_dir: Path, max_age_days: float = 6) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    f = dest_dir / f"{city}.osm.pbf"
    if f.exists() and time.time() - f.stat().st_mtime < max_age_days * 86400:
        return f
    with requests.get(BBBIKE.format(city=city), headers={"User-Agent": USER_AGENT}, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = f.with_suffix(".part")
        with open(tmp, "wb") as out:
            for chunk in r.iter_content(1 << 20):
                out.write(chunk)
        tmp.replace(f)
    print(f"    downloaded {f.name} ({f.stat().st_size / 1e6:,.0f} MB)", flush=True)
    return f


def _scenery_tags(t) -> bool:
    nat, lu, lei = t.get("natural"), t.get("landuse"), t.get("leisure")
    return (nat in ("water", "coastline", "beach", "wood", "scrub", "heath", "grassland", "wetland", "cliff")
            or t.get("waterway") in ("river", "riverbank")
            or lei in ("park", "nature_reserve", "garden", "golf_course")
            or lu in ("forest", "meadow", "farmland", "orchard", "vineyard", "cemetery", "industrial", "railway", "commercial", "retail",
                      "recreation_ground", "allotments")
            or t.get("boundary") in ("protected_area", "national_park"))


def _stop_tags(t) -> bool:
    return any(t.get(k) in v for k, v in STOP_TAGS.items()) or "historic" in t or "heritage" in t \
        or "ice_cream" in (t.get("cuisine") or "")


class _H(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.s, self.w, self.n, self.e = bbox
        self.road_ways, self.road_nodes, self.lines, self.areas, self.points = [], {}, [], [], []

    def inside(self, lon, lat):
        return self.s <= lat <= self.n and self.w <= lon <= self.e

    def node(self, n):
        if not n.tags or not n.location.valid():
            return
        t = dict(n.tags)
        if _stop_tags(t) and self.inside(n.location.lon, n.location.lat):
            self.points.append({"type": "node", "id": n.id, "lon": n.location.lon, "lat": n.location.lat, "tags": t})

    def way(self, w):
        t = w.tags
        hw = t.get("highway")
        road = (hw in ROAD_HW and t.get("area") != "yes" and t.get("footway") not in ("sidewalk", "crossing")) or \
               (hw == "service" and "name" in t and "service" not in t and t.get("area") != "yes")
        if road:
            refs, keep = [], False
            for nd in w.nodes:
                if not nd.location.valid():
                    return
                refs.append(nd.ref)
                self.road_nodes[nd.ref] = (nd.location.lon, nd.location.lat)
                keep = keep or self.inside(nd.location.lon, nd.location.lat)
            if keep and len(refs) >= 2:
                self.road_ways.append({"type": "way", "id": w.id, "nodes": refs, "tags": dict(t)})
            return
        if t.get("natural") == "coastline" or t.get("waterway") == "river":
            pts = [{"lon": nd.location.lon, "lat": nd.location.lat} for nd in w.nodes if nd.location.valid()]
            if pts and any(self.inside(p["lon"], p["lat"]) for p in pts):
                self.lines.append({"type": "way", "id": w.id, "geometry": pts, "tags": dict(t)})

    def area(self, a):
        t = dict(a.tags)
        scen, stop = _scenery_tags(t), _stop_tags(t)
        if not (scen or stop):
            return
        for ring in a.outer_rings():
            pts = [{"lon": nd.lon, "lat": nd.lat} for nd in ring if nd.location.valid()]
            if len(pts) < 3:
                continue
            lons = [p["lon"] for p in pts]; lats = [p["lat"] for p in pts]
            if max(lats) < self.s or min(lats) > self.n or max(lons) < self.w or min(lons) > self.e:
                continue
            if scen:
                self.areas.append({"type": "way", "id": a.id, "geometry": pts, "tags": t})
            if stop:
                c = {"lon": (min(lons) + max(lons)) / 2, "lat": (min(lats) + max(lats)) / 2}
                if self.inside(c["lon"], c["lat"]):
                    self.points.append({"type": "way", "id": a.id, "center": c, "tags": t})
                stop = False


def extract(pbf: Path, bbox) -> dict:
    """{"roads": Overpass-style ways+nodes, "scenery": ways with geometry, "stops": points} for bbox (s, w, n, e)."""
    h = _H(bbox)
    h.apply_file(str(pbf), locations=True)
    nodes = [{"type": "node", "id": i, "lon": lo, "lat": la} for i, (lo, la) in h.road_nodes.items()]
    print(f"    {pbf.name}: {len(h.road_ways):,} road ways, {len(h.areas) + len(h.lines):,} scenery shapes, {len(h.points):,} points", flush=True)
    return {"roads": {"elements": h.road_ways + nodes}, "scenery": {"elements": h.areas + h.lines}, "stops": {"elements": h.points}}
