"""Salish Sea Live configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "salish" / "raw"
OUT = ROOT / "site" / "public" / "data" / "salish"

# Study area: all of Vancouver Island (west coast, Johnstone Strait, Queen Charlotte Strait's south end), the whole
# Strait of Georgia, Juan de Fuca and Puget Sound down to Olympia. The south edge stays at 47.0 N (not 47.9) so
# southern Puget Sound and the Mast Center hydrophone remain inside.
BBOX = (47.0, -128.6, 51.0, -122.0)       # south, west, north, east

ORCAHELLO = "https://aifororcasdetections.azurewebsites.net/api/detections"
ACARTIA = "https://acartia.io/api/v1/sightings/current"      # public, no token: a rolling ~7-day window
ORCASOUND_API = "https://live.orcasound.net/api/json"
ORCASOUND_S3 = "https://s3-us-west-2.amazonaws.com/audio-orcasound-net"

# Orcasound hydrophone nodes (bucket prefix, display name, lon, lat). Fallback only: `fetch orcasound` also saves
# the live feed list (names, positions, visibility) and the build prefers it.
HYDROPHONES = {
    "rpi_orcasound_lab": ("Orcasound Lab", -123.1735, 48.5583),
    "rpi_north_sjc": ("North San Juan Channel", -123.0480, 48.5912),
    "rpi_andrews_bay": ("Andrews Bay", -123.1666, 48.5500),
    "rpi_sunset_bay": ("Sunset Bay", -122.3346, 47.8657),
    "rpi_bush_point": ("Bush Point", -122.6040, 48.0336),
    "rpi_port_townsend": ("Port Townsend", -122.7600, 48.1359),
    "rpi_mast_center": ("Mast Center", -122.3254, 47.3456),
}

# Other public hydrophones in the study area that can't be streamed in this page: shown as map points with links.
# Positions marked approx are read off operators' maps or descriptions, not surveyed coordinates.
# access: "public" = a free live stream on the operator's site, "login" = free registration / token needed,
# "none" = research station without public audio.
OTHER_HYDROPHONES = [
    {"id": "simres_east_point", "name": "East Point, Saturna Island", "operator": "SIMRES", "lon": -123.0515, "lat": 48.7804,
     "access": "public", "url": "https://simres.ca/", "approx": False,
     "note": "Live stream on simres.ca when on air (often offline). Boundary Pass and the southern Strait of Georgia."},
    {"id": "simres_monarch_head", "name": "Monarch Head, Saturna Island", "operator": "SIMRES", "lon": -123.0910, "lat": 48.7666,
     "access": "public", "url": "https://simres.ca/", "approx": False,
     "note": "Second channel of the SIMRES stream. Inside the Saturna vessel-restricted zone."},
    {"id": "raincoast_pender", "name": "Swanson Channel, North Pender Island", "operator": "Raincoast Conservation Foundation",
     "lon": -123.300, "lat": 48.770, "access": "public", "approx": True,
     "url": "https://www.raincoast.org/2023/10/our-new-whale-livestream-at-a-southern-resident-killer-whale-sanctuary-zone/",
     "note": "Hydrophone and camera livestream on Raincoast's YouTube channel, in a Southern Resident sanctuary zone."},
    {"id": "orcalab_hanson", "name": "OrcaLab, Hanson Island", "operator": "OrcaLab (Pacific Orca Society)", "lon": -126.700, "lat": 50.580,
     "access": "public", "approx": True, "url": "https://orcalab.org/live-streams/",
     "note": "A network of hydrophones in Blackfish Sound, Blackney Pass and Johnstone Strait, streamed live by OrcaLab "
             "(Northern Residents, Bigg's orcas, humpbacks)."},
    {"id": "orcalab_robson", "name": "Robson Bight (rubbing beach)", "operator": "OrcaLab / explore.org", "lon": -126.585, "lat": 50.487,
     "access": "public", "approx": True, "url": "https://explore.org/livecams/orcas/orcalab-rubbing-beach-underwater",
     "note": "Underwater camera with hydrophone audio at times, in the Michael Bigg Ecological Reserve."},
    {"id": "jasco_boundary_pass", "name": "Boundary Pass listening station", "operator": "JASCO / Port of Vancouver ECHO", "lon": -123.04,
     "lat": 48.76, "access": "none", "approx": True, "url": "https://www.jasco.com/projects/boundary-pass-uls",
     "note": "Research station under the shipping lanes; detections go to a researcher portal, no public audio."},
    {"id": "onc_sog_central", "name": "Strait of Georgia Central", "operator": "Ocean Networks Canada", "lon": -123.426, "lat": 49.040,
     "access": "login", "approx": True, "url": "https://data.oceannetworks.ca/",
     "note": "Cabled seafloor hydrophone. Archived audio needs a free ONC account and token, so it isn't streamed here."},
    {"id": "onc_sog_east", "name": "Strait of Georgia East", "operator": "Ocean Networks Canada", "lon": -123.317, "lat": 49.043,
     "access": "login", "approx": True, "url": "https://data.oceannetworks.ca/",
     "note": "Cabled seafloor hydrophone. Needs a free ONC account and token."},
    {"id": "onc_saanich", "name": "Saanich Inlet, Patricia Bay", "operator": "Ocean Networks Canada", "lon": -123.486, "lat": 48.655,
     "access": "login", "approx": True, "url": "https://data.oceannetworks.ca/",
     "note": "Cabled observatory node. Needs a free ONC account and token."},
    {"id": "onc_folger", "name": "Folger Passage, Barkley Sound", "operator": "Ocean Networks Canada", "lon": -125.281, "lat": 48.814,
     "access": "login", "approx": True, "url": "https://data.oceannetworks.ca/",
     "note": "West coast of Vancouver Island. Needs a free ONC account and token."},
    {"id": "onc_clayoquot", "name": "Clayoquot Slope", "operator": "Ocean Networks Canada", "lon": -126.848, "lat": 48.671,
     "access": "login", "approx": True, "url": "https://data.oceannetworks.ca/",
     "note": "Offshore of the west coast of Vancouver Island. Needs a free ONC account and token."},
]

# US Coast Guard terrestrial AIS, distributed by NOAA / BOEM Marine Cadastre (public domain). Since 2025 the daily
# files are zstd-compressed CSVs on NOAA's blob store; they're published in batches months after the fact.
AIS_INDEX = "https://noaaocm.blob.core.windows.net/ais/csv2/csv{y}/index.html"
AIS_URL = "https://noaaocm.blob.core.windows.net/ais/csv2/csv{y}/ais-{d}.csv.zst"
AIS_DAYS = 14                               # keep the latest N days NOAA has published

# Regions used to report how well the US-collected AIS covers each part of the study area (south, west, north, east)
AIS_REGIONS = [
    ("Puget Sound", (47.0, -123.0, 48.2, -122.0)),
    ("Juan de Fuca", (48.0, -124.8, 48.6, -123.0)),
    ("Haro Strait & Gulf Islands", (48.4, -123.5, 49.0, -122.9)),
    ("Strait of Georgia, south", (49.0, -124.0, 49.5, -122.9)),
    ("Strait of Georgia, north", (49.5, -125.2, 50.1, -123.8)),
    ("Johnstone Strait", (50.1, -127.0, 50.8, -125.2)),
    ("Vancouver Island west coast", (48.4, -128.6, 50.8, -124.8)),
]


# AIS ship-type code → category (order and colours are mirrored in site/src/salish/main.js)
SHIP_CATS = ["Passenger & ferry", "Cargo", "Tanker", "Tug & tow", "Fishing", "Pleasure & sail", "Other"]


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


# iNaturalist: all cetaceans (order Cetacea). The season charts show these four groups (orca = every ecotype).
INAT_CETACEA = 152871
INAT_SEASON = {"Orca": (0, 1), "Humpback whale": (2,), "Grey whale": (3,), "Minke whale": (4,)}
