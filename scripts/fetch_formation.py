"""Stáhne prostředí pro potenciál vzniku bouřek (Open-Meteo / ICON) nad mřížkou ČR.

Důležité:
- Open-Meteo hourly začíná v 00:00 UTC dnešního dne — NIKDY nebrat index [0] jako „teď“.
- CAPE pro Vznik = max v horizontu teď…+6 h (odpolední peak), ne noční nula.
- Steering = deep-layer 850+500 (stejně jako trajektorie bouřek).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import urllib.parse
from datetime import datetime, timezone

from data_freshness import age_minutes, is_fresh_path, read_valid_at
from http_util import get_json
from openmeteo_client import (
    OpenMeteoRateLimitError,
    forecast_url,
    in_cooldown,
    wait_if_cooldown,
)
from openmeteo_hour import current_hour_index

WEST, SOUTH, EAST, NORTH = 11.4, 47.8, 19.6, 51.4
COLS, ROWS = 24, 17

# ICON seamless = blízké Windy/DWD pro střední Evropu (CAPE, LI)
MODEL = "icon_seamless"

HOURLY = ",".join(
    [
        "cape",
        "dew_point_2m",
        "lifted_index",
        "wind_speed_850hPa",
        "wind_direction_850hPa",
        "wind_speed_500hPa",
        "wind_direction_500hPa",
    ]
)

BATCH_SIZE = 80
BATCH_PAUSE_S = 5.0
CAPE_HORIZON_H = 6  # max CAPE teď…+6 h pro potenciál vzniku
# Cílová frekvence obnovy — stejný pipeline jako radar (~25–30 min)
FORMATION_MAX_AGE_MIN = 30
# Při 429 / cooldownu / výpadku použít existující grid až do této stáří
FORMATION_KEEP_MAX_AGE_MIN = 360
OUT_PATH = os.path.join("public", "data", "formation", "grid.json")
WRITE_WIND_FROM_FORMATION = True  # jeden Open-Meteo fetch → i wind/*.json


def lat_lons() -> tuple[list[float], list[float]]:
    lats = [SOUTH + (j / (ROWS - 1)) * (NORTH - SOUTH) for j in range(ROWS)]
    lons = [WEST + (i / (COLS - 1)) * (EAST - WEST) for i in range(COLS)]
    return lats, lons


def wind_to_uv(speed_kmh: float, direction_deg: float) -> tuple[float, float]:
    if math.isnan(speed_kmh) or math.isnan(direction_deg):
        return 0.0, 0.0
    speed_ms = speed_kmh / 3.6
    rad = math.radians(direction_deg + 180)
    return math.sin(rad) * speed_ms, math.cos(rad) * speed_ms


def shear_0_6_ms(u_lo: float, v_lo: float, u_hi: float, v_hi: float) -> float:
    return math.hypot(u_hi - u_lo, v_hi - v_lo)


def estimate_srh(
    dir_lo: float,
    dir_hi: float,
    shear_ms: float,
    speed_lo_kmh: float,
) -> float:
    if math.isnan(dir_lo) or math.isnan(dir_hi):
        return max(0.0, shear_ms * 5.0)
    diff = abs((dir_hi - dir_lo + 180) % 360 - 180)
    veering = min(diff, 180 - diff)
    speed_boost = min(40.0, max(0.0, speed_lo_kmh - 8.0) * 0.35)
    return min(240.0, veering * 1.8 + shear_ms * 6.0 + speed_boost)


def series_at(values: list, idx: int, default: float = float("nan")) -> float:
    if not values or idx < 0 or idx >= len(values):
        return default
    try:
        v = float(values[idx])
        return default if math.isnan(v) else v
    except (TypeError, ValueError):
        return default


def cape_for_formation(cape_series: list[float], idx: int) -> tuple[float, float]:
    """
    cape_now = CAPE v aktuální hodině
    cape_use = max(teď … teď+6h) — potenciál vzniku (jako denní peak na Windy)
    """
    if not cape_series:
        return 0.0, 0.0
    safe = [max(0.0, float(x)) if x is not None and not math.isnan(float(x)) else 0.0 for x in cape_series]
    idx = max(0, min(idx, len(safe) - 1))
    cape_now = safe[idx]
    end = min(len(safe), idx + CAPE_HORIZON_H + 1)
    cape_peak = max(safe[idx:end]) if end > idx else cape_now
    # Pro skóre vzniku ber peak (jinak ráno všude 0)
    return cape_now, cape_peak


def li_cooling_proxy(li_series: list, idx: int) -> float:
    """Záporné = nestabilita roste (LI klesá) — proxy růstu konvekce."""
    if not li_series or idx < 0:
        return 0.0
    now = series_at(li_series, idx)
    prev = series_at(li_series, max(0, idx - 3), now)
    if math.isnan(now) or math.isnan(prev):
        return 0.0
    # LI klesá → konvekce roste
    drop = prev - now
    if drop <= 0:
        return 0.0
    return -min(6.0, drop * 1.5)


def fetch_batch(coords: list[tuple[float, float]], batch_no: int) -> list[dict]:
    lat_param = ",".join(f"{lat:.4f}" for lat, _ in coords)
    lon_param = ",".join(f"{lon:.4f}" for _, lon in coords)
    params = urllib.parse.urlencode(
        {
            "latitude": lat_param,
            "longitude": lon_param,
            "hourly": HOURLY,
            "models": MODEL,
            "wind_speed_unit": "kmh",
            "timezone": "UTC",
            "forecast_days": 1,
        }
    )
    url = forecast_url(params)
    data = get_json(url, timeout=120, label=f"formation #{batch_no}")
    points = data if isinstance(data, list) else [data]
    if len(points) != len(coords):
        raise RuntimeError(f"Expected {len(coords)} points, got {len(points)}")
    return points


def point_environment(point: dict, now: datetime) -> dict:
    h = point["hourly"]
    times = h.get("time") or []
    idx = current_hour_index(times, now)

    cape_raw = [float(x) if x is not None else float("nan") for x in (h.get("cape") or [])]
    cape_now, cape_peak = cape_for_formation(cape_raw, idx)

    dew = series_at(h.get("dew_point_2m") or [], idx)
    li = series_at(h.get("lifted_index") or [], idx)

    spd850 = series_at(h.get("wind_speed_850hPa") or [], idx, 0.0)
    dir850 = series_at(h.get("wind_direction_850hPa") or [], idx)
    spd500 = series_at(h.get("wind_speed_500hPa") or [], idx, 0.0)
    dir500 = series_at(h.get("wind_direction_500hPa") or [], idx)

    u850, v850 = wind_to_uv(spd850, dir850)
    u500, v500 = wind_to_uv(spd500, dir500)
    shear = shear_0_6_ms(u850, v850, u500, v500)
    srh = estimate_srh(dir850, dir500, shear, spd850)

    # Deep-layer steering (35 % 850 + 65 % 500) — shodné s trajektorií bouřek
    u = 0.35 * u850 + 0.65 * u500
    v = 0.35 * v850 + 0.65 * v500
    steer_heading = (math.degrees(math.atan2(u, v)) + 360) % 360
    steer_speed = math.hypot(u, v) * 3.6 * 0.9

    cooling = li_cooling_proxy(h.get("lifted_index") or [], idx)
    # CAPE rostoucí k peaku = slabý proxy růstu
    if cape_peak > cape_now + 40:
        cooling = min(cooling, -min(4.0, (cape_peak - cape_now) / 200.0 * 4.0))

    return {
        # Hlavní CAPE pro skóre = peak v horizontu (realističtější vs Windy)
        "capeJkg": round(max(0.0, cape_peak), 1),
        "capeNowJkg": round(max(0.0, cape_now), 1),
        "dewpointC": round(dew, 1) if not math.isnan(dew) else None,
        "shear0to6Ms": round(shear, 1),
        "srh01": round(srh, 1),
        "cloudTopCoolingCPer15min": round(cooling, 2),
        "liftedIndexC": round(li, 1) if not math.isnan(li) else None,
        "steerHeadingDeg": round(steer_heading, 1),
        "steerSpeedKmh": round(max(0.0, steer_speed), 1),
        "hourIndex": idx,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Stáhne formation grid z Open-Meteo")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Stáhnout i když grid.json je ještě čerstvý",
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    if not args.force:
        # Běžný skip jen když je grid čerstvý (≤ FORMATION_MAX_AGE_MIN).
        # FORMATION_KEEP_MAX_AGE_MIN NENÍ běžný skip — jen 429/cooldown/fallback níže.
        if _use_existing_grid(now, "čerstvý", FORMATION_MAX_AGE_MIN):
            return 0
        if in_cooldown() or not wait_if_cooldown("Formation"):
            if _use_existing_grid(now, "cooldown", FORMATION_KEEP_MAX_AGE_MIN):
                return 0
            print("Open-Meteo cooldown a chybí použitelný formation grid.", flush=True)
            return 1

    try:
        return _fetch_and_write(now)
    except OpenMeteoRateLimitError as e:
        if _use_existing_grid(now, "429 bypass", FORMATION_KEEP_MAX_AGE_MIN):
            return 0
        print(f"Formation: {e}", flush=True)
        return 1
    except Exception as e:
        if _use_existing_grid(now, "fallback", FORMATION_KEEP_MAX_AGE_MIN):
            return 0
        print(f"Formation fetch selhalo: {e}", flush=True)
        return 1


def _use_existing_grid(now: datetime, reason: str, max_minutes: float) -> bool:
    if not os.path.isfile(OUT_PATH):
        return False
    if not is_fresh_path(OUT_PATH, max_minutes):
        return False
    age = age_minutes(read_valid_at(OUT_PATH), now)
    print(
        f"Formation grid {reason} ({age:.0f} min) — "
        f"Open-Meteo nevolám (limit {max_minutes:.0f} min).",
        flush=True,
    )
    return True


def _uv_at_level(
    point: dict, now: datetime, speed_key: str, dir_key: str
) -> tuple[float, float, int]:
    h = point["hourly"]
    times = h.get("time") or []
    idx = current_hour_index(times, now) if times else 0
    sp = series_at(h.get(speed_key) or [], idx, 0.0)
    di = series_at(h.get(dir_key) or [], idx)
    return (*wind_to_uv(sp, di), idx)


def _write_wind_from_raw(
    coords: list[tuple[float, float]], raw_points: list[dict], now: datetime
) -> None:
    """Ze stejné Open-Meteo odpovědi zapíše wind/low.json + upper.json (bez dalšího API)."""
    from fetch_wind import write_wind  # noqa: WPS433 — lazy, bez cyklického importu při load

    low_u: list[float] = []
    low_v: list[float] = []
    up_u: list[float] = []
    up_v: list[float] = []
    hour_idx = 0
    for point in raw_points:
        u850, v850, hour_idx = _uv_at_level(
            point, now, "wind_speed_850hPa", "wind_direction_850hPa"
        )
        u500, v500, _ = _uv_at_level(
            point, now, "wind_speed_500hPa", "wind_direction_500hPa"
        )
        low_u.append(u850)
        low_v.append(v850)
        up_u.append(u500)
        up_v.append(v500)

    valid = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    base = {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "source": f"Open-Meteo/{MODEL}+formation",
        "hourIndex": hour_idx,
        "validAt": valid,
    }
    low = {**base, "level": "850hPa", "u": low_u, "v": low_v}
    upper = {**base, "level": "500hPa", "u": up_u, "v": up_v}
    write_wind(low, upper)
    print(
        f"  wind from formation fetch ({COLS}x{ROWS}, hour={hour_idx}) — bez 2. API",
        flush=True,
    )


def _fetch_and_write(now: datetime) -> int:
    lats, lons = lat_lons()
    coords = [(lat, lon) for lat in lats for lon in lons]
    print(
        f"Fetching formation env ({len(coords)} pts, model={MODEL}, "
        f"now={now.strftime('%Y-%m-%dT%H:%MZ')}) …"
    )

    raw_points: list[dict] = []
    n_batches = (len(coords) + BATCH_SIZE - 1) // BATCH_SIZE
    for i, start in enumerate(range(0, len(coords), BATCH_SIZE)):
        batch = coords[start : start + BATCH_SIZE]
        print(f"  batch {i + 1}/{n_batches} ({len(batch)} pts)")
        raw_points.extend(fetch_batch(batch, i + 1))
        if start + BATCH_SIZE < len(coords):
            time.sleep(BATCH_PAUSE_S)

    out_points: list[dict] = []
    for (lat, lon), point in zip(coords, raw_points):
        out_points.append(
            {
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "environment": point_environment(point, now),
            }
        )

    capes = [p["environment"]["capeJkg"] for p in out_points]
    cape_nows = [p["environment"].get("capeNowJkg") or 0 for p in out_points]
    print(
        f"  CAPE peak6h: med={sorted(capes)[len(capes)//2]:.0f} max={max(capes):.0f} "
        f"zero={sum(1 for c in capes if c<=0)}"
    )
    print(
        f"  CAPE now:    med={sorted(cape_nows)[len(cape_nows)//2]:.0f} "
        f"zero={sum(1 for c in cape_nows if c<=0)}"
    )

    out = {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "source": f"Open-Meteo/{MODEL}",
        "validAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "capeMode": f"max_now_plus_{CAPE_HORIZON_H}h",
        "points": out_points,
    }

    out_dir = os.path.join("public", "data", "formation")
    os.makedirs(out_dir, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"Wrote {OUT_PATH} ({len(out_points)} points)")

    if WRITE_WIND_FROM_FORMATION:
        try:
            _write_wind_from_raw(coords, raw_points, now)
        except Exception as e:
            print(f"  wind from formation selhalo ({e}) — wind nechávám", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
