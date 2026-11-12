"""Municipal street-tree inventories (every species): City of Vancouver, City of Victoria, Township of Esquimalt,
City of Toronto. Returns lon, lat, botanical name, common name and street."""
from __future__ import annotations

import io

import pandas as pd
import requests

from .http import USER_AGENT, get_json

VAN = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/json"
VIC = "https://maps.victoria.ca/server/rest/services/OpenData/OpenData_Parks/MapServer/15/query"
ESQ = "https://gis.esquimalt.ca/arcgis/rest/services/Services/Trees/MapServer/0/query"
TOR_CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show"


def _arcgis(url, fields):
    rows, offset = [], 0
    while True:
        d = get_json(url, {"where": "1=1", "outFields": fields, "outSR": 4326, "f": "json", "resultOffset": offset,
                           "resultRecordCount": 2000, "orderByFields": "OBJECTID"})
        feats = d.get("features", [])
        rows += feats
        if not feats or not d.get("exceededTransferLimit"):
            return rows
        offset += len(feats)


def fetch(city: str) -> pd.DataFrame:
    if city == "vancouver":
        d = get_json(VAN, {"select": "genus_name,species_name,common_name,address,geo_point_2d"}, timeout=600)
        df = pd.DataFrame([{"lon": (r.get("geo_point_2d") or {}).get("lon"), "lat": (r.get("geo_point_2d") or {}).get("lat"),
                            "botanical": f"{(r.get('genus_name') or '').title()} {(r.get('species_name') or '').lower()}".strip(),
                            "common": (r.get("common_name") or "").title(),
                            "street": " ".join(p for p in (r.get("address") or "").split() if not p.replace("-", "").isdigit()).title()} for r in d])
    elif city == "victoria":
        d = _arcgis(VIC, "BotanicalName,CommonName,OnStreet")
        df = pd.DataFrame([{"lon": (f.get("geometry") or {}).get("x"), "lat": (f.get("geometry") or {}).get("y"),
                            "botanical": f["attributes"].get("BotanicalName") or "", "common": f["attributes"].get("CommonName") or "",
                            "street": (f["attributes"].get("OnStreet") or "").title()} for f in d])
    elif city == "esquimalt":
        d = _arcgis(ESQ, "SPP_bot,SPP_com,onstr")
        df = pd.DataFrame([{"lon": (f.get("geometry") or {}).get("x"), "lat": (f.get("geometry") or {}).get("y"),
                            "botanical": f["attributes"].get("SPP_bot") or "", "common": f["attributes"].get("SPP_com") or "",
                            "street": (f["attributes"].get("onstr") or "").title()} for f in d])
    elif city == "toronto":
        res = get_json(TOR_CKAN, {"id": "street-tree-data"})["result"]["resources"]
        rid = next(r["id"] for r in res if r.get("datastore_active"))
        s = requests.Session(); s.headers["User-Agent"] = USER_AGENT
        t = pd.read_csv(io.BytesIO(s.get(f"https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/{rid}", timeout=1800).content), low_memory=False)
        xy = t["geometry"].astype(str).str.extract(r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)")
        df = pd.DataFrame({"lon": xy[0].astype(float), "lat": xy[1].astype(float), "botanical": t["BOTANICAL_NAME"].astype(str),
                           "common": t["COMMON_NAME"].astype(str), "street": t["STREETNAME"].astype(str).str.title()})
    else:
        raise ValueError(city)
    df["city"] = city
    return df.dropna(subset=["lon", "lat"])
