"""Salish Sea Live: orca-call triage model, weekly hearing outlook, whale-sound tier list, whales and shipping layers.

  python -m pipelines.salish.build

Triage model
    OrcaHello's AI flags candidate orca calls on Orcasound hydrophones and volunteers confirm or
    reject them. A gradient-boosted classifier predicts the human verdict from the AI's own
    scores plus context (how busy the hydrophone, and the network, has been in the previous hours,
    time of day, season). Trained on detections before 2025 and tested on 2025–2026, compared with
    ranking by the AI confidence alone.
Hearing outlook
    Probability that listeners report whale sounds at each hydrophone in the coming week
    (Orcasound live-app reports):
    logistic regression on seasonality and recent activity; time-split validation by Brier score.
Whale-sound tier list
    An editorial 0–100 score for the last 30 days of OrcaHello clips and Orcasound listener events, from
    verification, AI confidence, species, clarity, corroboration and recency (see `tier_list`).
Outputs
    salish.json (page data), sightings.json (whale sightings archive, ≤ 1 year), ships/index.json plus one
    ships/<day>.json per AIS day (loaded on demand), whales_inat.json (all-years iNaturalist layer).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score

from .config import (AIS_DAYS, AIS_REGIONS, BBOX, HYDROPHONES, INAT_SEASON, OTHER_HYDROPHONES, OUT, RAW, SHIP_CATS,
                     vessel_category)

TZ = "America/Los_Angeles"
SPLIT = pd.Timestamp("2025-01-01", tz="UTC")


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 4)
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def dump(name, obj, quiet=False):
    f = OUT / name
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(clean(obj), fh, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if not quiet:
        print(f"  wrote {name} ({f.stat().st_size / 1024:,.0f} KB)")


def read_json(name, default=None):
    f = OUT / name
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else default
    except ValueError:
        return default


def in_bbox(lat, lon):
    s, w, n, e = BBOX
    return np.asarray(pd.Series(lat).between(s, n)) & np.asarray(pd.Series(lon).between(w, e))


def km_between(lat1, lon1, lat2, lon2):
    p = np.pi / 180
    a = np.sin((lat2 - lat1) * p / 2) ** 2 + np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(a))


# ============================================================================= triage model

def context_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("timestamp").reset_index(drop=True)
    t = df.timestamp.dt.as_unit("s").astype("int64").to_numpy()
    node = df.node.to_numpy()
    same_1h, any_2h, other_3h, since_prev = (np.zeros(len(df)) for _ in range(4))
    for i in range(len(df)):
        lo = np.searchsorted(t, t[i] - 3 * 3600)
        win_t, win_n = t[lo:i], node[lo:i]
        same_1h[i] = np.sum((win_n == node[i]) & (win_t >= t[i] - 3600))
        any_2h[i] = np.sum(win_t >= t[i] - 7200)
        other_3h[i] = np.sum(win_n != node[i])
        prev = np.nonzero(node[:i] == node[i])[0]
        since_prev[i] = min((t[i] - t[prev[-1]]) / 3600, 24 * 30) if len(prev) else 24 * 30
    local = df.timestamp.dt.tz_convert(TZ)
    df = df.assign(same_1h=same_1h, any_2h=any_2h, other_3h=other_3h, hours_since_prev=since_prev,
                   hour_sin=np.sin(2 * np.pi * local.dt.hour / 24), hour_cos=np.cos(2 * np.pi * local.dt.hour / 24),
                   doy_sin=np.sin(2 * np.pi * local.dt.dayofyear / 365.25), doy_cos=np.cos(2 * np.pi * local.dt.dayofyear / 365.25),
                   node_code=df.node.astype("category").cat.codes)
    return df


FEATURES = ["confidence", "n_ann", "ann_max", "ann_mean", "ann_span", "ann_covered", "same_1h", "any_2h", "other_3h",
            "hours_since_prev", "hour_sin", "hour_cos", "doy_sin", "doy_cos", "node_code"]
FEATURE_LABEL = {"confidence": "AI confidence", "n_ann": "Number of call segments", "ann_max": "Strongest segment", "ann_mean": "Average segment",
                 "ann_span": "Time span of segments", "ann_covered": "Seconds flagged", "same_1h": "Same hydrophone, last hour",
                 "any_2h": "Whole network, last 2 hours", "other_3h": "Other hydrophones, last 3 hours", "hours_since_prev": "Hours since last flag here",
                 "hour_sin": "Time of day", "hour_cos": "Time of day", "doy_sin": "Season", "doy_cos": "Season", "node_code": "Hydrophone"}


def triage(oh: pd.DataFrame) -> dict:
    df = context_features(oh)
    lab = df[df.reviewed & df.found.isin(["yes", "no"])].copy()
    lab["y"] = (lab.found == "yes").astype(int)
    tr, te = lab[lab.timestamp < SPLIT], lab[lab.timestamp >= SPLIT]
    clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=30,
                                         l2_regularization=1.0, categorical_features=[FEATURES.index("node_code")], random_state=5)
    clf.fit(tr[FEATURES], tr.y)
    p = clf.predict_proba(te[FEATURES])[:, 1]
    base = te.confidence.fillna(0).to_numpy()
    y = te.y.to_numpy()

    def at_recall(scores, target):
        prec, rec, thr = precision_recall_curve(y, scores)
        ok = np.nonzero(rec[:-1] >= target)[0]
        k = ok[-1] if len(ok) else 0
        return float((scores >= thr[k]).mean()), float(prec[k])          # share of clips to review, precision

    workload = {}
    for r in (0.9, 0.95):
        mw, mp = at_recall(p, r)
        bw, bp = at_recall(base, r)
        workload[f"{int(r * 100)}"] = {"model_share": mw, "model_precision": mp, "base_share": bw, "base_precision": bp}

    def pr(scores):
        prec, rec, _ = precision_recall_curve(y, scores)
        idx = np.unique(np.linspace(0, len(rec) - 1, 120).astype(int))
        return [[float(rec[i]), float(prec[i])] for i in idx]

    # permutation importance on the test set (grouped where features are pairs)
    groups = {}
    for f in FEATURES:
        groups.setdefault(FEATURE_LABEL[f], []).append(f)
    rng = np.random.default_rng(0)
    auc0 = roc_auc_score(y, p)
    imp = {}
    for label, cols in groups.items():
        drops = []
        for _ in range(3):
            X = te[FEATURES].copy()
            perm = rng.permutation(len(X))
            X[cols] = X[cols].to_numpy()[perm]
            drops.append(auc0 - roc_auc_score(y, clf.predict_proba(X)[:, 1]))
        imp[label] = float(np.mean(drops))
    out = {
        "n_train": int(len(tr)), "n_test": int(len(te)), "pos_rate_test": float(y.mean()), "pos_rate_train": float(tr.y.mean()),
        "auc_model": float(auc0), "auc_base": float(roc_auc_score(y, base)),
        "ap_model": float(average_precision_score(y, p)), "ap_base": float(average_precision_score(y, base)),
        "pr_model": pr(p), "pr_base": pr(base), "workload": workload, "importance": imp,
        "n_all": int(len(df)), "n_reviewed": int(df.reviewed.sum()), "n_yes": int((df.found == "yes").sum()),
    }
    print(f"  triage: AUC {auc0:.3f} vs AI confidence {out['auc_base']:.3f}; AP {out['ap_model']:.3f} vs {out['ap_base']:.3f}; "
          f"at 95% recall review {workload['95']['model_share']:.0%} vs {workload['95']['base_share']:.0%}")
    return out


# ============================================================================= hearing outlook

def outlook(rep: pd.DataFrame, nodes_all: list[str]) -> dict:
    """rep: Orcasound listener reports (timestamp, node, category). A 'hit' is a whale report."""
    oh = rep.dropna(subset=["node"])
    yes = oh[oh.category == "whale"].copy()
    yes["week"] = yes.timestamp.dt.tz_convert(TZ).dt.tz_localize(None).dt.to_period("W-SUN").dt.start_time
    nodes = [n for n in nodes_all if n in set(oh.node)]
    # weeks each node was active (any report that week ≈ hydrophone streaming and someone listening)
    allw = oh.assign(week=oh.timestamp.dt.tz_convert(TZ).dt.tz_localize(None).dt.to_period("W-SUN").dt.start_time)
    weeks = pd.date_range(allw.week.min(), allw.week.max(), freq="7D")
    active = allw.groupby(["node", "week"]).size()
    hits = yes.groupby(["node", "week"]).size()
    rows = []
    for n in nodes:
        h = hits.reindex(pd.MultiIndex.from_product([[n], weeks])).fillna(0).to_numpy()
        a = active.reindex(pd.MultiIndex.from_product([[n], weeks])).fillna(0).to_numpy()
        for i, w in enumerate(weeks):
            if i < 4:
                continue
            rows.append({"node": n, "week": w, "y": int(h[i] > 0), "active": a[i] > 0, "prev1": int(h[i - 1] > 0),
                         "prev4": float((h[i - 4:i] > 0).mean()), "woy_sin": np.sin(2 * np.pi * w.dayofyear / 365.25),
                         "woy_cos": np.cos(2 * np.pi * w.dayofyear / 365.25)})
    d = pd.DataFrame(rows)
    d = d[d.active]
    X_cols = ["prev1", "prev4", "woy_sin", "woy_cos"] + [f"n_{n}" for n in nodes]
    for n in nodes:
        d[f"n_{n}"] = (d.node == n).astype(int)
    tr, te = d[d.week < SPLIT.tz_convert(None)], d[d.week >= SPLIT.tz_convert(None)]
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(tr[X_cols], tr.y)
    pt = lr.predict_proba(te[X_cols])[:, 1]
    clim = tr.groupby(["node", tr.week.dt.month]).y.mean()
    pc = clim.reindex(pd.MultiIndex.from_arrays([te.node, te.week.dt.month])).fillna(tr.y.mean()).to_numpy()
    brier, brier_c = float(np.mean((pt - te.y) ** 2)), float(np.mean((pc - te.y) ** 2))
    # tougher baseline: the share of the last four weeks with reports at that hydrophone
    brier_r = float(np.mean((te.prev4.to_numpy() - te.y) ** 2))
    lr_all = LogisticRegression(max_iter=2000, C=1.0).fit(d[X_cols], d.y)
    # next week per node
    last_week = weeks.max()
    nxt = last_week + pd.Timedelta(days=7)
    fc = {}
    for n in nodes:
        h = hits.reindex(pd.MultiIndex.from_product([[n], weeks])).fillna(0).to_numpy()
        row = {"prev1": int(h[-1] > 0), "prev4": float((h[-4:] > 0).mean()), "woy_sin": np.sin(2 * np.pi * nxt.dayofyear / 365.25),
               "woy_cos": np.cos(2 * np.pi * nxt.dayofyear / 365.25), **{f"n_{m}": int(m == n) for m in nodes}}
        fc[n] = {"p": float(lr_all.predict_proba(pd.DataFrame([row])[X_cols])[0, 1]), "heard_last_week": bool(h[-1] > 0),
                 "weeks_heard_last4": int((h[-4:] > 0).sum())}
    print(f"  outlook: Brier {brier:.3f} vs climatology {brier_c:.3f} ({(1 - brier / brier_c):.0%} skill), "
          f"vs recent frequency {brier_r:.3f} ({(1 - brier / brier_r):.0%} skill)")
    # seasonality: whale reports by node × month and hour
    yl = yes.timestamp.dt.tz_convert(TZ)
    by_month = yes.assign(m=yl.dt.month).groupby(["node", "m"]).size().unstack(fill_value=0)
    by_hour = yes.assign(h=yl.dt.hour).groupby("h").size().reindex(range(24), fill_value=0)
    weekly = yes.groupby("week").size().reindex(weeks, fill_value=0)
    return {"next_week": nxt.date().isoformat(), "last_week": last_week.date().isoformat(), "forecast": fc, "brier": brier, "brier_clim": brier_c,
            "skill": 1 - brier / brier_c, "brier_recent": brier_r, "skill_recent": 1 - brier / brier_r, "n_weeks_test": int(len(te)),
            "by_month": {n: by_month.loc[n].reindex(range(1, 13), fill_value=0).tolist() for n in by_month.index},
            "by_hour": by_hour.tolist(), "weekly": [[w.date().isoformat(), int(v)] for w, v in weekly.items()]}


# ============================================================================= hydrophones

def hydrophones() -> dict:
    """Orcasound nodes: the live feed list where available (visible feeds inside the study area), else config."""
    f = RAW / "orcasound_feeds.json"
    out = {}
    if f.exists():
        for x in json.loads(f.read_text(encoding="utf-8")):
            if x.get("visible") and x.get("lat") is not None and in_bbox([x["lat"]], [x["lon"]])[0]:
                out[x["node"]] = {"name": x["name"], "lon": round(x["lon"], 5), "lat": round(x["lat"], 5)}
    if not out:
        out = {k: {"name": v[0], "lon": v[1], "lat": v[2]} for k, v in HYDROPHONES.items()}
    return out


# ============================================================================= sightings

SPECIES = ["Southern Resident orca", "Orca (other or unspecified ecotype)", "Humpback", "Grey whale", "Minke whale", "Porpoise or dolphin",
           "Other or unidentified"]


def species_group(name) -> int:
    s = str(name or "").lower()
    if "southern resident" in s or s in ("srkw",):
        return 0
    if "orca" in s or "killer" in s or "bigg" in s or "transient" in s:
        return 1
    if "humpback" in s:
        return 2
    if "gray" in s or "grey" in s:
        return 3
    if "minke" in s:
        return 4
    if "porpoise" in s or "dolphin" in s:
        return 5
    return 6


def sightings(gen: pd.Timestamp) -> tuple[pd.DataFrame, dict]:
    """Whale sightings archive: Acartia (merged across runs, since its public feed is a rolling week) + iNaturalist
    (last ~4 months, research grade and needs-ID). Returns rows with UTC time, position, species group, source."""
    frames = []
    for name in ("acartia_seed", "acartia_archive", "acartia"):
        f = RAW / f"{name}.parquet"
        if f.exists():
            frames.append(pd.read_parquet(f))
    prev = read_json("sightings.json") or {}
    if prev.get("rows"):
        p = pd.DataFrame(prev["rows"], columns=prev["cols"])
        p = p[p.src == 0]
        frames.append(pd.DataFrame({"created": p.t, "lon": p.lon, "lat": p.lat, "type": [prev["species"][i] for i in p.sp],
                                    "count": p.n, "entity": p.ref, "_sp": p.sp}))
    legacy = read_json("salish.json") or {}
    if legacy.get("sightings"):
        frames.append(pd.DataFrame(legacy["sightings"]))
    rows = []
    if frames:
        a = pd.concat(frames, ignore_index=True)
        a["t"] = pd.to_datetime(a.created.astype(str), errors="coerce", utc=True, format="mixed")
        for c in ("lat", "lon", "count"):
            a[c] = pd.to_numeric(a[c], errors="coerce")
        a = a.dropna(subset=["t", "lat", "lon"])
        a = a[in_bbox(a.lat, a.lon)]
        sp = a["_sp"] if "_sp" in a else pd.Series(np.nan, index=a.index)
        a["sp"] = [int(s) if pd.notna(s) else species_group(t) for s, t in zip(sp, a.type)]
        a["key"] = a.t.dt.strftime("%Y-%m-%dT%H:%M") + a.lat.round(3).astype(str) + a.lon.round(3).astype(str)
        a = a.drop_duplicates("key", keep="last")
        rows.append(pd.DataFrame({"t": a.t, "lon": a.lon, "lat": a.lat, "sp": a.sp, "n": a["count"].fillna(1).clip(1, 200).astype(int),
                                  "src": 0, "ref": a.get("entity", pd.Series("", index=a.index)).fillna("").astype(str), "timed": True}))
    f = RAW / "inat_recent.parquet"
    if f.exists():
        i = pd.read_parquet(f)
        i = i[in_bbox(i.lat, i.lon)]
        t = pd.to_datetime(i.time, errors="coerce", utc=True, format="mixed")
        timed = t.notna()
        t = t.fillna(pd.to_datetime(i.date, errors="coerce").dt.tz_localize(TZ, nonexistent="shift_forward", ambiguous="NaT")
                     .add(pd.Timedelta(hours=12)).dt.tz_convert("UTC"))
        rows.append(pd.DataFrame({"t": t, "lon": i.lon, "lat": i.lat, "sp": i.species.map(species_group), "n": 1, "src": 1,
                                  "ref": i.id.astype(str) + ("|" + i.grade.fillna("")), "timed": timed}))
    elif prev.get("rows"):                                     # carry iNaturalist rows over if this run couldn't fetch them
        p = pd.DataFrame(prev["rows"], columns=prev["cols"])
        p = p[p.src == 1]
        rows.append(pd.DataFrame({"t": pd.to_datetime(p.t, utc=True, format="mixed"), "lon": p.lon, "lat": p.lat, "sp": p.sp,
                                  "n": p.n, "src": 1, "ref": p.ref, "timed": p.t.str.len() > 10}))
    if not rows:
        return pd.DataFrame(columns=["t", "lon", "lat", "sp", "n", "src", "ref", "timed"]), {}
    s = pd.concat(rows, ignore_index=True).dropna(subset=["t"])
    s = s[(s.t >= gen - pd.Timedelta(days=365)) & (s.t <= gen + pd.Timedelta(hours=2))].sort_values("t")
    out = {"generated": gen, "species": SPECIES, "sources": ["Acartia", "iNaturalist"],
           "cols": ["t", "lon", "lat", "sp", "n", "src", "ref"],
           "first": {k: s[s.src == i].t.min() for i, k in enumerate(["acartia", "inat"]) if (s.src == i).any()},
           "rows": [[(r.t.strftime("%Y-%m-%dT%H:%MZ") if r.timed else r.t.tz_convert(TZ).strftime("%Y-%m-%d")), round(r.lon, 4), round(r.lat, 4),
                     int(r.sp), int(r.n), int(r.src), r.ref] for r in s.itertuples()]}
    print(f"  sightings: {len(s):,} rows ({int((s.src == 0).sum()):,} Acartia since {out['first'].get('acartia')}, "
          f"{int((s.src == 1).sum()):,} iNaturalist)")
    return s, out


# ============================================================================= ships

def rdp(xy: np.ndarray, eps: float) -> np.ndarray:
    """Ramer–Douglas–Peucker simplification (iterative), returns kept indices."""
    n = len(xy)
    if n < 3:
        return np.arange(n)
    keep = np.zeros(n, bool)
    keep[[0, n - 1]] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = xy[i], xy[j]
        seg = xy[i + 1:j]
        ab = b - a
        L = np.hypot(*ab)
        rel = seg - a
        d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / L if L > 0 else np.hypot(rel[:, 0], rel[:, 1])
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack += [(i, m), (m, j)]
    return np.nonzero(keep)[0]


def ship_day(ais: pd.DataFrame) -> dict:
    """One day of AIS → compact tracks: integer lon/lat ×1e4, delta-encoded, Douglas–Peucker simplified (~40 m)."""
    ais = ais.copy()
    ais["t"] = pd.to_datetime(ais.BaseDateTime)
    ais["cat"] = ais.VesselType.map(vessel_category)
    vessels, tracks, by_cat = [], [], {}
    for _, g in ais.sort_values("t").groupby("MMSI"):
        moving = g[g.SOG > 0.8]
        if len(moving) < 5:
            continue
        cat = g.cat.mode().iloc[0]
        name = str(g.VesselName.dropna().iloc[0]).strip().title() if g.VesselName.notna().any() else ""
        vlen = float(g.Length.max()) if g.Length.notna().any() else None
        vi = len(vessels)
        # break tracks at gaps > 30 min or jumps > 5 km (bad fixes), thin to ≥ 1-minute spacing, then simplify
        dlat = moving.LAT.diff() * 111.0
        dlon = moving.LON.diff() * 111.0 * np.cos(np.radians(moving.LAT))
        jump = np.hypot(dlat, dlon) > 5
        seg_id = ((moving.t.diff().dt.total_seconds() > 1800) | jump).cumsum()
        n_seg = 0
        for _, sg in moving.groupby(seg_id):
            sg = sg[sg.t.diff().dt.total_seconds().fillna(999) >= 60]
            if len(sg) < 3:
                continue
            xy = np.column_stack([sg.LON.to_numpy() * np.cos(np.radians(48.5)), sg.LAT.to_numpy()])
            idx = rdp(xy, 0.00035)
            q = np.column_stack([np.round(sg.LON.to_numpy()[idx] * 1e4), np.round(sg.LAT.to_numpy()[idx] * 1e4)]).astype(int)
            q = q[np.r_[True, np.any(np.diff(q, axis=0) != 0, axis=1)]]
            if len(q) < 2:
                continue
            flat = np.vstack([q[:1], np.diff(q, axis=0)]).ravel().tolist()
            tracks.append([SHIP_CATS.index(cat), vi, flat])
            n_seg += 1
        if n_seg:
            vessels.append([name, round(vlen) if vlen else None])
            by_cat[cat] = by_cat.get(cat, 0) + 1
    return {"cats": SHIP_CATS, "vessels": vessels, "tracks": tracks, "by_cat": by_cat}


def ais_coverage(ais: pd.DataFrame) -> dict:
    out = {}
    for name, (s, w, n, e) in AIS_REGIONS:
        m = ais.LAT.between(s, n) & ais.LON.between(w, e)
        out[name] = {"positions": int(m.sum()), "vessels": int(ais.loc[m, "MMSI"].nunique())}
    return out


def ships() -> dict | None:
    """Per-day ship files for the latest AIS_DAYS days (raw parquet → ships/<day>.json), plus an index."""
    prev = read_json("ships/index.json") or {}
    days = {d["date"]: d for d in prev.get("days", []) if (OUT / "ships" / f"{d['date']}.json").exists()}
    for f in sorted((RAW / "ais").glob("*.parquet")) if (RAW / "ais").exists() else []:
        day = f.stem
        ais = pd.read_parquet(f)
        sd = ship_day(ais)
        dump(f"ships/{day}.json", {"date": day, **sd}, quiet=True)
        size = (OUT / "ships" / f"{day}.json").stat().st_size
        days[day] = {"date": day, "vessels": len(sd["vessels"]), "tracks": len(sd["tracks"]), "by_cat": sd["by_cat"],
                     "kb": round(size / 1024), "coverage": ais_coverage(ais)}
        print(f"  ships {day}: {len(sd['vessels']):,} vessels, {len(sd['tracks']):,} tracks, {size / 1024:,.0f} KB")
    if not days:
        return None
    keep = sorted(days)[-AIS_DAYS:]
    for f in (OUT / "ships").glob("*.json"):
        if f.stem != "index" and f.stem not in keep:
            f.unlink()
    legacy = OUT / "ships_day.json"                            # superseded by ships/<day>.json
    if legacy.exists():
        legacy.unlink()
    idx = {"source": "NOAA / BOEM Marine Cadastre (US Coast Guard terrestrial AIS)", "cats": SHIP_CATS, "days": [days[d] for d in keep]}
    regions = {}
    for d in idx["days"]:
        for r, v in (d.get("coverage") or {}).items():
            regions.setdefault(r, []).append(v["vessels"])
    idx["coverage"] = [{"region": r, "vessels_per_day": float(np.mean(regions.get(r, [0])))} for r, _ in AIS_REGIONS]
    dump("ships/index.json", idx)
    return idx


# ============================================================================= whale-sound tier list

TIERS = [("S", 85), ("A", 70), ("B", 55), ("C", 40), ("D", 0)]
SRKW_TAGS = {"srkw", "resident", "southern resident", "j pod", "k pod", "l pod", "jpod", "kpod", "lpod", "j", "k", "l"}
BIGGS_TAGS = {"transient", "biggs", "bigg's", "bigg", "t"}


def _tags(s) -> set[str]:
    return {t.strip().lower() for t in str(s or "").split(";") if t.strip()}


def _species_from_oh(r) -> tuple[float, str, str]:
    """(points out of 20, label, why) from moderator tags first, then the AI's own label."""
    tags = _tags(r.tags)
    if tags & SRKW_TAGS or any(t.startswith("s") and t[1:].isdigit() for t in tags):     # S01, S04… are SRKW call types
        return 20, "Southern Resident orca", "moderator tag"
    if tags & BIGGS_TAGS:
        return 14, "Bigg's orca", "moderator tag"
    if tags & {"orca", "killer whale", "kw"}:
        return 14, "Orca", "moderator tag"
    if "humpback" in tags:
        return 9, "Humpback", "moderator tag"
    lab = str(r.ai_label or "").lower()
    yes = r.reviewed and r.found == "yes"
    if lab == "resident":
        return (17, "Southern Resident orca?", "confirmed orca, AI says resident") if yes else (15, "Southern Resident orca?", "AI label, unconfirmed")
    if lab == "transient":
        return (14, "Bigg's orca?", "confirmed orca, AI says Bigg's") if yes else (11, "Bigg's orca?", "AI label, unconfirmed")
    if lab == "humpback":
        return 7, "Humpback?", "AI label, unconfirmed"
    if yes:
        return 14, "Orca", "moderator confirmed an orca call"
    return 4, "Unknown", "no species information"


