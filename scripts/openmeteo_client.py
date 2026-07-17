"""Open-Meteo URL + globální cooldown po 429."""

from __future__ import annotations

import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COOLDOWN_FILE = ROOT / ".cache" / "openmeteo_cooldown_until"

# Po 429 nevolat API po dobu cooldownu (minuty)
DEFAULT_COOLDOWN_MIN = 30


class OpenMeteoRateLimitError(RuntimeError):
    """Open-Meteo vrátilo 429 nebo je aktivní cooldown."""


def forecast_base_url() -> str:
    key = os.environ.get("OPEN_METEO_API_KEY", "").strip()
    if key:
        return "https://customer-api.open-meteo.com/v1/forecast"
    return "https://api.open-meteo.com/v1/forecast"


def forecast_url(params: str) -> str:
    base = forecast_base_url()
    key = os.environ.get("OPEN_METEO_API_KEY", "").strip()
    if key:
        sep = "&" if params else ""
        return f"{base}?{params}{sep}apikey={key}"
    return f"{base}?{params}"


def cooldown_until() -> float:
    try:
        if COOLDOWN_FILE.is_file():
            return float(COOLDOWN_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        pass
    return 0.0


def in_cooldown() -> bool:
    return time.time() < cooldown_until()


def set_cooldown(minutes: float = DEFAULT_COOLDOWN_MIN) -> None:
    if in_cooldown():
        return
    COOLDOWN_FILE.parent.mkdir(parents=True, exist_ok=True)
    until = time.time() + minutes * 60.0
    COOLDOWN_FILE.write_text(str(until), encoding="utf-8")
    print(
        f"  Open-Meteo cooldown {minutes:.0f} min "
        f"(429 — další volání přeskočena, používám cache)",
        flush=True,
    )


def wait_if_cooldown(label: str = "Open-Meteo") -> bool:
    """Vrátí False pokud je aktivní cooldown (volání přeskočit)."""
    left = cooldown_until() - time.time()
    if left <= 0:
        return True
    print(
        f"  {label}: přeskočeno — cooldown ještě {left / 60:.0f} min",
        flush=True,
    )
    return False
