"""OpenStreetMap downloads through the Overpass API, tiled and polite.

Every query is split into tiles so no single response is huge. Responses are cached on disk per tile, so a rerun only
fetches what's missing. Rate limits (429/502/504) back off and rotate between public mirrors.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from .http import USER_AGENT

MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def overpass(query: str, *, timeout: int = 300, tries: int = 8) -> dict:
    last = None
    for attempt in range(tries):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            r = S.post(url, data={"data": query}, timeout=timeout + 60)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                return r.json()
            last = f"{r.status_code} {r.text[:120]!r}"
        except requests.RequestException as e:
            last = str(e)[:120]
        wait = min(120, 10 * 2 ** attempt)
        print(f"    overpass busy ({last}); retry in {wait}s", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"Overpass failed: {last}")


def tiles(bbox: tuple[float, float, float, float], step: float):
    """(south, west, north, east) → sub-boxes of at most `step` degrees."""
    s, w, n, e = bbox
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            yield (round(lat, 4), round(lon, 4), round(min(n, lat + step), 4), round(min(e, lon + step), 4))
            lon += step
        lat += step


def fetch_tiled(selector: str, bbox, cache: Path, *, step: float = 0.12, out: str = "body", recurse: bool = True) -> dict:
    """Run `selector` (an Overpass statement with {bbox} placeholders) over tiles; merge elements by type and id.
    With recurse, ways also bring their nodes (needed for road topology)."""
    cache.mkdir(parents=True, exist_ok=True)
    seen: dict[tuple[str, int], dict] = {}
    for t in tiles(bbox, step):
        f = cache / f"{t[0]}_{t[1]}_{t[2]}_{t[3]}.json"
        if f.exists():
            data = json.loads(f.read_text(encoding="utf-8"))
        else:
            bb = ",".join(map(str, t))
            q = f"[out:json][timeout:240];({selector.format(bbox=bb)});out {out};" + (">;out skel qt;" if recurse else "")
            data = overpass(q)
            f.write_text(json.dumps(data), encoding="utf-8")
            time.sleep(4)
        for el in data.get("elements", []):
            seen[(el["type"], el["id"])] = el
    return {"elements": list(seen.values())}
