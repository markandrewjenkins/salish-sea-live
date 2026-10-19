"""Salish Sea Live: orca-call triage model, weekly hearing outlook, whales and shipping layers.

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
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score

from .config import HYDROPHONES, OUT, RAW, vessel_category

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
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    return o


def dump(name, obj):
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", encoding="utf-8") as f:
        json.dump(clean(obj), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    print(f"  wrote {name} ({(OUT / name).stat().st_size / 1024:,.0f} KB)")


# ============================================================================= triage model

def context_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("timestamp").reset_index(drop=True)
    t = df.timestamp.astype("int64").to_numpy() // 10**9
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

def outlook(rep: pd.DataFrame) -> dict:
    """rep: Orcasound listener reports (timestamp, node, category). A 'hit' is a whale report."""
    oh = rep.dropna(subset=["node"])
    yes = oh[oh.category == "whale"].copy()
    yes["week"] = yes.timestamp.dt.tz_convert(TZ).dt.to_period("W-SUN").dt.start_time
    nodes = [n for n in HYDROPHONES if n in set(oh.node)]
    # weeks each node was active (any AI detection that week ≈ hydrophone streaming)
    allw = oh.assign(week=oh.timestamp.dt.tz_convert(TZ).dt.to_period("W-SUN").dt.start_time)
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
    # seasonality: confirmed detections by node × month and hour
    yl = yes.timestamp.dt.tz_convert(TZ)
    by_month = yes.assign(m=yl.dt.month).groupby(["node", "m"]).size().unstack(fill_value=0)
    by_hour = yes.assign(h=yl.dt.hour).groupby("h").size().reindex(range(24), fill_value=0)
    weekly = yes.groupby("week").size().reindex(weeks, fill_value=0)
    return {"next_week": nxt.date().isoformat(), "forecast": fc, "brier": brier, "brier_clim": brier_c,
            "skill": 1 - brier / brier_c, "brier_recent": brier_r, "skill_recent": 1 - brier / brier_r, "n_weeks_test": int(len(te)),
            "by_month": {n: by_month.loc[n].reindex(range(1, 13), fill_value=0).tolist() for n in by_month.index},
            "by_hour": by_hour.tolist(), "weekly": [[w.date().isoformat(), int(v)] for w, v in weekly.items()]}


# ============================================================================= ships

def ship_tracks(ais: pd.DataFrame) -> dict:
    ais = ais.copy()
    ais["t"] = pd.to_datetime(ais.BaseDateTime)
    ais["cat"] = ais.VesselType.map(vessel_category)
    feats, stats = [], {}
    for mmsi, g in ais.sort_values("t").groupby("MMSI"):
        g = g[["LON", "LAT", "SOG", "t", "cat", "VesselName", "Length"]]
        moving = g[g.SOG > 0.8]
        if len(moving) < 5:
            continue
        cat = g.cat.mode().iloc[0]
        stats[cat] = stats.get(cat, 0) + 1
        # break tracks at gaps > 30 min or jumps > 5 km (bad fixes), thin to ≥ 2-minute spacing
        dlat = moving.LAT.diff() * 111.0
        dlon = moving.LON.diff() * 111.0 * np.cos(np.radians(moving.LAT))
        jump = np.hypot(dlat, dlon) > 5
        seg_id = ((moving.t.diff().dt.total_seconds() > 1800) | jump).cumsum()
        for _, sg in moving.groupby(seg_id):
            sg = sg[sg.t.diff().dt.total_seconds().fillna(999) >= 120]
            if len(sg) < 3:
                continue
            feats.append({"type": "Feature", "properties": {"cat": cat, "name": str(g.VesselName.dropna().iloc[0]).title() if g.VesselName.notna().any() else "",
                                                             "len": float(g.Length.max()) if g.Length.notna().any() else None},
                          "geometry": {"type": "LineString", "coordinates": [[round(x, 4), round(y, 4)] for x, y in zip(sg.LON, sg.LAT)]}})
    return {"type": "FeatureCollection", "features": feats, "stats": stats}


# ============================================================================= main

def main():
    gen = datetime.now(timezone.utc).isoformat(timespec="minutes")
    rep = pd.read_parquet(RAW / "orcasound_reports.parquet")
    out = outlook(rep)
    whale = rep[(rep.category == "whale") & rep.node.notna()]
    counts30 = whale[whale.timestamp >= whale.timestamp.max() - pd.Timedelta(days=30)].groupby("node").size().to_dict()
    tri, recent_yes = None, []
    if (RAW / "orcahello.parquet").exists():
        oh = pd.read_parquet(RAW / "orcahello.parquet")
        oh = oh[oh.node.notna()]
        lab = oh[oh.reviewed & oh.found.isin(["yes", "no"])]
        if (lab.timestamp >= SPLIT).sum() > 200 and (lab.timestamp < SPLIT).sum() > 500:
            tri = triage(oh)
        else:
            print(f"  triage: not enough OrcaHello history yet ({len(lab):,} reviewed); section will be marked pending")
        yes = oh[oh.found == "yes"].sort_values("timestamp", ascending=False)
        recent_yes = [{"time": r.timestamp, "node": r.node, "name": r.node_name, "audio": r.audio, "spectrogram": r.spectrogram,
                       "confidence": r.confidence, "tags": r.tags} for r in yes.head(12).itertuples()]

    acartia = pd.read_parquet(RAW / "acartia.parquet") if (RAW / "acartia.parquet").exists() else pd.DataFrame()
    inat = pd.read_parquet(RAW / "inat_whales.parquet") if (RAW / "inat_whales.parquet").exists() else pd.DataFrame()
    inat_season = {}
    if len(inat):
        inat["m"] = pd.to_datetime(inat.date, errors="coerce").dt.month
        inat_season = {sp: g.groupby("m").size().reindex(range(1, 13), fill_value=0).tolist() for sp, g in inat.groupby("species")}
    ships = ship_tracks(pd.read_parquet(RAW / "ais_day.parquet")) if (RAW / "ais_day.parquet").exists() else None
    live = pd.read_parquet(RAW / "ships_live.parquet") if (RAW / "ships_live.parquet").exists() else None

    # in CI the heavy/rarely-changing inputs aren't downloaded: carry their results over from the last build
    prev = json.loads((OUT / "salish.json").read_text(encoding="utf-8")) if (OUT / "salish.json").exists() else {}
    if tri is None and prev.get("triage"):
        tri = prev["triage"]
    if not recent_yes and prev.get("recent_confirmed"):
        recent_yes = prev["recent_confirmed"]
    if not inat_season and prev.get("inat_season"):
        inat_season = prev["inat_season"]
    dump("salish.json", {
        "generated": gen,
        "hydrophones": {k: {"name": v[0], "lon": v[1], "lat": v[2], "reports_30d": int(counts30.get(k, 0))} for k, v in HYDROPHONES.items()},
        "n_reports": int(len(whale)), "reports_since": rep.timestamp.min(),
        "triage": tri, "outlook": out, "recent_confirmed": recent_yes,
        "sightings": acartia.to_dict("records") if len(acartia) else [],
        "inat_season": inat_season, "inat_total": int(len(inat)) if len(inat) else prev.get("inat_total", 0),
        "ship_stats": ships["stats"] if ships else prev.get("ship_stats"),
        "live_ships": live.to_dict("records") if live is not None else None,
    })
    if ships:
        ships.pop("stats")
        dump("ships_day.json", ships)
    if len(inat):
        dump("whales_inat.json", inat.sort_values("date").tail(4000)[["species", "date", "lat", "lon"]].round(4).values.tolist())


if __name__ == "__main__":
    main()
