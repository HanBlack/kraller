"""Společné HTTP helpers — retry při 5xx (Open-Meteo). 429 = okamžitě stop."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from openmeteo_client import OpenMeteoRateLimitError, in_cooldown, set_cooldown


def get_json(
    url: str,
    *,
    timeout: float = 120,
    max_retries: int = 3,
    label: str = "request",
) -> object:
    if in_cooldown():
        raise OpenMeteoRateLimitError(f"{label}: Open-Meteo cooldown aktivní")

    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Kraller/1.0 (storm data update)"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429:
                set_cooldown()
                raise OpenMeteoRateLimitError(
                    f"{label}: HTTP 429 Too Many Requests"
                ) from e
            if e.code not in (502, 503, 504) or attempt == max_retries - 1:
                raise
            retry_after = e.headers.get("Retry-After")
            if retry_after and str(retry_after).isdigit():
                delay = min(60.0, float(retry_after))
            else:
                delay = min(60.0, 4.0 * (2.0**attempt))
            print(
                f"  {label}: HTTP {e.code}, čekám {delay:.0f}s "
                f"(pokus {attempt + 1}/{max_retries})…",
                flush=True,
            )
            time.sleep(delay)
        except (TimeoutError, urllib.error.URLError) as e:
            last_err = e
            if attempt == max_retries - 1:
                raise
            delay = min(45.0, 2.0**attempt)
            print(
                f"  {label}: síťová chyba, čekám {delay:.0f}s "
                f"(pokus {attempt + 1}/{max_retries})…",
                flush=True,
            )
            time.sleep(delay)
    raise RuntimeError(f"{label} selhalo") from last_err
