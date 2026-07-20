"""Stáhne vítr z Open-Meteo (850 / 500 hPa) jako mřížku u/v pro particle overlay.

Důležité: hourly začíná v 00:00 UTC — NIKDY nebrat index [0] jako „teď“.
Při 429 / výpadku: fallback z formation/grid.json (steering z aktuální hodiny).
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

# Oblast ČR + okolí (hrubší mřížka = méně API volání)
WEST, SOUTH, EAST, NORTH = 11.4, 47.8, 19.6, 51.4
COLS, ROWS = 12, 8
BATCH_SIZE = 48
BATCH_PAUSE_S = 3.0
FORMATION_GRID = os.path.join("public", "data", "formation", "grid.json")
WIND_LOW = os.path.join("public", "data", "wind", "low.json")
WIND_MAX_AGE_MIN = 10
FORMATION_FOR_WIND_MAX_AGE_MIN = 15


def lat_lons() -> tuple[list[float], list[float]]:
    lats = [SOUTH + (j / (ROWS - 1)) * (NORTH - SOUTH) for j in range(ROWS)]
    lons = [WEST + (i / (COLS - 1)) * (EAST - WEST) for i in range(COLS)]
    return lats, lons


def wind_to_uv(speed_kmh: float, direction_deg: float) -> tuple[float, float]:
    """Meteorologický směr (odkud vítr) → u/v v m/s (kam fouká)."""
    if math.isnan(speed_kmh) or math.isnan(direction_deg):
        return 0.0, 0.0
    speed_ms = speed_kmh / 3.6
    rad = math.radians(direction_deg + 180)
    return math.sin(rad) * speed_ms, math.cos(rad) * speed_ms


def heading_speed_to_uv(heading_deg: float, speed_kmh: float) -> tuple[float, float]:
    """Azimut kam fouká (0=N) + rychlost → u/v m/s."""
    speed_ms = max(0.0, speed_kmh) / 3.6
    rad = math.radians(heading_deg)
    return math.sin(rad) * speed_ms, math.cos(rad) * speed_ms


def fetch_batch(
    coords: list[tuple[float, float]],
    speed_key: str,
    dir_key: str,
    label: str,
) -> list[dict]:
    lat_param = ",".join(f"{lat:.4f}" for lat, _ in coords)
    lon_param = ",".join(f"{lon:.4f}" for _, lon in coords)
    params = urllib.parse.urlencode(
        {
            "latitude": lat_param,
            "longitude": lon_param,
            "hourly": f"{speed_key},{dir_key}",
            "wind_speed_unit": "kmh",
            "timezone": "UTC",
            "forecast_days": 1,
        }
    )
    url = forecast_url(params)
    data = get_json(url, timeout=90, label=label, max_retries=3)
    points = data if isinstance(data, list) else [data]
    if len(points) != len(coords):
        raise RuntimeError(f"Expected {len(coords)} points, got {len(points)}")
    return points


def series_at(values: list, idx: int) -> float:
    if not values or idx < 0 or idx >= len(values):
        return float("nan")
    try:
        v = float(values[idx])
        return float("nan") if math.isnan(v) else v
    except (TypeError, ValueError):
        return float("nan")


def fetch_level(level: str, speed_key: str, dir_key: str, now: datetime) -> dict:
    lats, lons = lat_lons()
    coords = [(lat, lon) for lat in lats for lon in lons]
    print(f"Fetching {level} wind ({len(coords)} pts)…")

    raw: list[dict] = []
    n_batches = (len(coords) + BATCH_SIZE - 1) // BATCH_SIZE
    for i, start in enumerate(range(0, len(coords), BATCH_SIZE)):
        batch = coords[start : start + BATCH_SIZE]
        print(f"  batch {i + 1}/{n_batches} ({len(batch)} pts)")
        raw.extend(
            fetch_batch(batch, speed_key, dir_key, label=f"wind {level} #{i + 1}")
        )
        if start + BATCH_SIZE < len(coords):
            time.sleep(BATCH_PAUSE_S)

    hour_idx = 0
    if raw:
        times = raw[0].get("hourly", {}).get("time") or []
        hour_idx = current_hour_index(times, now)
        print(f"  using hour index {hour_idx}/{max(0, len(times) - 1)} (not midnight [0])")

    u: list[float] = []
    v: list[float] = []
    for point in raw:
        h = point["hourly"]
        times = h.get("time") or []
        idx = current_hour_index(times, now) if times else hour_idx
        sp = series_at(h.get(speed_key) or [], idx)
        di = series_at(h.get(dir_key) or [], idx)
        uu, vv = wind_to_uv(sp, di)
        u.append(uu)
        v.append(vv)

    return {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "level": level,
        "source": "Open-Meteo",
        "hourIndex": hour_idx,
        "validAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "u": u,
        "v": v,
    }


def nearest_formation_env(
    lat: float, lon: float, points: list[dict]
) -> dict | None:
    best = None
    best_d = float("inf")
    for p in points:
        dlat = p["lat"] - lat
        dlon = p["lon"] - lon
        d = dlat * dlat + dlon * dlon
        if d < best_d:
            best_d = d
            best = p
    return None if best is None else best.get("environment")


def wind_from_formation(now: datetime) -> tuple[dict, dict]:
    """
    Fallback: deep-layer steering z formation/grid.json (aktuální hodina).
    low ≈ 0.9× rychlost, upper ≈ 1.15× (jemný rozdíl pro vrstvy UI).
    """
    path = os.path.join("public", "data", "formation", "grid.json")
    with open(path, encoding="utf-8") as f:
        grid = json.load(f)
    points = grid.get("points") or []
    if not points:
        raise RuntimeError("formation grid prázdný — nelze sestavit vítr")

    lats, lons = lat_lons()
    hour_idx = points[0].get("environment", {}).get("hourIndex")
    low_u: list[float] = []
    low_v: list[float] = []
    up_u: list[float] = []
    up_v: list[float] = []

    for lat in lats:
        for lon in lons:
            env = nearest_formation_env(lat, lon, points) or {}
            hdg = float(env.get("steerHeadingDeg") or 90)
            spd = float(env.get("steerSpeedKmh") or 30)
            u0, v0 = heading_speed_to_uv(hdg, spd * 0.9)
            u1, v1 = heading_speed_to_uv(hdg, spd * 1.15)
            low_u.append(u0)
            low_v.append(v0)
            up_u.append(u1)
            up_v.append(v1)

    valid = grid.get("validAt") or now.strftime("%Y-%m-%dT%H:%M:%SZ")
    base = {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "source": "formation-steer-fallback",
        "hourIndex": hour_idx,
        "validAt": valid,
    }
    low = {**base, "level": "850hPa", "u": low_u, "v": low_v}
    upper = {**base, "level": "500hPa", "u": up_u, "v": up_v}
    print(
        f"Wind fallback from formation "
        f"(hourIndex={hour_idx}, pts={len(points)} → {COLS}x{ROWS})"
    )
    return low, upper


def write_wind(low: dict, upper: dict) -> None:
    out_dir = os.path.join("public", "data", "wind")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "low.json"), "w", encoding="utf-8") as f:
        json.dump(low, f)
    with open(os.path.join(out_dir, "upper.json"), "w", encoding="utf-8") as f:
        json.dump(upper, f)
    print(
        f"Wrote {out_dir}/low.json and upper.json "
        f"(hour={low.get('hourIndex')}, source={low.get('source')})"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Vítr pro particle overlay")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Vynutit stažení z Open-Meteo (jinak z formation gridu)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Přepsat i čerstvé wind/*.json",
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    if os.environ.get("WIND_FALLBACK_ONLY") == "1":
        low, upper = wind_from_formation(now)
        write_wind(low, upper)
        return 0

    formation_ok = is_fresh_path(FORMATION_GRID, FORMATION_FOR_WIND_MAX_AGE_MIN)
    wind_fresh = is_fresh_path(WIND_LOW, WIND_MAX_AGE_MIN)

    if not args.force and wind_fresh and not args.live:
        age = age_minutes(read_valid_at(WIND_LOW), now)
        print(
            f"Wind grid je čerstvý ({age:.0f} min) — přeskakuji.",
            flush=True,
        )
        return 0

    use_formation = (
        not args.live
        and formation_ok
        and os.path.isfile(FORMATION_GRID)
    )
    if use_formation:
        age = age_minutes(read_valid_at(FORMATION_GRID), now)
        print(
            f"Vítr z formation gridu ({age:.0f} min) — bez Open-Meteo volání.",
            flush=True,
        )
        low, upper = wind_from_formation(now)
        write_wind(low, upper)
        return 0

    if in_cooldown() or not wait_if_cooldown("Wind"):
        if os.path.isfile(WIND_LOW):
            print("Open-Meteo cooldown — ponechávám existující wind grid.", flush=True)
            return 0
        if os.path.isfile(FORMATION_GRID):
            low, upper = wind_from_formation(now)
            write_wind(low, upper)
            return 0
        return 1

    try:
        low = fetch_level("850hPa", "wind_speed_850hPa", "wind_direction_850hPa", now)
        time.sleep(BATCH_PAUSE_S)
        upper = fetch_level("500hPa", "wind_speed_500hPa", "wind_direction_500hPa", now)
        write_wind(low, upper)
        return 0
    except OpenMeteoRateLimitError as e:
        print(f"Open-Meteo rate limit ({e}) — vítr z formation…", flush=True)
        if os.path.isfile(FORMATION_GRID):
            low, upper = wind_from_formation(now)
            write_wind(low, upper)
            return 0
        if os.path.isfile(WIND_LOW):
            print("Ponechávám existující wind grid.", flush=True)
            return 0
        return 1
    except Exception as e:
        print(f"Open-Meteo wind selhalo ({e}) — používám formation steering…")
        try:
            low, upper = wind_from_formation(now)
            write_wind(low, upper)
            return 0
        except Exception as e2:
            print(f"Fallback taky selhal: {e2}")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
