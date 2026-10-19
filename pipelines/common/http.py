"""Small HTTP helpers shared by every pipeline: retries, polite pacing, JSON."""
from __future__ import annotations

import time
from typing import Any

import requests

USER_AGENT = "open-data-portfolio/0.1 (+https://github.com/)"

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
_last_call: dict[str, float] = {}


def get_json(url: str, params: dict | None = None, *, min_interval: float = 0.0,
             retries: int = 4, timeout: int = 90) -> Any:
    """GET a JSON document, waiting `min_interval` seconds between calls to the same host."""
    host = url.split("/")[2]
    for attempt in range(retries):
        wait = _last_call.get(host, 0) + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[host] = time.time()
        try:
            r = _session.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {url}")
            if 400 <= r.status_code < 500:
                raise PermissionError(f"{r.status_code} from {r.url}: {r.text[:300]}")
            return r.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt == retries - 1:
                raise
            backoff = 2 ** attempt * 3
            print(f"  retry {attempt + 1} after {backoff}s: {exc}")
            time.sleep(backoff)
