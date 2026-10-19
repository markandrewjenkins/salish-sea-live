"""Salish Sea Live configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "salish" / "raw"
OUT = ROOT / "site" / "public" / "data" / "salish"

BBOX = (47.0, -125.6, 49.7, -122.0)       # south, west, north, east

ORCAHELLO = "https://aifororcasdetections.azurewebsites.net/api/detections"
ACARTIA = "https://acartia.io/api/v1/sightings/current"
ORCASOUND_S3 = "https://s3-us-west-2.amazonaws.com/audio-orcasound-net"

# Orcasound hydrophone nodes (bucket prefix, display name, lon, lat)
HYDROPHONES = {
    "rpi_orcasound_lab": ("Orcasound Lab", -123.1735, 48.5583),
    "rpi_north_sjc": ("North San Juan Channel", -123.0480, 48.5912),
    "rpi_andrews_bay": ("Andrews Bay", -123.1666, 48.5500),
    "rpi_sunset_bay": ("Sunset Bay", -122.3346, 47.8657),
    "rpi_bush_point": ("Bush Point", -122.6040, 48.0336),
    "rpi_port_townsend": ("Port Townsend", -122.7600, 48.1359),
    "rpi_mast_center": ("Mast Center", -122.3254, 47.3456),
}

# One representative summer weekday of US Coast Guard AIS (NOAA / BOEM Marine Cadastre, public domain)
AIS_DAY = "2024-07-17"
AIS_URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{y}/AIS_{d}.zip"

# AIS ship-type code → category
def vessel_category(code) -> str:
    try:
        c = int(code)
    except (TypeError, ValueError):
        return "Other"
    if 60 <= c <= 69:
        return "Passenger & ferry"
    if 70 <= c <= 79:
        return "Cargo"
    if 80 <= c <= 89:
        return "Tanker"
    if c in (31, 32, 52):
        return "Tug & tow"
    if c == 30:
        return "Fishing"
    if c in (36, 37):
        return "Pleasure & sail"
    return "Other"


INAT_TAXA = {"Orca": "Orcinus orca", "Humpback whale": "Megaptera novaeangliae", "Gray whale": "Eschrichtius robustus",
             "Minke whale": "Balaenoptera acutorostrata"}