def _sighting_species(sp: int) -> tuple[float, str]:
    return {0: (16, "Southern Resident orca?"), 1: (12, "Orca?"), 2: (8, "Humpback?")}.get(sp, (5, "Whale?"))


def tier_list(oh: pd.DataFrame | None, rep: pd.DataFrame, sights: pd.DataFrame, hydro: dict, gen: pd.Timestamp, days: int = 30) -> dict:
    t0 = gen - pd.Timedelta(days=days)
    pos = {k: (v["lat"], v["lon"]) for k, v in hydro.items()}
    names = {k: v["name"] for k, v in hydro.items()}
    oh = oh[(oh.timestamp >= t0 - pd.Timedelta(hours=2))].copy() if oh is not None and len(oh) else pd.DataFrame()
    lis = rep[(rep.source == "human") & (rep.category == "whale") & rep.node.notna() & (rep.timestamp >= t0 - pd.Timedelta(hours=2))].copy()
    timed = sights[sights.timed & (sights.t >= t0 - pd.Timedelta(hours=2))] if len(sights) else sights
    ts = lambda s: s.dt.tz_convert("UTC").dt.as_unit("s").astype("int64").to_numpy() if len(s) else np.array([], dtype=np.int64)
    oh_t = ts(oh.timestamp) if len(oh) else np.array([])
    lis_t = ts(lis.timestamp)
    sg_t = ts(timed.t) if len(timed) else np.array([])

    def near_sighting(node, t):
        if node not in pos or not len(sg_t):
            return None
        m = np.abs(sg_t - t) <= 3600
        if not m.any():
            return None
        sub = timed[m]
        d = km_between(pos[node][0], pos[node][1], sub.lat.to_numpy(), sub.lon.to_numpy())
        if (d <= 25).any():
            return sub[d <= 25].sort_values("sp").iloc[0]
        return None

    def corroboration(node, t, kind):
        pts, why = 0.0, []
        if kind == "ai":
            k = int(((lis.node == node).to_numpy() & (np.abs(lis_t - t) <= 3600)).sum()) if len(lis) else 0
            if k:
                pts += 4; why.append(f"{k} listener report{'s' if k > 1 else ''} here within ±1 h")
            same = int(((oh.node == node).to_numpy() & (np.abs(oh_t - t) <= 3600)).sum()) - 1
            if same >= 2:
                pts += 2; why.append(f"{same} more AI flags here within ±1 h")
        else:
            k = int(((oh.node == node).to_numpy() & (np.abs(oh_t - t) <= 3600)).sum()) if len(oh) else 0
            if k:
                pts += 4; why.append(f"{k} AI flag{'s' if k > 1 else ''} here within ±1 h")
        other = 0
        if len(oh):
            other += int(((oh.node != node).to_numpy() & (np.abs(oh_t - t) <= 3600)).sum())
        if len(lis):
            other += int(((lis.node != node).to_numpy() & (np.abs(lis_t - t) <= 3600)).sum())
        if other:
            pts += 3; why.append("another hydrophone active within ±1 h")
        s = near_sighting(node, t)
        if s is not None:
            pts += 4; why.append(f"{SPECIES[int(s.sp)].lower()} sighted ≤ 25 km within ±1 h")
        return min(10.0, pts), "; ".join(why) or "nothing else within ±1 h", s

    def recency(t):
        age = max(0.0, (gen.timestamp() - t) / 86400)
        return 5 * np.exp(-age / 7), f"{age:.1f} days ago" if age >= 1 else f"{age * 24:.0f} h ago"

    items = []
    rejected = 0
    # ---- OrcaHello clips, grouped into encounters (same hydrophone, gaps ≤ 30 min); each encounter's best clip is listed
    if len(oh):
        rejected = int((oh.reviewed & (oh.found == "no") & (oh.timestamp >= t0)).sum())
        cand = oh[~(oh.reviewed & (oh.found == "no")) & (oh.timestamp >= t0)].sort_values(["node", "timestamp"])
        cand["enc"] = (cand.node.ne(cand.node.shift()) | (cand.timestamp.diff().dt.total_seconds() > 1800)).cumsum()
        for _, enc in cand.groupby("enc"):
            best = None
            for r in enc.itertuples():
                t = int(r.timestamp.timestamp())
                if r.reviewed and r.found == "yes":
                    ver = (30, "Moderator confirmed", "a volunteer moderator confirmed whale calls")
                elif r.reviewed:
                    ver = (12, "Moderator unsure", "reviewed, marked don't know")
                else:
                    ver = (5, "Not yet reviewed", "AI only so far")
                conf = float(r.confidence or 0)
                ai = (conf / 100 * 20, f"AI confidence {conf:.0f}%")
                sp_pts, sp_lab, sp_why = _species_from_oh(r)
                nseg, amax = int(r.n_ann or 0), float(r.ann_max or 0)
                cl = (min(nseg, 6) / 6 * 8 + amax * 7, f"{nseg} positive segment{'s' if nseg != 1 else ''}, strongest {amax:.2f}")
                co, co_why, s = corroboration(r.node, t, "ai")
                if sp_pts <= 5 and s is not None:
                    sp_pts, sp_lab = _sighting_species(int(s.sp)); sp_why = "from a sighting ≤ 25 km within ±1 h"
                rc, rc_why = recency(t)
                parts = [["Verification", ver[0], 30, ver[2]], ["AI confidence", ai[0], 20, ai[1]], ["Species", sp_pts, 20, f"{sp_lab} ({sp_why})"],
                         ["Clarity", cl[0], 15, cl[1]], ["Corroboration", co, 10, co_why], ["Recency", rc, 5, rc_why]]
                score = sum(p[1] for p in parts)
                if best is None or score > best["score"]:
                    best = {"kind": "ai", "time": r.timestamp, "node": r.node, "name": names.get(r.node, r.node_name), "species": sp_lab,
                            "verdict": ver[1], "score": score, "parts": parts, "audio": r.audio, "spectrogram": r.spectrogram,
                            "n_in_encounter": len(enc)}
            items.append(best)
    # ---- listener events: human whale reports at one hydrophone with gaps ≤ 20 min
    if len(lis):
        lw = lis[lis.timestamp >= t0].sort_values(["node", "timestamp"]).copy()
        lw["ev"] = (lw.node.ne(lw.node.shift()) | (lw.timestamp.diff().dt.total_seconds() > 1200)).cumsum()
        for _, ev in lw.groupby("ev"):
            first = ev.iloc[0]
            node, t = first.node, int(first.timestamp.timestamp())
            nrep = len(ev)
            m = None
            if len(oh):
                mm = (oh.node == node).to_numpy() & (np.abs(oh_t - t) <= 600)
                if mm.any():
                    m = oh[mm].sort_values("confidence").iloc[-1]
            ai = (float(m.confidence) / 100 * 20, f"OrcaHello flagged the same minutes at {m.confidence:.0f}%") if m is not None else (0, "no AI flag within ±10 min")
            if m is not None:
                sp_pts, sp_lab, sp_why = _species_from_oh(m)
                sp_why = f"from the matching AI flag: {sp_why}"
            else:
                sp_pts, sp_lab, sp_why = 4, "Unknown", "listeners report 'whale' without species"
            co, co_why, s = corroboration(node, t, "listener")
            if sp_pts <= 5 and s is not None:
                sp_pts, sp_lab = _sighting_species(int(s.sp)); sp_why = "from a sighting ≤ 25 km within ±1 h"
            rc, rc_why = recency(t)
            parts = [["Verification", 10, 30, "listeners pressed 'whale' in the Orcasound app (not moderated)"], ["AI confidence", ai[0], 20, ai[1]],
                     ["Species", sp_pts, 20, f"{sp_lab} ({sp_why})"],
                     ["Clarity", min(nrep, 6) / 6 * 15, 15, f"{nrep} listener report{'s' if nrep != 1 else ''} in this event (more reports, more audible)"],
                     ["Corroboration", co, 10, co_why], ["Recency", rc, 5, rc_why]]
            pl, off = first.get("playlist"), first.get("offset")
            items.append({"kind": "listener", "time": first.timestamp, "node": node, "name": names.get(node, node), "species": sp_lab,
                          "verdict": "Listener reports", "score": sum(p[1] for p in parts), "parts": parts, "n_reports": nrep,
                          "hls": {"node": node, "playlist": int(pl), "offset": float(off)} if pd.notna(pl) and pd.notna(off) else None,
                          "spectrogram": m.spectrogram if m is not None else None})
    for it in items:
        it["score"] = round(float(it["score"]), 1)
        it["parts"] = [[a, round(float(b), 1), c, d] for a, b, c, d in it["parts"]]
        it["tier"] = next(t for t, th in TIERS if it["score"] >= th)
    items.sort(key=lambda x: -x["score"])
    counts = {t: sum(1 for x in items if x["tier"] == t) for t, _ in TIERS}
    shown = {t: [x for x in items if x["tier"] == t][:6] for t, _ in TIERS}
    print(f"  tier list: {len(items)} items in {days} days · {counts} · {rejected} rejected clips not listed")
    return {"window_days": days, "thresholds": dict(TIERS), "counts": counts, "items": shown, "rejected": rejected,
            "n_ai": sum(1 for x in items if x["kind"] == "ai"), "n_listener": sum(1 for x in items if x["kind"] == "listener")}


