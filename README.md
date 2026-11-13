# Salish Sea Live

Live hydrophones, whale sightings, shipping lanes, orca-call triage model. Region: Salish Sea.

**Live dashboard: https://markandrewjenkins.github.io/salish-sea-live/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Area:** 47–51° N, 122–128.6° W: all of Vancouver Island (west coast and Johnstone Strait included), the whole Strait of Georgia, Juan de Fuca and Puget Sound. Every source that takes a bounding box uses it (`pipelines/salish/config.py`).
- **Live audio:** The Orcasound hydrophones (from Orcasound's feed list) stream as HLS straight from their public S3 bucket into the page (hls.js), with a Web Audio spectrogram.
  - Eleven other hydrophones are shown as map points with links: SIMRES (Saturna), Raincoast (Pender), OrcaLab (Hanson Island, Robson Bight), JASCO/ECHO (Boundary Pass) and Ocean Networks Canada.
  - ONC audio needs an account and token, so it's linked, not fetched. Positions marked approximate are read off operators' descriptions.
- **Freshness:** `fetch.py` runs each source on its own and records success, failure and the newest record in `data/salish/raw/status.json`. In CI a failure becomes a `::warning` annotation. The page shows when the pipeline ran and each source's newest record.
  - Why this exists: from 6 to 11 November 2026 the page was stuck on 5 November data. An Acartia record arrived with its count and coordinates as strings, pyarrow refused to write the mixed column, and the step's `set -e` stopped the build. `continue-on-error` hid the failure.
- **Sightings:** Acartia's public endpoint serves only the current week, so runs are merged into `sightings.json`, a rolling one-year archive that starts 6 October 2026 (back-filled from this repo's history). iNaturalist adds the last 120 days of cetacean observations. The map's date range runs up to today.
- **Ships:** The latest 14 days of US Coast Guard AIS from NOAA/BOEM Marine Cadastre. Since 2025 these are daily `.csv.zst` files of about 320 MB each, streamed and filtered with pyarrow's zstd codec, so no new dependency.
  - Tracks are simplified (Douglas–Peucker, about 40 m) and delta-encoded into one `ships/<day>.json` per day, about 0.6 MB each, which the page loads on demand. A checklist filters seven vessel types.
  - Coverage is US receivers only, so it is thin north of Nanaimo and essentially absent in Johnstone Strait and off the west coast. The page reports vessels per day by region and says so.
  - Set the `AISSTREAM_API_KEY` repository secret to add a live snapshot from aisstream.io (free account required). Without it, "today" says so and shows no ships.
- **Whale-sound tier list:** An editorial 0–100 score for the last 30 days of OrcaHello encounters and Orcasound listener events: verification 30, AI confidence 20, species 20 (Southern Resident > other orca > humpback > unknown), clarity 15, corroboration 10, recency 5. Tiers are S 85+, A 70+, B 55+, C 40+, D below.
  - OrcaHello clips play their WAV. Listener events replay about 30 s of Orcasound's HLS archive around the moment the button was pressed.
- **Hearing outlook:** Weekly logistic regression on season and recent whale reports in the Orcasound app, which include AI detections posted there.
  - Validated on 2025–2026 against two baselines.
  - It's only a few percent better than "this hydrophone's recent frequency", and the page says so.
- **Triage model:** A gradient-boosted second-stage classifier on OrcaHello detections. It predicts the volunteer verdict from AI scores plus network context, with a time split (2020–24 train, 2025–26 test) against ranking by AI confidence alone.
  - OrcaHello runs on a small Azure app, so the full crawl is slow, resumable and done locally, never in CI. CI fetches only the last week (about 5 pages). The crawler now re-fetches a short last page instead of trusting it, which had frozen the clips at September 2026.
  - The context features (hourly windows) are computed in true seconds. Under pandas 3 they had been off by 1,000× because timestamps are stored in microseconds.
  - Result on 12,504 reviewed detections (November 2026 rebuild): AUC 0.806 vs 0.623 for AI confidence alone. To catch 95% of real calls, volunteers would review 70% of flags instead of 87%.
  - "Season" carries most of the signal, then "strongest segment", the hydrophone, and network activity in the last two hours.
  - The earlier figures (AUC 0.729, 80% vs 89%) came from the mis-scaled windows and fewer detections.
- **Privacy:** Moderator identities, free-text comments, listener descriptions and reporter names are dropped at fetch time.

## Design

The page has a Classic design and a themed alternative, **Sonar Room** (nautical chart / submarine sonar console), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.salish.fetch daily
.venv/Scripts/python -m pipelines.salish.fetch ais
.venv/Scripts/python -m pipelines.salish.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
