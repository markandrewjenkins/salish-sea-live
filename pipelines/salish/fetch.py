"""Download inputs for Salish Sea Live.

  python -m pipelines.salish.fetch [orcasound|orcahello|acartia|inat|ais|live|all]

Personal data is dropped at the source: OrcaHello moderator identities and free-text comments,
and Acartia reporter names/comments, are never stored.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import zipfile
from datetime import datetime, timezone

import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import ACARTIA, AIS_DAY, AIS_URL, BBOX, INAT_TAXA, ORCAHELLO, RAW

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def save(df: pd.DataFrame, name: str) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / f"{name}.parquet", index=False)


def orcahello(delay: float = 3.0) -> None:
    """Resumable and deliberately slow: OrcaHello runs on a small Azure app, so each page is saved
    and the crawl stops cleanly (keeping what it has) if the service is unavailable."""
    pages_dir = RAW / "orcahello_pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    page = 1
    while True:
        f = pages_dir / f"{page:04d}.json"
        if f.exists():
            d = json.loads(f.read_text(encoding="utf-8"))
        else:
            d = None
            for attempt in range(3):
                try:
                    r = S.get(ORCAHELLO, params={"Page": page, "SortBy": "timestamp", "SortOrder": "asc", "Timeframe": "all",
                                                 "RecordsPerPage": 50}, timeout=120)
                    if r.status_code == 200:
                        d = r.json()
                        break
                except (requests.RequestException, ValueError):
                    pass
                time.sleep(30)
            if d is None:
                print(f"    OrcaHello unavailable at page {page}; keeping {page - 1} pages (rerun to resume)", flush=True)
                break
            # drop moderator identity and free-text comments before anything touches disk
            for x in d:
                x.pop("moderator", None)
                x.pop("comments", None)
            f.write_text(json.dumps(d), encoding="utf-8")
            time.sleep(delay)
        if page % 25 == 0:
            print(f"    OrcaHello page {page}", flush=True)
        if len(d) < 50:
            break
        page += 1
    rows = []
    for f in sorted(pages_dir.glob("*.json")):
        for x in json.loads(f.read_text(encoding="utf-8")):
            ann = x.get("annotations") or []
            confs = [a.get("confidence") for a in ann if a.get("confidence") is not None]
            spans = [(a.get("startTime") or 0, a.get("endTime") or 0) for a in ann]
            loc = x.get("location") or {}
            rows.append({
                "id": x["id"], "timestamp": x["timestamp"], "node": loc.get("id"), "node_name": loc.get("name"),
                "lon": loc.get("longitude"), "lat": loc.get("latitude"), "confidence": x.get("confidence"),
                "n_ann": len(ann), "ann_max": max(confs) if confs else None, "ann_mean": sum(confs) / len(confs) if confs else None,
                "ann_span": (max(e for _, e in spans) - min(s for s, _ in spans)) if spans else 0,
                "ann_covered": sum(max(0, e - s) for s, e in spans),
                "reviewed": x.get("reviewed"), "found": (x.get("found") or "").lower(), "tags": x.get("tags"),
                "ai_model": x.get("aiModel"), "audio": x.get("audioUri"), "spectrogram": x.get("spectrogramUri"),
            })
    if not rows:
        print("  OrcaHello: no pages yet")
        return
    df = pd.DataFrame(rows).drop_duplicates("id")
    df["timestamp"] = pd.to_datetime(df.timestamp, utc=True, format="ISO8601")
    save(df, "orcahello")
    print(f"  OrcaHello: {len(df):,} detections, {int(df.reviewed.sum()):,} reviewed", flush=True)


def orcasound() -> None:
    """Listener reports from the Orcasound live app (category whale / vessel / other), without free text."""
    url = "https://live.orcasound.net/api/json/detections"
    rows, offset, feeds = [], 0, {}
    while True:
        d = get_json(url, {"page[limit]": 500, "page[offset]": offset, "sort": "timestamp", "include": "feed",
                           "fields[feed]": "node_name,name"}, min_interval=1.0, timeout=180)
        for inc in d.get("included", []):
            feeds[inc["id"]] = inc["attributes"].get("node_name")
        batch = d.get("data", [])
        for x in batch:
            a = x["attributes"]
            fid = ((x.get("relationships") or {}).get("feed") or {}).get("data") or {}
            rows.append({"timestamp": a.get("timestamp"), "category": a.get("category"), "source": a.get("source"),
                         "listeners": a.get("listener_count"), "feed": fid.get("id")})
        if len(batch) < 500:
            break
        offset += 500
        if offset % 5000 == 0:
            print(f"    Orcasound reports {offset:,}", flush=True)
    df = pd.DataFrame(rows)
    df["node"] = df.feed.map(feeds)
    df["timestamp"] = pd.to_datetime(df.timestamp, utc=True, format="ISO8601")
    save(df.drop(columns="feed"), "orcasound_reports")
    print(f"  Orcasound: {len(df):,} listener reports · {df.category.value_counts().to_dict()}", flush=True)


def acartia() -> None:
    d = get_json(ACARTIA, timeout=120)
    keep = []
    for x in d:
        keep.append({"type": x.get("type"), "count": x.get("no_sighted"), "lat": x.get("latitude"), "lon": x.get("longitude"),
                     "created": x.get("created"), "source": x.get("data_source_name"), "entity": x.get("data_source_entity"),
                     "trusted": x.get("trusted")})
    df = pd.DataFrame(keep)
    save(df, "acartia")
    print(f"  Acartia: {len(df)} current sightings · {df.type.value_counts().to_dict()}", flush=True)


def inat() -> None:
    s, w, n, e = BBOX
    rows = []
    for label, name in INAT_TAXA.items():
        t = get_json("https://api.inaturalist.org/v1/taxa", {"q": name, "rank": "species", "per_page": 1})["results"][0]
        id_above = 0
        while True:
            d = get_json("https://api.inaturalist.org/v1/observations", {
                "taxon_id": t["id"], "nelat": n, "nelng": e, "swlat": s, "swlng": w, "quality_grade": "research",
                "per_page": 200, "order_by": "id", "order": "asc", "id_above": id_above}, min_interval=1.1)
            res = d.get("results", [])
            for o in res:
                if not o.get("location") or not o.get("observed_on"):
                    continue
                la, lo = map(float, o["location"].split(","))
                rows.append({"species": label, "date": o["observed_on"], "lat": la, "lon": lo})
            if len(res) < 200:
                break
            id_above = res[-1]["id"]
        print(f"  iNaturalist {label}: {sum(r['species'] == label for r in rows):,}", flush=True)
    save(pd.DataFrame(rows), "inat_whales")


def ais() -> None:
    d = pd.Timestamp(AIS_DAY)
    url = AIS_URL.format(y=d.year, d=d.strftime("%Y_%m_%d"))
    print(f"  downloading {url} (≈400 MB)…", flush=True)
    r = S.get(url, timeout=1800)
    r.raise_for_status()
    s, w, n, e = BBOX
    z = zipfile.ZipFile(io.BytesIO(r.content))
    name = next(nm for nm in z.namelist() if nm.endswith(".csv"))
    frames = []
    with z.open(name) as f:
        for chunk in pd.read_csv(f, chunksize=500_000, usecols=["MMSI", "BaseDateTime", "LAT", "LON", "SOG", "VesselName", "VesselType", "Length"]):
            frames.append(chunk[chunk.LAT.between(s, n) & chunk.LON.between(w, e)])
    df = pd.concat(frames, ignore_index=True)
    save(df, "ais_day")
    print(f"  AIS {AIS_DAY}: {len(df):,} positions from {df.MMSI.nunique():,} vessels in the Salish Sea", flush=True)


def live() -> None:
    """Optional: snapshot live ship positions from aisstream.io when AISSTREAM_API_KEY is set."""
    key = os.environ.get("AISSTREAM_API_KEY")
    if not key:
        print("  AISSTREAM_API_KEY not set; skipping live ships")
        return
    import asyncio
    import json
    import websockets

    s, w, n, e = BBOX

    async def run(seconds=120):
        ships = {}
        async with websockets.connect("wss://stream.aisstream.io/v0/stream") as ws:
            await ws.send(json.dumps({"APIKey": key, "BoundingBoxes": [[[s, w], [n, e]]], "FilterMessageTypes": ["PositionReport", "ShipStaticData"]}))
            end = time.time() + seconds
            while time.time() < end:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                except asyncio.TimeoutError:
                    continue
                meta = msg.get("MetaData", {})
                mmsi = meta.get("MMSI")
                if msg.get("MessageType") == "PositionReport":
                    p = msg["Message"]["PositionReport"]
                    ships.setdefault(mmsi, {}).update({"lat": p["Latitude"], "lon": p["Longitude"], "sog": p.get("Sog"),
                                                       "cog": p.get("Cog"), "name": (meta.get("ShipName") or "").strip()})
                elif msg.get("MessageType") == "ShipStaticData":
                    ships.setdefault(mmsi, {}).update({"type": msg["Message"]["ShipStaticData"].get("Type")})
        return ships

    ships = asyncio.run(run())
    df = pd.DataFrame([{"mmsi": k, **v} for k, v in ships.items() if "lat" in v])
    df["fetched"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    save(df, "ships_live")
    print(f"  live ships: {len(df)}", flush=True)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    for name, fn in [("orcasound", orcasound), ("orcahello", orcahello), ("acartia", acartia), ("inat", inat), ("ais", ais), ("live", live)]:
        if what in (name, "all"):
            print(f"{name}…", flush=True)
            fn()