# ============================================================================= main

def freshness(gen, status, rep, oh, sights, ship_idx, live) -> list[dict]:
    """Per-source: when the pipeline last tried, whether it worked, and the newest record actually in the data."""
    hum = rep[(rep.source == "human") & (rep.category == "whale")] if len(rep) else rep
    newest = {
        "orcasound": hum.timestamp.max() if len(hum) else None,
        "acartia": sights[sights.src == 0].t.max() if len(sights) and (sights.src == 0).any() else None,
        "inat_recent": sights[sights.src == 1].t.max() if len(sights) and (sights.src == 1).any() else None,
        "orcahello_recent": oh.timestamp.max() if oh is not None and len(oh) else None,
        "ais": ship_idx["days"][-1]["date"] if ship_idx else None,
        "live": live["fetched"].iloc[0] if live is not None and len(live) else None,
    }
    labels = {"orcasound": "Orcasound listener reports", "acartia": "Acartia whale sightings", "inat_recent": "iNaturalist whale photos",
              "orcahello_recent": "OrcaHello AI detections", "ais": "Ship tracks (NOAA AIS archive)", "live": "Live ships (aisstream.io)"}
    out = []
    for k, label in labels.items():
        st = status.get(k) or (status.get("orcahello") if k == "orcahello_recent" else None) or {}
        out.append({"id": k, "label": label, "newest": newest[k], "ok": st.get("ok"), "attempted": st.get("attempted"),
                    "last_ok": st.get("last_ok"), "error": st.get("error"), "skipped": st.get("skipped")})
    return out


