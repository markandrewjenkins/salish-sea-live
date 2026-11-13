"""Download inputs for Salish Sea Live.

  python -m pipelines.salish.fetch daily            # the CI set: orcasound, acartia, inat_recent, orcahello_recent, live
  python -m pipelines.salish.fetch all              # everything, including the slow OrcaHello crawl and NOAA AIS
  python -m pipelines.salish.fetch acartia ais ...  # any list of sources

Each source runs on its own: a failure is logged to data/salish/raw/status.json (and as a GitHub Actions warning)
and the others still run, so one bad upstream record can't freeze the whole page again. The build reads status.json
and shows per-source freshness on the page.

Personal data is dropped at the source: OrcaHello moderator identities and free-text comments, Orcasound listener
descriptions, and Acartia reporter names/comments are never stored.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import (ACARTIA, AIS_DAYS, AIS_INDEX, AIS_URL, BBOX, INAT_CETACEA, ORCAHELLO, ORCASOUND_API, OUT, RAW)

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT


def save(df: pd.DataFrame, name: str) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / f"{name}.parquet", index=False)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


def in_bbox(lat, lon) -> pd.Series:
    s, w, n, e = BBOX
    return pd.Series(lat).between(s, n).to_numpy() & pd.Series(lon).between(w, e).to_numpy()


# ============================================================================= OrcaHello

def _oh_rows(items: list[dict]) -> list[dict]:
    rows = []
    for x in items:
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
            "reviewed": bool(x.get("reviewed")), "found": (x.get("found") or "").lower(), "tags": x.get("tags"),
            "ai_label": x.get("globalPredictionLabel") or None,
            "ai_model": x.get("aiModel"), "audio": x.get("audioUri"), "spectrogram": x.get("spectrogramUri"),
        })
    return rows


def _oh_frame(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows).drop_duplicates("id", keep="last")
    df["timestamp"] = pd.to_datetime(df.timestamp, utc=True, format="ISO8601")
    return df


def orcahello(delay: float = 3.0) -> dict:
    """Full history, resumable and deliberately slow: OrcaHello runs on a small Azure app, so each page is saved
    and the crawl stops cleanly (keeping what it has) if the service is unavailable. Local only, never in CI.

    Pages are sorted oldest-first, so new detections only ever extend the last page. A short (or empty) last page
    is therefore never trusted from the cache: it is fetched again, otherwise the crawl would stop there forever
    (which is what froze the clips at September 2026)."""
    pages_dir = RAW / "orcahello_pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    page = 1
    while True:
        f = pages_dir / f"{page:04d}.json"
        d = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
        if d is not None and len(d) < 50:
            d = None                                      # partial last page: refresh it
        if d is None:
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
            if d:
                f.write_text(json.dumps(d), encoding="utf-8")
            elif f.exists():
                f.unlink()
            time.sleep(delay)
        if page % 25 == 0:
            print(f"    OrcaHello page {page}", flush=True)
        if len(d) < 50:
            break
        page += 1
    rows = []
    for f in sorted(pages_dir.glob("*.json")):
        rows += _oh_rows(json.loads(f.read_text(encoding="utf-8")))
    if not rows:
        raise RuntimeError("OrcaHello: no pages yet")
    df = _oh_frame(rows)
    save(df, "orcahello")
    print(f"  OrcaHello: {len(df):,} detections, {int(df.reviewed.sum()):,} reviewed, newest {df.timestamp.max():%Y-%m-%d %H:%M}", flush=True)
    return {"n": len(df), "newest": df.timestamp.max().isoformat()}


def orcahello_recent(delay: float = 3.0, max_pages: int = 12) -> dict:
    """The last week of detections, newest first (≈5 pages): light enough for the daily CI run.
    Accumulates into orcahello_recent.parquet (last 60 days) so the tier list has a month of history."""
    rows, page = [], 1
    while page <= max_pages:
        r = S.get(ORCAHELLO, params={"Page": page, "SortBy": "timestamp", "SortOrder": "desc", "Timeframe": "1w",
                                     "RecordsPerPage": 50}, timeout=120)
        r.raise_for_status()
        d = r.json()
        for x in d:
            x.pop("moderator", None)
            x.pop("comments", None)
        rows += _oh_rows(d)
        pages = int(r.headers.get("totalAmountPages") or 0)
        if len(d) < 50 or (pages and page >= pages):
            break
        page += 1
        time.sleep(delay)
    if not rows:
        raise RuntimeError("OrcaHello returned no detections for the last week")
    df = _oh_frame(rows)
    f = RAW / "orcahello_recent.parquet"
    if f.exists():
        old = pd.read_parquet(f)
        df = pd.concat([old[~old.id.isin(df.id)], df], ignore_index=True)   # newer copy wins (verdicts change)
    df = df[df.timestamp >= pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=60)].sort_values("timestamp")
    save(df, "orcahello_recent")
    print(f"  OrcaHello recent: {len(rows)} this week, {len(df)} kept (60 days), newest {df.timestamp.max():%Y-%m-%d %H:%M}", flush=True)
    return {"n": len(df), "newest": df.timestamp.max().isoformat()}


# ============================================================================= Orcasound

def orcasound() -> dict:
    """Reports from the Orcasound live app (category whale / vessel / other, source human / machine), without
    free text, plus the hydrophone feed list. playlist + offset locate each report in the HLS archive, so the page
    can replay the moment a listener pressed the button."""
    url = f"{ORCASOUND_API}/detections"
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
                         "listeners": a.get("listener_count"), "feed": fid.get("id"),
                         "playlist": a.get("playlist_timestamp"), "offset": pd.to_numeric(a.get("player_offset"), errors="coerce")})
        if len(batch) < 500:
            break
        offset += 500
        if offset % 5000 == 0:
            print(f"    Orcasound reports {offset:,}", flush=True)
    df = pd.DataFrame(rows)
    df["node"] = df.feed.map(feeds)
    df["timestamp"] = pd.to_datetime(df.timestamp, utc=True, format="ISO8601")
    df["playlist"] = pd.to_numeric(df.playlist, errors="coerce").astype("Int64")
    save(df.drop(columns="feed"), "orcasound_reports")
    try:
        fd = get_json(f"{ORCASOUND_API}/feeds", timeout=60)
        out = [{"node": f["attributes"].get("node_name"), "name": f["attributes"].get("name"), "visible": bool(f["attributes"].get("visible")),
                "lat": (f["attributes"].get("lat_lng") or {}).get("lat"), "lon": (f["attributes"].get("lat_lng") or {}).get("lng")}
               for f in fd.get("data", [])]
        (RAW / "orcasound_feeds.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    except Exception as exc:                                  # the feed list is a nicety; the reports are what matter
        print(f"  Orcasound feed list unavailable: {exc}")
    hum = df[(df.source == "human") & (df.category == "whale")]
    print(f"  Orcasound: {len(df):,} reports ({len(hum):,} human whale reports), newest {df.timestamp.max():%Y-%m-%d %H:%M}", flush=True)
    return {"n": len(df), "newest": df.timestamp.max().isoformat()}


# ============================================================================= sightings

def acartia() -> dict:
    """Acartia's public endpoint only serves the current ~7-day window, so each run is merged into an archive
    (the build also merges into the published sightings.json, which is the durable copy in CI).

    Fields are coerced explicitly: on 2026-11-06 one record arrived with its count and coordinates as strings,
    pyarrow refused the mixed column, and the uncaught error stopped the daily refresh for a week."""
    d = get_json(ACARTIA, timeout=120)
    keep = []
    for x in d:
        keep.append({"id": x.get("entry_id") or x.get("ssemmi_id"), "type": x.get("type"), "count": x.get("no_sighted"),
                     "lat": x.get("latitude"), "lon": x.get("longitude"), "created": x.get("created"),
                     "source": x.get("data_source_name"), "entity": x.get("data_source_entity"), "trusted": x.get("trusted")})
    df = pd.DataFrame(keep)
    for c in ("count", "lat", "lon", "trusted"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    for c in ("id", "type", "created", "source", "entity"):
        df[c] = df[c].astype("string")
    bad = df.lat.isna() | df.lon.isna() | pd.to_datetime(df.created, errors="coerce").isna()
    if bad.any():
        print(f"  Acartia: dropped {int(bad.sum())} records without a usable position or time")
    df = df[~bad]
    save(df, "acartia")
    arch_f = RAW / "acartia_archive.parquet"
    arch = pd.concat([pd.read_parquet(arch_f), df], ignore_index=True) if arch_f.exists() else df
    key = arch.created.astype(str) + arch.lat.round(4).astype(str) + arch.lon.round(4).astype(str) + arch.type.astype(str)
    arch = arch.assign(_k=key).drop_duplicates("_k", keep="last").drop(columns="_k")
    save(arch, "acartia_archive")
    local = df[in_bbox(df.lat, df.lon)]
    print(f"  Acartia: {len(df)} current sightings ({len(local)} in the study area) · {df.type.value_counts().to_dict()} · "
          f"newest {df.created.max()} · archive {len(arch):,}", flush=True)
    return {"n": len(df), "newest": str(df.created.max())}


def _inat_pages(params: dict, label: str) -> list[dict]:
    s, w, n, e = BBOX
    rows, id_above = [], 0
    while True:
        d = get_json("https://api.inaturalist.org/v2/observations", {
            "taxon_id": INAT_CETACEA, "nelat": n, "nelng": e, "swlat": s, "swlng": w, "per_page": 200, "order_by": "id", "order": "asc",
            "id_above": id_above, "fields": "id,observed_on,time_observed_at,location,quality_grade,taxon.name,taxon.preferred_common_name",
            **params}, min_interval=1.1)
        res = d.get("results", [])
        for o in res:
            if not o.get("location") or not o.get("observed_on"):
                continue
            la, lo = map(float, o["location"].split(","))
            t = o.get("taxon") or {}
            rows.append({"id": o["id"], "species": t.get("preferred_common_name") or t.get("name") or "Cetacean", "sci": t.get("name"),
                         "date": o["observed_on"], "time": o.get("time_observed_at"), "lat": la, "lon": lo, "grade": o.get("quality_grade")})
        if len(res) < 200:
            break
        id_above = res[-1]["id"]
        if len(rows) % 2000 < 200:
            print(f"    iNaturalist {label}: {len(rows):,}", flush=True)
    return rows


def inat() -> dict:
    """All research-grade cetacean observations in the study area, all years (season charts, map layer)."""
    rows = _inat_pages({"quality_grade": "research"}, "all years")
    df = pd.DataFrame(rows)
    save(df, "inat_whales")
    print(f"  iNaturalist: {len(df):,} research-grade cetaceans · {df.species.value_counts().head(5).to_dict()}", flush=True)
    return {"n": len(df), "newest": str(df.date.max())}


def inat_recent(days: int = 120) -> dict:
    """The last ~4 months of cetacean observations (research grade and needs-ID) with times, for the date-range map
    and for corroborating hydrophone detections."""
    d1 = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    rows = _inat_pages({"quality_grade": "research,needs_id", "d1": d1}, "recent")
    df = pd.DataFrame(rows)
    save(df, "inat_recent")
    print(f"  iNaturalist recent: {len(df):,} since {d1}, newest {df.date.max() if len(df) else '—'}", flush=True)
    return {"n": len(df), "newest": str(df.date.max()) if len(df) else None}


# ============================================================================= ships

def ais_available() -> list[str]:
    """Days NOAA has published, newest last (this year's and last year's index pages)."""
    days = []
    y = datetime.now(timezone.utc).year
    for yy in (y - 1, y):
        r = S.get(AIS_INDEX.format(y=yy), timeout=60)
        if r.status_code == 200:
            days += re.findall(r'href="ais-(\d{4}-\d{2}-\d{2})\.csv\.zst"', r.text)
    return sorted(set(days))


def ais(n_days: int = AIS_DAYS) -> dict:
    """Latest published days of US Coast Guard AIS, clipped to the study area. Each national day is ~320 MB of
    zstd CSV; it is streamed and filtered on the fly (pyarrow's zstd codec, no temp file) and only the study-area rows
    are cached as data/salish/raw/ais/<day>.parquet. Days already cached or already built are skipped, so in CI this
    only downloads when NOAA publishes a new batch."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.csv as pcsv

    days = ais_available()[-n_days:]
    if not days:
        raise RuntimeError("no AIS days found on NOAA's index pages")
    s, w, n, e = BBOX
    (RAW / "ais").mkdir(parents=True, exist_ok=True)
    cols = ["mmsi", "base_date_time", "longitude", "latitude", "sog", "vessel_name", "vessel_type", "length"]
    types = {"mmsi": pa.int64(), "base_date_time": pa.string(), "longitude": pa.float64(), "latitude": pa.float64(), "sog": pa.float64(),
             "vessel_name": pa.string(), "vessel_type": pa.float64(), "length": pa.float64()}
    got = 0
    for day in days:
        f = RAW / "ais" / f"{day}.parquet"
        if f.exists() or (OUT / "ships" / f"{day}.json").exists():
            continue
        url = AIS_URL.format(y=day[:4], d=day)
        print(f"  AIS {day}: streaming {url}", flush=True)
        t0 = time.time()
        with S.get(url, stream=True, timeout=600) as r:
            r.raise_for_status()
            stream = pa.CompressedInputStream(pa.PythonFile(r.raw, mode="r"), "zstd")
            reader = pcsv.open_csv(stream, read_options=pcsv.ReadOptions(block_size=1 << 24),
                                   convert_options=pcsv.ConvertOptions(include_columns=cols, column_types=types))
            parts = []
            for batch in reader:
                m = pc.and_(pc.and_(pc.greater_equal(batch["latitude"], s), pc.less_equal(batch["latitude"], n)),
                            pc.and_(pc.greater_equal(batch["longitude"], w), pc.less_equal(batch["longitude"], e)))
                sub = batch.filter(m)
                if sub.num_rows:
                    parts.append(sub)
        tbl = pa.Table.from_batches(parts)
        df = tbl.to_pandas().rename(columns={"mmsi": "MMSI", "base_date_time": "BaseDateTime", "longitude": "LON", "latitude": "LAT",
                                             "sog": "SOG", "vessel_name": "VesselName", "vessel_type": "VesselType", "length": "Length"})
        df.to_parquet(f, index=False)
        got += 1
        print(f"  AIS {day}: {len(df):,} positions from {df.MMSI.nunique():,} vessels in the study area ({time.time() - t0:.0f} s)", flush=True)
    # keep the raw cache to the same window as the published days
    for old in (RAW / "ais").glob("*.parquet"):
        if old.stem not in days:
            old.unlink()
    print(f"  AIS: {got} new day(s); window {days[0]} to {days[-1]}", flush=True)
    return {"n": len(days), "newest": days[-1]}


def live() -> dict:
    """Optional: snapshot live ship positions from aisstream.io when AISSTREAM_API_KEY is set (free account)."""
    key = os.environ.get("AISSTREAM_API_KEY")
    f = RAW / "ships_live.parquet"
    if not key:
        if f.exists():
            f.unlink()                                        # never publish an old snapshot as "live"
        print("  AISSTREAM_API_KEY not set; skipping live ships")
        return {"n": 0, "skipped": "AISSTREAM_API_KEY not set"}
    import asyncio

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
    df["fetched"] = now_iso()
    save(df, "ships_live")
    print(f"  live ships: {len(df)}", flush=True)
    return {"n": len(df), "newest": now_iso()}


# ============================================================================= CLI

SOURCES = {"orcasound": orcasound, "orcahello": orcahello, "orcahello_recent": orcahello_recent, "acartia": acartia,
           "inat": inat, "inat_recent": inat_recent, "ais": ais, "live": live}
GROUPS = {"daily": ["orcasound", "acartia", "inat_recent", "orcahello_recent", "live"], "all": list(SOURCES)}


def record(name: str, ok: bool, info: dict | None = None, error: str | None = None) -> None:
    f = RAW / "status.json"
    RAW.mkdir(parents=True, exist_ok=True)
    st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev = st.get(name, {})
    entry = {"ok": ok, "attempted": now_iso(), "last_ok": now_iso() if ok else prev.get("last_ok"),
             "newest": (info or {}).get("newest") or (prev.get("newest") if not ok else None), "error": error}
    if info and info.get("skipped"):
        entry["skipped"] = info["skipped"]
    st[name] = entry
    f.write_text(json.dumps(st, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):                 # Windows consoles: never die on a non-ASCII log line
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    names = []
    for a in argv or ["daily"]:
        names += GROUPS.get(a, [a])
    failed = []
    for name in names:
        if name not in SOURCES:
            print(f"unknown source {name!r}; choose from {', '.join(SOURCES)} or {', '.join(GROUPS)}")
            return 2
        print(f"{name}…", flush=True)
        try:
            info = SOURCES[name]() or {}
            record(name, True, info)
        except Exception as exc:                              # keep going: one source must not block the rest
            msg = f"{type(exc).__name__}: {exc}"[:400]
            traceback.print_exc()
            record(name, False, error=msg)
            failed.append(name)
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::warning title=Salish source failed: {name}::{msg}", flush=True)
    if failed:
        print(f"finished with {len(failed)} failed source(s): {', '.join(failed)} (their last good data is kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
