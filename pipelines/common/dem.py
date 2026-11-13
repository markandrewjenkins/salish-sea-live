"""Copernicus GLO-30 surface model (30 m; it includes buildings and trees) and a fast multi-point viewshed.

Tiles are public on AWS without login: https://registry.opendata.aws/copernicus-dem/
Licence: Copernicus DEM, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS
by the European Union and ESA; free use with attribution.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import requests

from .http import USER_AGENT

URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"


def _name(lat: int, lon: int) -> str:
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def tile(lat: int, lon: int, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    n = _name(lat, lon)
    f = cache / f"{n}.tif"
    if not f.exists():
        r = requests.get(URL.format(n=n), headers={"User-Agent": USER_AGENT}, timeout=600)
        r.raise_for_status()
        f.write_bytes(r.content)
        print(f"    downloaded {f.name} ({len(r.content) / 1e6:.0f} MB)", flush=True)
    return f


def mosaic(bbox, cache: Path, margin: float = 0.03):
    """Heights over bbox (s, w, n, e) plus a margin → (array, (lon0, lat0) of the top-left corner, (dlon, dlat) per cell).
    Assumes tiles of equal resolution (true between 50° S and 50° N: 1/3600°)."""
    import tifffile
    s, w, n, e = bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin
    lats = range(math.floor(s), math.floor(n) + 1)
    lons = range(math.floor(w), math.floor(e) + 1)
    rows = []
    for la in sorted(lats, reverse=True):
        rows.append(np.hstack([tifffile.imread(tile(la, lo, cache)) for lo in lons]))
    full = np.vstack(rows)
    lon_tl, lat_tl, d = min(lons), max(lats) + 1, 1 / 3600
    c0, c1 = int((w - lon_tl) / d), int(math.ceil((e - lon_tl) / d))
    r0, r1 = int((lat_tl - n) / d), int(math.ceil((lat_tl - s) / d))
    return full[r0:r1, c0:c1].astype(np.float32), (lon_tl + c0 * d, lat_tl - r0 * d), (d, d)


def water_view(z, water, px, py, cell_m, *, rays=24, max_m=2000.0, step_m=25.0, eye=1.5, full_at=10, chunk=60000):
    """For observer points at fractional grid positions (px = column, py = row), cast `rays` sight lines up to max_m.
    A cell along a ray is visible when its elevation angle is at least the steepest seen so far on that ray.
    Score per point = mean over rays of min(1, visible water steps / full_at), so 0 = no water in sight and
    1 = plenty of open water visible in every direction. Ground under the observer is the lowest surface in the
    3 × 3 neighbourhood (roads run under tree canopy in a surface model), plus `eye` metres.
    cell_m: (metres per column, metres per row)."""
    H, W = z.shape
    from scipy.ndimage import minimum_filter
    ground = minimum_filter(z, size=3)
    out = np.zeros(len(px), dtype=np.float32)
    steps = np.arange(1, int(max_m / step_m) + 1) * step_m
    angs = np.linspace(0, 2 * np.pi, rays, endpoint=False)
    for a in range(0, len(px), chunk):
        x0, y0 = px[a:a + chunk], py[a:a + chunk]
        ci = np.clip(np.round(x0).astype(int), 0, W - 1); ri = np.clip(np.round(y0).astype(int), 0, H - 1)
        z0 = ground[ri, ci] + eye
        tot = np.zeros(len(x0), dtype=np.float32)
        for th in angs:
            dx, dy = math.cos(th) / cell_m[0], -math.sin(th) / cell_m[1]
            best = np.full(len(x0), -np.inf, dtype=np.float32)
            seen = np.zeros(len(x0), dtype=np.float32)
            for d in steps:
                c = np.round(x0 + dx * d).astype(int); r = np.round(y0 + dy * d).astype(int)
                ok = (c >= 0) & (c < W) & (r >= 0) & (r < H)
                c = np.clip(c, 0, W - 1); r = np.clip(r, 0, H - 1)
                zz = z[r, c]
                ang = (zz - z0) / d
                vis = ok & (ang >= best)
                seen += vis & water[r, c]
                best = np.maximum(best, np.where(ok, ang, best))
            tot += np.minimum(1, seen / full_at)
        out[a:a + chunk] = tot / rays
    return out