def main():
    import sys
    for stream in (sys.stdout, sys.stderr):                 # Windows consoles: never die on a non-ASCII log line
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    gen_ts = pd.Timestamp.now(tz="UTC").floor("min")
    gen = gen_ts.isoformat()
    status = json.loads((RAW / "status.json").read_text(encoding="utf-8")) if (RAW / "status.json").exists() else {}
    prev = read_json("salish.json") or {}
    hydro = hydrophones()
    rep = pd.read_parquet(RAW / "orcasound_reports.parquet")
    for c in ("playlist", "offset"):
        if c not in rep:
            rep[c] = np.nan
    out = outlook(rep, list(hydro))
    whale = rep[(rep.category == "whale") & rep.node.notna()]
    human = whale[whale.source == "human"]
    counts30 = human[human.timestamp >= gen_ts - pd.Timedelta(days=30)].groupby("node").size().to_dict()
    # listener whale reports per hydrophone per local day, last year (map date range)
    hy = human[human.timestamp >= gen_ts - pd.Timedelta(days=365)]
    daily = hy.assign(d=hy.timestamp.dt.tz_convert(TZ).dt.strftime("%Y-%m-%d")).groupby(["node", "d"]).size()
    listener_daily = {n: {d: int(v) for (_, d), v in g.items()} for n, g in daily.groupby(level=0)}

    tri, recent_yes, oh_all = None, [], None
    if (RAW / "orcahello.parquet").exists():
        oh = pd.read_parquet(RAW / "orcahello.parquet")
        oh = oh[oh.node.notna()]
        lab = oh[oh.reviewed & oh.found.isin(["yes", "no"])]
        if (lab.timestamp >= SPLIT).sum() > 200 and (lab.timestamp < SPLIT).sum() > 500:
            tri = triage(oh)
        else:
            print(f"  triage: not enough OrcaHello history yet ({len(lab):,} reviewed); section will be marked pending")
        oh_all = oh
    if (RAW / "orcahello_recent.parquet").exists():
        r = pd.read_parquet(RAW / "orcahello_recent.parquet")
        oh_all = r if oh_all is None else pd.concat([oh_all[~oh_all.id.isin(r.id)], r], ignore_index=True)
    if oh_all is not None:
        for c in ("ai_label",):
            if c not in oh_all:
                oh_all[c] = None
        yes = oh_all[oh_all.reviewed & (oh_all.found == "yes")].sort_values("timestamp", ascending=False)
        recent_yes = [{"time": r.timestamp, "node": r.node, "name": r.node_name, "audio": r.audio, "spectrogram": r.spectrogram,
                       "confidence": r.confidence, "tags": r.tags} for r in yes.head(12).itertuples()]

    sights, sight_json = sightings(gen_ts)
    if sight_json:
        dump("sightings.json", sight_json)
    tiers = tier_list(oh_all, rep, sights, hydro, gen_ts)
    if not any(tiers["counts"].values()) and prev.get("tiers"):
        tiers = {**prev["tiers"], "carried_over": True}

    inat = pd.read_parquet(RAW / "inat_whales.parquet") if (RAW / "inat_whales.parquet").exists() else pd.DataFrame()
    inat_season = {}
    if len(inat):
        inat = inat[in_bbox(inat.lat, inat.lon)]
        inat["m"] = pd.to_datetime(inat.date, errors="coerce").dt.month
        grp = inat.species.map(species_group)
        inat_season = {label: inat[grp.isin(g)].groupby("m").size().reindex(range(1, 13), fill_value=0).tolist() for label, g in INAT_SEASON.items()}
    ship_idx = ships()
    live = pd.read_parquet(RAW / "ships_live.parquet") if (RAW / "ships_live.parquet").exists() else None
    if live is not None:
        live["cat"] = live.get("type", pd.Series(dtype=float)).map(vessel_category) if "type" in live else "Other"

    # in CI the heavy/rarely-changing inputs aren't downloaded: carry their results over from the last build
    if tri is None and prev.get("triage"):
        tri = prev["triage"]
    if not recent_yes and prev.get("recent_confirmed"):
        recent_yes = prev["recent_confirmed"]
    if not inat_season and prev.get("inat_season"):
        inat_season = prev["inat_season"]
    if ship_idx is None:
        ship_idx = read_json("ships/index.json")
    last7 = sights[sights.t >= gen_ts - pd.Timedelta(days=7)] if len(sights) else sights
    dump("salish.json", {
        "generated": gen,
        "bbox": BBOX,
        "freshness": freshness(gen, status, rep, oh_all, sights, ship_idx, live),
        "hydrophones": {k: {**v, "reports_30d": int(counts30.get(k, 0))} for k, v in hydro.items()},
        "other_hydrophones": OTHER_HYDROPHONES,
        "n_reports": int(len(whale)), "n_reports_human": int(len(human)), "reports_since": rep.timestamp.min(),
        "triage": tri, "outlook": out, "recent_confirmed": recent_yes, "tiers": tiers,
        "listener_daily": listener_daily,
        "sightings_7d": {"n": int(len(last7)), "by_species": {SPECIES[int(k)]: int(v) for k, v in last7.groupby("sp").n.sum().items()} if len(last7) else {}},
        "inat_season": inat_season, "inat_total": int(len(inat)) if len(inat) else prev.get("inat_total", 0),
        "ship_days": [d["date"] for d in ship_idx["days"]] if ship_idx else [],
        "live_ships": live[[c for c in ("lat", "lon", "sog", "cog", "name", "cat") if c in live]].round(5).to_dict("records") if live is not None else None,
        "live_fetched": live["fetched"].iloc[0] if live is not None and len(live) else None,
    })
    if len(inat):
        dump("whales_inat.json", inat.sort_values("date").tail(6000)[["species", "date", "lat", "lon"]].round(4).values.tolist())


if __name__ == "__main__":
    main()
