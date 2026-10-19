"""Environment and Climate Change Canada (MSC GeoMet OGC API) client."""
from __future__ import annotations

import pandas as pd

from .http import get_json

BASE = "https://api.weather.gc.ca/collections"


def climate_daily(climate_id: str, start: str | None = None, page: int = 10000) -> pd.DataFrame:
    """All daily climate records for one station, oldest first.

    Returns columns: date, tmax, tmin, tmean, precip.
    """
    rows, offset = [], 0
    params = {"f": "json", "CLIMATE_IDENTIFIER": climate_id, "limit": page,
              "sortby": "LOCAL_DATE",
              "properties": "LOCAL_DATE,MAX_TEMPERATURE,MIN_TEMPERATURE,MEAN_TEMPERATURE,TOTAL_PRECIPITATION"}
    if start:
        params["datetime"] = f"{start}/.."
    while True:
        d = get_json(f"{BASE}/climate-daily/items", {**params, "offset": offset}, min_interval=0.5)
        feats = d.get("features", [])
        rows += [f["properties"] for f in feats]
        if len(feats) < page:
            break
        offset += page
    if not rows:
        return pd.DataFrame(columns=["date", "tmax", "tmin", "tmean", "precip"])
    df = pd.DataFrame(rows).rename(columns={
        "LOCAL_DATE": "date", "MAX_TEMPERATURE": "tmax", "MIN_TEMPERATURE": "tmin",
        "MEAN_TEMPERATURE": "tmean", "TOTAL_PRECIPITATION": "precip"})
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df[["date", "tmax", "tmin", "tmean", "precip"]].sort_values("date").reset_index(drop=True)


def splice(series: list[pd.Series], min_overlap: int = 60) -> pd.Series:
    """Join station series into one: the first is the reference; each later station fills gaps
    and extends the record after a month-by-month bias adjustment over the overlap."""
    combined: pd.Series | None = None
    for t in series:
        t = t.dropna()
        t = t[~t.index.duplicated()]
        if t.empty:
            continue
        if combined is None:
            combined = t
            continue
        overlap = combined.index.intersection(t.index)
        diff = combined.loc[overlap] - t.loc[overlap]
        by_month = diff.groupby(diff.index.month).agg(["mean", "count"])
        overall = diff.mean() if len(diff) else 0.0
        adj = pd.Series([by_month["mean"].get(m, overall) if by_month["count"].get(m, 0) >= min_overlap else overall
                         for m in t.index.month], index=t.index)
        filler = (t + adj.fillna(0)).loc[~t.index.isin(combined.index)]
        combined = pd.concat([combined, filler]).sort_index()
    if combined is None:
        return pd.Series(dtype=float)
    return combined.reindex(pd.date_range(combined.index.min(), combined.index.max(), freq="D"))


def fill_series(series: list[pd.Series]) -> pd.Series:
    """Like splice but without bias adjustment (for precipitation, where a shift makes no sense)."""
    combined: pd.Series | None = None
    for t in series:
        t = t.dropna()
        t = t[~t.index.duplicated()]
        combined = t if combined is None else pd.concat([combined, t.loc[~t.index.isin(combined.index)]]).sort_index()
    if combined is None:
        return pd.Series(dtype=float)
    return combined.reindex(pd.date_range(combined.index.min(), combined.index.max(), freq="D"))
