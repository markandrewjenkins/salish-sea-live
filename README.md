# Salish Sea Live

Live hydrophones, whale sightings, shipping lanes, orca-call triage model. Region: Salish Sea.

**Live dashboard: https://markandrewjenkins.github.io/salish-sea-live/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Live audio:** The seven Orcasound hydrophones stream as HLS straight from their public S3 bucket into the page (hls.js), with a Web Audio spectrogram.
- **Hearing outlook:** Weekly logistic regression on season and recent listener reports of whale sounds (Orcasound live app, ≈23k reports since late 2023).
  - Validated on 2025–2026 against two baselines.
  - It's only ~5% better than "this hydrophone's recent frequency", and the page says so.
- **Triage model:** A gradient-boosted second-stage classifier on OrcaHello detections. It predicts the volunteer verdict from AI scores plus network context, with a time split (2020–24 train, 2025–26 test) against ranking by AI confidence alone.
  - OrcaHello runs on a small Azure app, so the crawl is slow, resumable and done locally, never in CI.
  - Result on 11,819 reviewed detections: AUC 0.729 vs 0.607 for AI confidence alone. To catch 95% of real calls, volunteers would review 80% of flags instead of 89%. That is a real but modest saving; "season" and "strongest segment" carry most of the signal.
- **Ships:** One summer weekday of US Coast Guard AIS (NOAA/BOEM Marine Cadastre).
  - Set the `AISSTREAM_API_KEY` repository secret to add a live snapshot from aisstream.io (free account required).
- **Privacy:** Moderator identities, free-text comments and reporter names are dropped at fetch time.

## Design

The page has a Classic design and a themed alternative, **Sonar Room** (nautical chart / submarine sonar console), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.salish.fetch orcasound
.venv/Scripts/python -m pipelines.salish.fetch acartia
.venv/Scripts/python -m pipelines.salish.fetch live
.venv/Scripts/python -m pipelines.salish.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
