"""
Bohatý sběr learning dat pro pozdější přesnou kalibraci.

Ukládá events + samples (predikce→realita) + state.
Schema v=2 — směr, síla, zrod, zánik, vznik, env, stáří dat, chyby heading/rychlost.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from learning_store import (  # noqa: E402
    SCHEMA_VERSION,
    append_jsonl,
    count_lines,
    ensure_dir,
    events_path,
    load_state,
    samples_path,
    save_state,
    track_key,
)

ROOT = Path(__file__).resolve().parents[1]
CELLS = ROOT / "public" / "data" / "opera" / "cells.geojson"
ARCHIVE_DIR = ROOT / "public" / "data" / "opera" / "archive"
WIND_LOW = ROOT / "public" / "data" / "wind" / "low.json"
WIND_UPPER = ROOT / "public" / "data" / "wind" / "upper.json"
FORMATION = ROOT / "public" / "data" / "formation" / "grid.json"
META = ROOT / "public" / "data" / "meta.json"

# Konstanty zrcadlí frontend — ukládají se do každého běhu (reprodukovatelnost)
ACTIVE_CONSTANTS = {
    "MAX_TRUSTED_TRACK_KMH": 70,
    "MAX_WIND_ALIGN_DEG": 35,
    "MAX_SEGMENT_JITTER_DEG": 55,
    "TRUE_BIRTH_MAX_DBZ": 39,
    "TRUE_BIRTH_MAX_AGE_MIN": 10,
    "HISTORY_WINDOW_MIN": 25,
    "MIN_ZONE_SCORE": 28,
    "FORMATION_HIT_KM": 35,
    "FORMATION_TIMEOUT_MIN": 90,
    "WIND_BLEND_850": 0.25,
    "WIND_BLEND_500": 0.75,
    # stormConfig / ČHMÚ — pro propose po ~2 dnech
    "HAIL_LIKELY_DBZ": 55,
    "HAIL_LIKELY_ECHO_TOP_KM": 10,
    "HAIL_MIN_ABOVE_FZL_KM": 1.5,
    "FCT_AGREE_MAX_DEG": 35,
    # Zrcadlo stormConfig.intensification (kalibrace 2026-07-23 — nový produkt)
    "INTENSIFY_ALERT_SCORE_MIN": 50,
    "INTENSIFY_SUPPRESS_GROWTH_DBZ": 2,
    "INTENSIFY_HIT_DBZ": 3.0,  # act − from ≥ 3 = hit po purple candidate
    # stormConfig.evolution — zrcadlo UI živého / forecast vývoje
    "EVOLVE_BLEND_PRED": 0.55,
    "EVOLVE_BLEND_TREND": 0.45,
    "EVOLVE_TREND_GAIN": 0.55,
    "EVOLVE_GROWTH_DBZ_PER_15": 6.0,  # když purple / willIntensify
    "EVOLVE_FOOTPRINT_PER_DBZ": 0.01,
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δλ = math.radians(lon2 - lon1)
    y = math.sin(Δλ) * math.cos(φ2)
    x = math.cos(φ1) * math.sin(φ2) - math.sin(φ1) * math.cos(φ2) * math.cos(Δλ)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


def parse_opera_time(s: str) -> datetime | None:
    try:
        return datetime.strptime(str(s)[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def evolve_dbz_pred(
    from_dbz: float,
    horizon_min: float,
    *,
    slope: float | None,
    growth: float | None,
    will_intensify: bool,
) -> float:
    """Zrcadlo evolveDbzAt / predictedDbzAt (bez env timeline — slope + growth)."""
    if horizon_min <= 0.05:
        return from_dbz
    if will_intensify:
        g = ACTIVE_CONSTANTS["EVOLVE_GROWTH_DBZ_PER_15"]
        return _clamp(from_dbz + g * (horizon_min / 15.0), 30, 65)
    slope_v = float(slope or 0.0)
    slope_pred = _clamp(from_dbz + slope_v * (horizon_min / 15.0), 26, 65)
    if growth is None:
        return slope_pred
    gain = ACTIVE_CONSTANTS["EVOLVE_TREND_GAIN"]
    trend = from_dbz + _clamp(float(growth) * (horizon_min / 15.0), -10, 10) * gain
    trend = _clamp(trend, 26, 65)
    return (
        ACTIVE_CONSTANTS["EVOLVE_BLEND_PRED"] * slope_pred
        + ACTIVE_CONSTANTS["EVOLVE_BLEND_TREND"] * trend
    )


def destination(lat: float, lon: float, heading: float, dist_km: float) -> tuple[float, float]:
    r = 6371.0
    δ = dist_km / r
    θ = math.radians(heading)
    φ1 = math.radians(lat)
    λ1 = math.radians(lon)
    φ2 = math.asin(math.sin(φ1) * math.cos(δ) + math.cos(φ1) * math.sin(δ) * math.cos(θ))
    λ2 = λ1 + math.atan2(
        math.sin(θ) * math.sin(δ) * math.cos(φ1),
        math.cos(δ) - math.sin(φ1) * math.sin(φ2),
    )
    return math.degrees(φ2), (math.degrees(λ2) + 540) % 360 - 180


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def age_minutes(now: datetime, then: datetime | None) -> float | None:
    if not then:
        return None
    return round((now - then).total_seconds() / 60.0, 1)


def meta_ages(meta: dict | None, now: datetime) -> dict[str, Any]:
    if not meta:
        return {}
    sources = meta.get("sources") or {}
    opera_t = parse_iso(meta.get("operaTime")) or parse_iso(
        (sources.get("opera") or {}).get("updatedAt")
    )
    wind_t = parse_iso((sources.get("wind") or {}).get("updatedAt"))
    form_t = parse_iso((sources.get("formation") or {}).get("updatedAt"))
    return {
        "operaAgeMin": age_minutes(now, opera_t),
        "windAgeMin": age_minutes(now, wind_t),
        "formationAgeMin": age_minutes(now, form_t),
        "operaTime": meta.get("operaTime"),
        "updatedAt": meta.get("updatedAt"),
    }


def sample_wind(grid: dict, lon: float, lat: float) -> tuple[float, float] | None:
    if not grid or not grid.get("u") or not grid.get("v"):
        return None
    west, south, east, north = grid["west"], grid["south"], grid["east"], grid["north"]
    cols, rows = grid["cols"], grid["rows"]
    if lon < west or lon > east or lat < south or lat > north:
        return None
    x = ((lon - west) / (east - west)) * (cols - 1)
    y = ((lat - south) / (north - south)) * (rows - 1)
    x0, y0 = int(x), int(y)
    x1, y1 = min(x0 + 1, cols - 1), min(y0 + 1, rows - 1)
    tx, ty = x - x0, y - y0

    def at(i: int, j: int) -> tuple[float, float]:
        idx = j * cols + i
        return float(grid["u"][idx]), float(grid["v"][idx])

    u00, v00 = at(x0, y0)
    u10, v10 = at(x1, y0)
    u01, v01 = at(x0, y1)
    u11, v11 = at(x1, y1)
    u = u00 * (1 - tx) * (1 - ty) + u10 * tx * (1 - ty) + u01 * (1 - tx) * ty + u11 * tx * ty
    v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    speed = math.hypot(u, v) * 3.6 * 0.9
    if speed < 1:
        return None
    hdg = (math.degrees(math.atan2(u, v)) + 360) % 360
    return hdg, max(6.0, min(75.0, speed))


def blend_steer(low: dict | None, upper: dict | None, lon: float, lat: float) -> tuple[float, float] | None:
    s_low = sample_wind(low, lon, lat) if low else None
    s_up = sample_wind(upper, lon, lat) if upper else None
    w850 = ACTIVE_CONSTANTS["WIND_BLEND_850"]
    w500 = ACTIVE_CONSTANTS["WIND_BLEND_500"]
    if s_low and s_up:
        r1, r2 = math.radians(s_low[0]), math.radians(s_up[0])
        u = w850 * math.sin(r1) * s_low[1] + w500 * math.sin(r2) * s_up[1]
        v = w850 * math.cos(r1) * s_low[1] + w500 * math.cos(r2) * s_up[1]
        return (math.degrees(math.atan2(u, v)) + 360) % 360, math.hypot(u, v)
    return s_up or s_low


def _ring_centroid(ring: list) -> tuple[float, float] | None:
    if not ring:
        return None
    xs = [float(p[0]) for p in ring if len(p) >= 2]
    ys = [float(p[1]) for p in ring if len(p) >= 2]
    if not xs:
        return None
    return sum(xs) / len(xs), sum(ys) / len(ys)


def feature_lon_lat(f: dict, props: dict) -> tuple[float, float] | None:
    hist = props.get("history") or []
    if hist:
        h = hist[-1]
        if h.get("peakLon") is not None and h.get("peakLat") is not None:
            return float(h["peakLon"]), float(h["peakLat"])
        if h.get("lon") is not None and h.get("lat") is not None:
            return float(h["lon"]), float(h["lat"])
    if props.get("birthLon") is not None and props.get("birthLat") is not None:
        return float(props["birthLon"]), float(props["birthLat"])
    geom = f.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None
    if gtype == "Point" and len(coords) >= 2:
        return float(coords[0]), float(coords[1])
    if gtype == "Polygon" and coords and coords[0]:
        return _ring_centroid(coords[0])
    if gtype == "MultiPolygon" and coords and coords[0] and coords[0][0]:
        return _ring_centroid(coords[0][0])
    return None


def hist_points(hist: list) -> list[dict]:
    out = []
    for h in hist:
        if h.get("peakLon") is not None:
            out.append(
                {
                    "lon": float(h["peakLon"]),
                    "lat": float(h["peakLat"]),
                    "maxDbz": h.get("maxDbz"),
                    "time": str(h.get("time") or "")[:14],
                }
            )
        elif h.get("lon") is not None:
            out.append(
                {
                    "lon": float(h["lon"]),
                    "lat": float(h["lat"]),
                    "maxDbz": h.get("maxDbz"),
                    "time": str(h.get("time") or "")[:14],
                }
            )
    return out


def observed_motion(hist: list[dict]) -> dict[str, Any]:
    """Ground-truth pohyb z historie peaků + jitter segmentů."""
    pts = hist_points(hist)
    if len(pts) < 2:
        return {"obsHdg": None, "obsSpd": None, "segmentJitterDeg": None, "segN": 0}
    segs: list[tuple[float, float]] = []
    for a, b in zip(pts[:-1], pts[1:]):
        ta, tb = parse_opera_time(a["time"]), parse_opera_time(b["time"])
        dt = 5.0
        if ta and tb:
            dt = max(1.0, (tb - ta).total_seconds() / 60.0)
        d = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        spd = (d / dt) * 60.0
        if 3 <= spd <= 90:
            segs.append((bearing_deg(a["lat"], a["lon"], b["lat"], b["lon"]), spd))
    jitter = None
    if len(segs) >= 2:
        jitter = round(angle_diff(segs[-2][0], segs[-1][0]), 1)
    a, b = pts[0], pts[-1]
    ta, tb = parse_opera_time(a["time"]), parse_opera_time(b["time"])
    dt = 5.0 * (len(pts) - 1)
    if ta and tb:
        dt = max(1.0, (tb - ta).total_seconds() / 60.0)
    d = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
    spd = (d / dt) * 60.0
    hdg = bearing_deg(a["lat"], a["lon"], b["lat"], b["lon"])
    if not (3 <= spd <= 90):
        if segs:
            return {
                "obsHdg": round(segs[-1][0], 1),
                "obsSpd": round(segs[-1][1], 1),
                "segmentJitterDeg": jitter,
                "segN": len(segs),
            }
        return {"obsHdg": None, "obsSpd": None, "segmentJitterDeg": jitter, "segN": len(segs)}
    return {
        "obsHdg": round(hdg, 1),
        "obsSpd": round(spd, 1),
        "segmentJitterDeg": jitter,
        "segN": len(segs),
    }


def dbz_trend(hist: list, current: float) -> dict[str, Any]:
    pts = hist_points(hist)
    vals = [float(p["maxDbz"]) for p in pts if p.get("maxDbz") is not None]
    vals.append(float(current))
    if len(vals) < 2:
        return {"dbzDelta5": None, "dbzDelta15": None, "dbzSlopePer15": None}
    d5 = round(vals[-1] - vals[-2], 1) if len(vals) >= 2 else None
    d15 = round(vals[-1] - vals[max(0, len(vals) - 4)], 1) if len(vals) >= 2 else None
    n = min(4, len(vals) - 1)
    slope = round((vals[-1] - vals[-1 - n]) * (15.0 / max(5.0, n * 5.0)), 2) if n else None
    return {"dbzDelta5": d5, "dbzDelta15": d15, "dbzSlopePer15": slope}


def nearest_env(lat: float, lon: float, points: list[dict], max_km: float = 40.0) -> dict | None:
    best = None
    best_d = max_km
    for p in points:
        d = haversine_km(lat, lon, float(p["lat"]), float(p["lon"]))
        if d < best_d:
            best_d = d
            best = p
    if not best:
        return None
    env = best.get("environment") or {}
    return {
        "envDistKm": round(best_d, 1),
        "cape": round(float(env.get("capeJkg") or 0), 1),
        "capeNow": round(float(env.get("capeNowJkg") or 0), 1),
        "dew": env.get("dewpointC"),
        "shear": round(float(env.get("shear0to6Ms") or 0), 2),
        "srh01": env.get("srh01"),
        "cooling": env.get("cloudTopCoolingCPer15min"),
        "coolingSource": env.get("coolingSource"),
        "li": env.get("liftedIndexC"),
        "freezingLevelM": env.get("freezingLevelM"),
        "cinJkg": env.get("convectiveInhibitionJkg"),
        "steerHdg": env.get("steerHeadingDeg"),
        "steerSpd": env.get("steerSpeedKmh"),
    }


def estimate_hail_cm_proxy(
    echo_top_km: float | None,
    max_dbz: float,
    freezing_level_m: float | None,
) -> float | None:
    """Zrcadlo scoreActive.estimateHailCm — pro learning samples."""
    if max_dbz < ACTIVE_CONSTANTS["HAIL_LIKELY_DBZ"]:
        return None
    if echo_top_km is None or echo_top_km < ACTIVE_CONSTANTS["HAIL_LIKELY_ECHO_TOP_KM"]:
        return None
    if freezing_level_m is not None and freezing_level_m > 0:
        excess = echo_top_km - freezing_level_m / 1000.0
        if excess < ACTIVE_CONSTANTS["HAIL_MIN_ABOVE_FZL_KM"]:
            return None
    cm = 1.0
    for min_km, step_cm in ((10, 1), (12, 2), (14, 4), (16, 5)):
        if echo_top_km >= min_km:
            cm = float(step_cm)
    return cm


def purple_candidate(
    cell: dict,
    env: dict | None,
    trend: dict,
) -> tuple[bool, str]:
    """
    Proxy „ukázali bychom fialovou“ — bez plného intensification.ts.
    Cíl: skórovat hit vs demise po kandidátovi.
    Kalibrace 2026-07-23: suppress growth ≥2 + alertScoreMin 50 (live UI).
    """
    growth = cell.get("growthDbz")
    if growth is not None and float(growth) < ACTIVE_CONSTANTS["INTENSIFY_SUPPRESS_GROWTH_DBZ"]:
        return False, "suppressed_decay"
    dbz = float(cell.get("maxDbz") or 0)
    if dbz < 40 or dbz >= 58:
        return False, "dbz_range"
    slope = float(trend.get("dbzSlopePer15") or 0)
    cape = float((env or {}).get("cape") or 0)
    shear = float((env or {}).get("shear") or 0)
    if slope < 0.5 and cape < 280:
        return False, "weak_fuel"
    if slope >= 2.0 or (cape >= 350 and shear >= 12) or cape >= 500:
        return True, "candidate"
    return False, "no_signal"


def track_error_components(
    start_lat: float,
    start_lon: float,
    pred_lat: float,
    pred_lon: float,
    act_lat: float,
    act_lon: float,
    heading: float,
) -> dict[str, float]:
    """errKm + along/cross-track vůči predikovanému směru."""
    err = haversine_km(pred_lat, pred_lon, act_lat, act_lon)
    # vektory ve approx km (east/north)
    def en(lat0: float, lon0: float, lat1: float, lon1: float) -> tuple[float, float]:
        east = haversine_km(lat0, lon0, lat0, lon1) * (1 if lon1 >= lon0 else -1)
        north = haversine_km(lat0, lon0, lat1, lon0) * (1 if lat1 >= lat0 else -1)
        return east, north

    pe, pn = en(start_lat, start_lon, pred_lat, pred_lon)
    ae, an = en(start_lat, start_lon, act_lat, act_lon)
    θ = math.radians(heading)
    # unit along = (sin θ east, cos θ north)
    ux, uy = math.sin(θ), math.cos(θ)
    pred_along = pe * ux + pn * uy
    act_along = ae * ux + an * uy
    act_cross = -ae * uy + an * ux
    return {
        "errKm": round(err, 2),
        "alongErrKm": round(act_along - pred_along, 2),
        "crossErrKm": round(act_cross, 2),
        "actAlongKm": round(act_along, 2),
        "predAlongKm": round(pred_along, 2),
    }


def cells_from_geojson(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    data = load_json(path)
    out = []
    for f in data.get("features") or []:
        props = f.get("properties") or {}
        if props.get("kind") not in ("cell", "peak"):
            continue
        pos = feature_lon_lat(f, props)
        if not pos:
            continue
        lon, lat = pos
        echo_top = props.get("echoTopKm")
        out.append(
            {
                "id": str(props.get("id") or props.get("cellId") or ""),
                "trackId": props.get("trackId"),
                "lon": float(lon),
                "lat": float(lat),
                "maxDbz": float(props.get("maxDbz") or 0),
                "trackHeadingDeg": props.get("trackHeadingDeg"),
                "trackSpeedKmh": props.get("trackSpeedKmh"),
                "birthDbz": props.get("birthDbz"),
                "birthLon": props.get("birthLon"),
                "birthLat": props.get("birthLat"),
                "trueBirth": bool(props.get("trueBirth", False)),
                "isNewborn": bool(props.get("isNewborn", False)),
                "ageMinutes": props.get("ageMinutes"),
                "growthDbz": props.get("growthDbz"),
                "areaPx": props.get("areaPx"),
                "historyMinutes": props.get("historyMinutes"),
                "time": str(props.get("time") or ""),
                "history": props.get("history") or [],
                # ČHMÚ / Fáze 2–3
                "chmiDbz": props.get("chmiDbz"),
                "surfaceDbz": props.get("chmiSurfaceDbz"),
                "echoTopKm": float(echo_top) if echo_top is not None else None,
                "echoTopSource": props.get("echoTopSource"),
                "dbzSource": props.get("dbzSource"),
                "fctAgree": props.get("chmiFctAgree"),
                "fctAngleDiffDeg": props.get("chmiFctAngleDiffDeg"),
                "fctHeadingDeg": props.get("chmiFctHeadingDeg"),
            }
        )
    return out


def load_archive_peaks() -> dict[str, list[dict]]:
    man = ARCHIVE_DIR / "manifest.json"
    if not man.is_file():
        return {}
    try:
        frames = load_json(man).get("frames") or []
    except (OSError, json.JSONDecodeError):
        return {}
    by_time: dict[str, list[dict]] = {}
    for fr in frames:
        t = str(fr.get("time") or "")
        path = ARCHIVE_DIR / f"peaks-{t}.json"
        if not path.is_file():
            continue
        try:
            slot = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        by_time[t] = slot.get("peaks") or []
    return by_time


def match_peak(lat: float, lon: float, peaks: list[dict], max_km: float = 25.0) -> dict | None:
    best = None
    best_d = max_km
    for p in peaks:
        d = haversine_km(lat, lon, float(p["lat"]), float(p["lon"]))
        if d < best_d:
            best_d = d
            best = {**p, "_matchKm": round(d, 2)}
    return best


def resolve_key(cell: dict, state_tracks: dict[str, Any]) -> str:
    lat, lon = cell["lat"], cell["lon"]
    for key, prev in state_tracks.items():
        d = haversine_km(lat, lon, float(prev["lat"]), float(prev["lon"]))
        if d <= 18:
            return key
    hist = cell.get("history") or []
    birth_ts = None
    if hist:
        birth_ts = str(hist[0].get("time") or "")[:14] or None
    if not birth_ts and cell.get("time"):
        birth_ts = str(cell["time"])[:14]
    blat, blon = lat, lon
    if hist:
        h0 = hist[0]
        if "peakLat" in h0:
            blat, blon = float(h0["peakLat"]), float(h0["peakLon"])
        elif "lat" in h0:
            blat, blon = float(h0["lat"]), float(h0["lon"])
    elif cell.get("birthLat") is not None:
        blat, blon = float(cell["birthLat"]), float(cell["birthLon"])
    return track_key(blat, blon, birth_ts)


def classify_demise(prev: dict, archive: dict[str, list[dict]], ts: str) -> str:
    """fade | exit | merge_or_jump | unknown"""
    last_dbz = float(prev.get("maxDbz") or 0)
    trend = prev.get("dbzSlopePer15")
    lat, lon = float(prev["lat"]), float(prev["lon"])
    # je poblíž ještě peak?
    near = False
    for peaks in archive.values():
        if match_peak(lat, lon, peaks, max_km=40.0):
            near = True
            break
    if last_dbz < 32 or (trend is not None and trend < -3):
        return "fade"
    if not near and (lon < 8 or lon > 22 or lat < 46 or lat > 53):
        return "exit"
    if near:
        return "merge_or_jump"
    return "unknown"


def emit() -> dict[str, int]:
    ensure_dir()
    now = datetime.now(timezone.utc)
    cells = cells_from_geojson(CELLS)
    meta = load_json(META) if META.is_file() else None
    ages = meta_ages(meta, now)

    meta_time = (meta or {}).get("operaTime")
    ts = None
    if cells and cells[0].get("time"):
        ts = str(cells[0]["time"])[:14]
    if not ts and meta_time:
        ts = str(meta_time).replace("-", "").replace(":", "").replace("T", "").replace("Z", "")[:14]
    if not ts:
        ts = now.strftime("%Y%m%d%H%M%S")

    low = load_json(WIND_LOW) if WIND_LOW.is_file() else None
    upper = load_json(WIND_UPPER) if WIND_UPPER.is_file() else None
    formation = load_json(FORMATION) if FORMATION.is_file() else None
    form_points = (formation or {}).get("points") or []
    archive = load_archive_peaks()
    state = load_state()
    prev_tracks: dict[str, Any] = state.get("tracks") or {}
    pending_form: dict[str, Any] = state.get("formationPending") or {}
    pending_intensity: dict[str, Any] = state.get("intensityPending") or {}
    pending_purple: dict[str, Any] = state.get("purplePending") or {}

    events: list[dict] = []
    samples: list[dict] = []
    new_tracks: dict[str, Any] = {}
    seen_keys: set[str] = set()
    run_meta = {
        "v": SCHEMA_VERSION,
        "ts": ts,
        "constants": ACTIVE_CONSTANTS,
        **ages,
    }

    # run marker — jeden řádek na běh (pro audit stáří dat)
    events.append({"kind": "run", **run_meta})

    for cell in cells:
        key = resolve_key(cell, prev_tracks)
        if key in seen_keys:
            key = track_key(cell["lat"], cell["lon"], ts)
        seen_keys.add(key)

        wind = blend_steer(low, upper, cell["lon"], cell["lat"])
        radar_h = cell.get("trackHeadingDeg")
        radar_s = cell.get("trackSpeedKmh")
        wind_h = wind[0] if wind else None
        wind_s = wind[1] if wind else None
        obs = observed_motion(cell.get("history") or [])
        trend = dbz_trend(cell.get("history") or [], cell["maxDbz"])
        env = nearest_env(cell["lat"], cell["lon"], form_points)

        # Preferuj observed motion z historie když pipeline heading chybí
        if obs["obsHdg"] is not None and radar_h is None:
            radar_h = obs["obsHdg"]
        if obs["obsSpd"] is not None and radar_s is None:
            radar_s = obs["obsSpd"]

        align = (
            round(angle_diff(float(radar_h), wind_h), 1)
            if radar_h is not None and wind_h is not None
            else None
        )
        motion_source = "wind-fallback"
        if (
            radar_h is not None
            and radar_s is not None
            and wind_h is not None
            and 5 <= float(radar_s) <= ACTIVE_CONSTANTS["MAX_TRUSTED_TRACK_KMH"]
            and align is not None
            and align <= ACTIVE_CONSTANTS["MAX_WIND_ALIGN_DEG"]
        ):
            motion_source = "radar-track"

        use_h = wind_h if wind_h is not None else (float(radar_h) if radar_h is not None else 90.0)
        use_s = wind_s if wind_s is not None else (float(radar_s) if radar_s is not None else 28.0)
        if motion_source == "radar-track" and radar_s is not None:
            use_s = 0.7 * float(radar_s) + 0.3 * use_s

        was = prev_tracks.get(key)
        is_new = was is None
        age_min = cell.get("ageMinutes")
        growth = cell.get("growthDbz")

        # --- BIRTH ---
        if is_new and (
            cell.get("trueBirth")
            or cell.get("isNewborn")
            or (age_min is not None and float(age_min) <= 15)
        ):
            birth_ev = {
                "kind": "birth",
                "trackKey": key,
                "cellId": cell["id"],
                "lat": round(cell["lat"], 4),
                "lon": round(cell["lon"], 4),
                "maxDbz": round(cell["maxDbz"], 1),
                "birthDbz": cell.get("birthDbz"),
                "growthDbz": growth,
                "trueBirth": cell.get("trueBirth"),
                "isNewborn": cell.get("isNewborn"),
                "ageMin": age_min,
                "areaPx": cell.get("areaPx"),
                "histN": len(cell.get("history") or []),
                **(env or {}),
                **ages,
            }
            events.append(birth_ev)
            # sample pro kalibraci prahů zrodu
            samples.append(
                {
                    "type": "birth_features",
                    "ts": ts,
                    "trackKey": key,
                    "birthDbz": cell.get("birthDbz"),
                    "growthDbz": growth,
                    "ageMin": age_min,
                    "maxDbz": round(cell["maxDbz"], 1),
                    "trueBirthLabel": cell.get("trueBirth"),
                    "isNewbornLabel": cell.get("isNewborn"),
                    "wouldTrueBirth": bool(
                        (cell.get("birthDbz") is not None)
                        and float(cell["birthDbz"]) <= ACTIVE_CONSTANTS["TRUE_BIRTH_MAX_DBZ"]
                        and (age_min is None or float(age_min) <= ACTIVE_CONSTANTS["TRUE_BIRTH_MAX_AGE_MIN"])
                    ),
                    **(env or {}),
                    **ages,
                }
            )

        # --- TRACK SAMPLE (každý snímek) ---
        fzl = (env or {}).get("freezingLevelM")
        hail_cm = estimate_hail_cm_proxy(
            cell.get("echoTopKm"),
            float(cell["maxDbz"]),
            float(fzl) if fzl is not None else None,
        )
        show_purple, purple_why = purple_candidate(cell, env, trend)
        events.append(
            {
                "kind": "track_sample",
                "trackKey": key,
                "cellId": cell["id"],
                "lat": round(cell["lat"], 4),
                "lon": round(cell["lon"], 4),
                "maxDbz": round(cell["maxDbz"], 1),
                "birthDbz": cell.get("birthDbz"),
                "growthDbz": growth,
                "areaPx": cell.get("areaPx"),
                "radarHdg": radar_h,
                "radarSpd": radar_s,
                "windHdg": round(wind_h, 1) if wind_h is not None else None,
                "windSpd": round(wind_s, 1) if wind_s is not None else None,
                "windAlignDeg": align,
                "obsHdg": obs["obsHdg"],
                "obsSpd": obs["obsSpd"],
                "segmentJitterDeg": obs["segmentJitterDeg"],
                "heading": round(use_h, 1),
                "speed": round(use_s, 1),
                "motionSource": motion_source,
                "ageMin": age_min,
                "histN": len(cell.get("history") or []),
                "surfaceDbz": cell.get("surfaceDbz"),
                "echoTopKm": cell.get("echoTopKm"),
                "chmiDbz": cell.get("chmiDbz"),
                "dbzSource": cell.get("dbzSource"),
                "fctAgree": cell.get("fctAgree"),
                "fctAngleDiffDeg": cell.get("fctAngleDiffDeg"),
                "fctHeadingDeg": cell.get("fctHeadingDeg"),
                "hailCmProxy": hail_cm,
                "purpleCandidate": show_purple,
                "purpleWhy": purple_why,
                **trend,
                **(env or {}),
                **ages,
            }
        )

        # --- VERIFY TRACK PREDICTIONS vs archive ---
        t0 = parse_opera_time(ts)
        if t0 and use_s >= 5:
            for horizon in (15, 30):
                pred_lat, pred_lon = destination(
                    cell["lat"], cell["lon"], use_h, (use_s * horizon) / 60.0
                )
                target = None
                best_dt = 8.0
                for at, peaks in archive.items():
                    at_dt = parse_opera_time(at)
                    if not at_dt:
                        continue
                    dt = (at_dt - t0).total_seconds() / 60.0
                    if abs(dt - horizon) < best_dt:
                        best_dt = abs(dt - horizon)
                        target = (at, peaks, dt)
                if not target:
                    continue
                _at, peaks, dt = target
                hit = match_peak(pred_lat, pred_lon, peaks, max_km=30.0)
                if not hit:
                    hit = match_peak(cell["lat"], cell["lon"], peaks, max_km=35.0)
                if hit:
                    comps = track_error_components(
                        cell["lat"],
                        cell["lon"],
                        pred_lat,
                        pred_lon,
                        float(hit["lat"]),
                        float(hit["lon"]),
                        use_h,
                    )
                    act_hdg = bearing_deg(
                        cell["lat"], cell["lon"], float(hit["lat"]), float(hit["lon"])
                    )
                    act_dist = haversine_km(
                        cell["lat"], cell["lon"], float(hit["lat"]), float(hit["lon"])
                    )
                    act_spd = (act_dist / max(1.0, abs(dt))) * 60.0
                    samples.append(
                        {
                            "type": "track",
                            "ts": ts,
                            "horizonMin": horizon,
                            "trackKey": key,
                            "predLat": round(pred_lat, 4),
                            "predLon": round(pred_lon, 4),
                            "actLat": round(float(hit["lat"]), 4),
                            "actLon": round(float(hit["lon"]), 4),
                            **comps,
                            "headingErrDeg": round(angle_diff(use_h, act_hdg), 1),
                            "speedErrKmh": round(act_spd - use_s, 1),
                            "actHdg": round(act_hdg, 1),
                            "actSpd": round(act_spd, 1),
                            "motionSource": motion_source,
                            "heading": round(use_h, 1),
                            "speed": round(use_s, 1),
                            "windAlignDeg": align,
                            "actDbz": hit.get("maxDbz"),
                            "dtMin": round(dt, 1),
                            "fctAgree": cell.get("fctAgree"),
                            "fctAngleDiffDeg": cell.get("fctAngleDiffDeg"),
                            "surfaceDbz": cell.get("surfaceDbz"),
                            **ages,
                        }
                    )

        # pending preds + intensity
        preds = {}
        for horizon in (15, 30):
            plat, plon = destination(
                cell["lat"], cell["lon"], use_h, (use_s * horizon) / 60.0
            )
            preds[str(horizon)] = {
                "predLat": round(plat, 4),
                "predLon": round(plon, 4),
                "fromTs": ts,
                "fromLat": round(cell["lat"], 4),
                "fromLon": round(cell["lon"], 4),
                "heading": round(use_h, 1),
                "speed": round(use_s, 1),
                "motionSource": motion_source,
                "windAlignDeg": align,
            }

        # intenzita + evolution: slope baseline + evolveDbzAt zrcadlo
        slope = trend.get("dbzSlopePer15") or 0.0
        for horizon in (15, 30):
            pred_dbz = round(cell["maxDbz"] + slope * (horizon / 15.0), 1)
            pred_evolve = round(
                evolve_dbz_pred(
                    float(cell["maxDbz"]),
                    float(horizon),
                    slope=slope,
                    growth=float(growth) if growth is not None else None,
                    will_intensify=bool(show_purple),
                ),
                1,
            )
            delta_evo = pred_evolve - float(cell["maxDbz"])
            pred_foot = _clamp(
                1.0 + delta_evo * ACTIVE_CONSTANTS["EVOLVE_FOOTPRINT_PER_DBZ"],
                0.94,
                1.08,
            )
            ikey = f"{key}:{horizon}:{ts}"
            pending_intensity[ikey] = {
                "trackKey": key,
                "horizonMin": horizon,
                "fromTs": ts,
                "fromDbz": cell["maxDbz"],
                "predDbz": pred_dbz,
                "predEvolveDbz": pred_evolve,
                "predFootprintScale": round(pred_foot, 3),
                "fromAreaPx": cell.get("areaPx"),
                "growthDbz": growth,
                "willIntensify": bool(show_purple),
                "slope": slope,
                "lat": cell["lat"],
                "lon": cell["lon"],
                "surfaceDbz": cell.get("surfaceDbz"),
                "echoTopKm": cell.get("echoTopKm"),
                "fctAgree": cell.get("fctAgree"),
                **(env or {}),
            }

        # fialová / zesílení — kandidát → ověř hit vs fade
        if show_purple:
            for horizon in (15, 30):
                pkey = f"purple:{key}:{horizon}:{ts}"
                pending_purple[pkey] = {
                    "trackKey": key,
                    "horizonMin": horizon,
                    "fromTs": ts,
                    "fromDbz": cell["maxDbz"],
                    "growthDbz": growth,
                    "slope": slope,
                    "lat": cell["lat"],
                    "lon": cell["lon"],
                    "why": purple_why,
                    **(env or {}),
                }

        new_tracks[key] = {
            "lat": cell["lat"],
            "lon": cell["lon"],
            "maxDbz": cell["maxDbz"],
            "lastTs": ts,
            "cellId": cell["id"],
            "firstTs": (was or {}).get("firstTs") or ts,
            "preds": preds,
            "dbzSlopePer15": slope,
            "areaPx": cell.get("areaPx"),
            "growthDbz": growth,
            "surfaceDbz": cell.get("surfaceDbz"),
            "fctAgree": cell.get("fctAgree"),
            "fctAngleDiffDeg": cell.get("fctAngleDiffDeg"),
            "hailCmProxy": hail_cm,
            "purpleCandidate": show_purple,
            **trend,
        }

    # --- DEMISE ---
    for key, prev in prev_tracks.items():
        if key in new_tracks:
            continue
        first = parse_opera_time(str(prev.get("firstTs") or ""))
        last = parse_opera_time(str(prev.get("lastTs") or ""))
        life = None
        if first and last:
            life = max(0, int((last - first).total_seconds() / 60))
        reason = classify_demise(prev, archive, ts)
        events.append(
            {
                "kind": "demise",
                "trackKey": key,
                "cellId": prev.get("cellId"),
                "lat": round(float(prev["lat"]), 4),
                "lon": round(float(prev["lon"]), 4),
                "maxDbz": prev.get("maxDbz"),
                "lastSeenTs": prev.get("lastTs"),
                "firstTs": prev.get("firstTs"),
                "lifeMin": life,
                "demiseReason": reason,
                "dbzSlopePer15": prev.get("dbzSlopePer15"),
                "dbzDelta5": prev.get("dbzDelta5"),
                "areaPx": prev.get("areaPx"),
                **ages,
            }
        )
        samples.append(
            {
                "type": "demise",
                "ts": prev.get("lastTs"),
                "trackKey": key,
                "lifeMin": life,
                "lastDbz": prev.get("maxDbz"),
                "demiseReason": reason,
                "dbzSlopePer15": prev.get("dbzSlopePer15"),
                "surfaceDbz": prev.get("surfaceDbz"),
                "fctAgree": prev.get("fctAgree"),
                "hailCmProxy": prev.get("hailCmProxy"),
                "purpleCandidate": prev.get("purpleCandidate"),
                "verifiedAt": ts,
                **ages,
            }
        )
        for h, pred in (prev.get("preds") or {}).items():
            from_ts = parse_opera_time(str(pred.get("fromTs") or ""))
            if not from_ts:
                continue
            horizon = int(h)
            target_peaks = None
            actual_dt = None
            for at, peaks in archive.items():
                at_dt = parse_opera_time(at)
                if not at_dt:
                    continue
                dt = (at_dt - from_ts).total_seconds() / 60.0
                if abs(dt - horizon) <= 7:
                    target_peaks = peaks
                    actual_dt = dt
                    break
            if target_peaks is None:
                continue
            hit = match_peak(
                float(pred["predLat"]), float(pred["predLon"]), target_peaks, max_km=30.0
            )
            if hit:
                start_lat = float(pred.get("fromLat") or prev["lat"])
                start_lon = float(pred.get("fromLon") or prev["lon"])
                comps = track_error_components(
                    start_lat,
                    start_lon,
                    float(pred["predLat"]),
                    float(pred["predLon"]),
                    float(hit["lat"]),
                    float(hit["lon"]),
                    float(pred.get("heading") or 90),
                )
                samples.append(
                    {
                        "type": "track",
                        "ts": pred.get("fromTs"),
                        "horizonMin": horizon,
                        "trackKey": key,
                        "predLat": pred["predLat"],
                        "predLon": pred["predLon"],
                        "actLat": round(float(hit["lat"]), 4),
                        "actLon": round(float(hit["lon"]), 4),
                        **comps,
                        "motionSource": pred.get("motionSource"),
                        "heading": pred.get("heading"),
                        "speed": pred.get("speed"),
                        "windAlignDeg": pred.get("windAlignDeg"),
                        "verifiedAt": ts,
                        "dtMin": round(actual_dt, 1) if actual_dt is not None else None,
                        "via": "demise_pending",
                        **ages,
                    }
                )

    # --- INTENSITY VERIFY ---
    still_intensity: dict[str, Any] = {}
    t_now = parse_opera_time(ts)
    for ikey, pend in pending_intensity.items():
        from_ts = parse_opera_time(str(pend.get("fromTs") or ""))
        if not from_ts or not t_now:
            continue
        age = (t_now - from_ts).total_seconds() / 60.0
        horizon = int(pend.get("horizonMin") or 15)
        if age < horizon - 4:
            still_intensity[ikey] = pend
            continue
        if age > horizon + 12:
            continue  # expired
        # najdi aktuální track poblíž
        hit_dbz = None
        for cell in cells:
            d = haversine_km(pend["lat"], pend["lon"], cell["lat"], cell["lon"])
            if d <= 25:
                hit_dbz = cell["maxDbz"]
                break
        if hit_dbz is None:
            # zkus archive
            for at, peaks in archive.items():
                at_dt = parse_opera_time(at)
                if not at_dt:
                    continue
                if abs((at_dt - from_ts).total_seconds() / 60.0 - horizon) <= 6:
                    hit = match_peak(pend["lat"], pend["lon"], peaks, max_km=25.0)
                    if hit and hit.get("maxDbz") is not None:
                        hit_dbz = float(hit["maxDbz"])
                    break
        if hit_dbz is not None:
            pred_evo = pend.get("predEvolveDbz")
            if pred_evo is None:
                pred_evo = pend.get("predDbz")
            err_evo = round(float(hit_dbz) - float(pred_evo or 0), 1)
            act_area = None
            for cell in cells:
                d = haversine_km(pend["lat"], pend["lon"], cell["lat"], cell["lon"])
                if d <= 25 and cell.get("areaPx") is not None:
                    act_area = cell.get("areaPx")
                    break
            from_area = pend.get("fromAreaPx")
            area_ratio = None
            if (
                act_area is not None
                and from_area is not None
                and float(from_area) > 0
            ):
                area_ratio = round(float(act_area) / float(from_area), 3)
            samples.append(
                {
                    "type": "intensity",
                    "ts": pend.get("fromTs"),
                    "horizonMin": horizon,
                    "trackKey": pend.get("trackKey"),
                    "fromDbz": pend.get("fromDbz"),
                    "predDbz": pend.get("predDbz"),
                    "predEvolveDbz": pred_evo,
                    "predFootprintScale": pend.get("predFootprintScale"),
                    "actDbz": hit_dbz,
                    "errDbz": round(float(hit_dbz) - float(pend.get("predDbz") or 0), 1),
                    "errEvolveDbz": err_evo,
                    "fromAreaPx": from_area,
                    "actAreaPx": act_area,
                    "areaRatio": area_ratio,
                    "growthDbz": pend.get("growthDbz"),
                    "willIntensify": pend.get("willIntensify"),
                    "slope": pend.get("slope"),
                    "cape": pend.get("cape"),
                    "shear": pend.get("shear"),
                    "verifiedAt": ts,
                    **ages,
                }
            )
        else:
            still_intensity[ikey] = pend

    # --- PURPLE / INTENSIFY VERIFY (hit vs fade) ---
    still_purple: dict[str, Any] = {}
    for pkey, pend in pending_purple.items():
        from_ts = parse_opera_time(str(pend.get("fromTs") or ""))
        if not from_ts or not t_now:
            continue
        age = (t_now - from_ts).total_seconds() / 60.0
        horizon = int(pend.get("horizonMin") or 15)
        if age < horizon - 4:
            still_purple[pkey] = pend
            continue
        if age > horizon + 12:
            # expired without match → treat as miss (bouřka zmizela / nezesílila)
            samples.append(
                {
                    "type": "intensify",
                    "ts": pend.get("fromTs"),
                    "horizonMin": horizon,
                    "trackKey": pend.get("trackKey"),
                    "fromDbz": pend.get("fromDbz"),
                    "actDbz": None,
                    "hitIntensify": False,
                    "outcome": "expired_or_gone",
                    "growthDbz": pend.get("growthDbz"),
                    "slope": pend.get("slope"),
                    "cape": pend.get("cape"),
                    "shear": pend.get("shear"),
                    "why": pend.get("why"),
                    "verifiedAt": ts,
                    **ages,
                }
            )
            continue
        hit_dbz = None
        for cell in cells:
            d = haversine_km(pend["lat"], pend["lon"], cell["lat"], cell["lon"])
            if d <= 25:
                hit_dbz = cell["maxDbz"]
                break
        if hit_dbz is None:
            for at, peaks in archive.items():
                at_dt = parse_opera_time(at)
                if not at_dt:
                    continue
                if abs((at_dt - from_ts).total_seconds() / 60.0 - horizon) <= 6:
                    hit = match_peak(pend["lat"], pend["lon"], peaks, max_km=25.0)
                    if hit and hit.get("maxDbz") is not None:
                        hit_dbz = float(hit["maxDbz"])
                    break
        if hit_dbz is not None:
            delta = float(hit_dbz) - float(pend.get("fromDbz") or 0)
            hit_ok = delta >= ACTIVE_CONSTANTS["INTENSIFY_HIT_DBZ"]
            samples.append(
                {
                    "type": "intensify",
                    "ts": pend.get("fromTs"),
                    "horizonMin": horizon,
                    "trackKey": pend.get("trackKey"),
                    "fromDbz": pend.get("fromDbz"),
                    "actDbz": hit_dbz,
                    "deltaDbz": round(delta, 1),
                    "hitIntensify": hit_ok,
                    "outcome": "intensified" if hit_ok else "flat_or_weakened",
                    "growthDbz": pend.get("growthDbz"),
                    "slope": pend.get("slope"),
                    "cape": pend.get("cape"),
                    "shear": pend.get("shear"),
                    "why": pend.get("why"),
                    "verifiedAt": ts,
                    **ages,
                }
            )
        else:
            still_purple[pkey] = pend

    # --- FORMATION ---
    for p in form_points:
        env = p.get("environment") or {}
        cape = float(env.get("capeJkg") or 0)
        shear = float(env.get("shear0to6Ms") or env.get("shearMs") or 0)
        score = min(100.0, cape / 20.0 + shear * 3.0)
        if score < ACTIVE_CONSTANTS["MIN_ZONE_SCORE"]:
            continue
        lat, lon = float(p["lat"]), float(p["lon"])
        zid = f"z:{lat:.2f}:{lon:.2f}"
        events.append(
            {
                "kind": "formation_zone",
                "zoneId": zid,
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "score": round(score, 1),
                "cape": round(cape, 1),
                "capeNow": round(float(env.get("capeNowJkg") or 0), 1),
                "shear": round(shear, 2),
                "dew": env.get("dewpointC"),
                "li": env.get("liftedIndexC"),
                "cooling": env.get("cloudTopCoolingCPer15min"),
                "coolingSource": env.get("coolingSource"),
                "srh01": env.get("srh01"),
                "freezingLevelM": env.get("freezingLevelM"),
                "cinJkg": env.get("convectiveInhibitionJkg"),
                **ages,
            }
        )
        if zid not in pending_form:
            pending_form[zid] = {
                "lat": lat,
                "lon": lon,
                "score": score,
                "fromTs": ts,
                "cape": cape,
                "shear": shear,
                "dew": env.get("dewpointC"),
                "li": env.get("liftedIndexC"),
                "cooling": env.get("cloudTopCoolingCPer15min"),
                "coolingSource": env.get("coolingSource"),
                "freezingLevelM": env.get("freezingLevelM"),
                "cinJkg": env.get("convectiveInhibitionJkg"),
            }

    still_pending: dict[str, Any] = {}
    for zid, zone in pending_form.items():
        from_ts = parse_opera_time(str(zone.get("fromTs") or ""))
        now_ts = parse_opera_time(ts)
        if from_ts and now_ts:
            age = (now_ts - from_ts).total_seconds() / 60.0
            if age > ACTIVE_CONSTANTS["FORMATION_TIMEOUT_MIN"]:
                samples.append(
                    {
                        "type": "formation",
                        "ts": zone.get("fromTs"),
                        "zoneId": zid,
                        "score": zone.get("score"),
                        "cape": zone.get("cape"),
                        "shear": zone.get("shear"),
                        "dew": zone.get("dew"),
                        "li": zone.get("li"),
                        "cooling": zone.get("cooling"),
                        "coolingSource": zone.get("coolingSource"),
                        "freezingLevelM": zone.get("freezingLevelM"),
                        "cinJkg": zone.get("cinJkg"),
                        "leadMin": round(age, 1),
                        "hit": False,
                        "verifiedAt": ts,
                        **ages,
                    }
                )
                continue
            if age < 20:
                still_pending[zid] = zone
                continue
        hit_cell = None
        for cell in cells:
            if not (
                cell.get("trueBirth")
                or cell.get("isNewborn")
                or (cell.get("ageMinutes") or 99) <= 15
            ):
                continue
            d = haversine_km(zone["lat"], zone["lon"], cell["lat"], cell["lon"])
            if d <= ACTIVE_CONSTANTS["FORMATION_HIT_KM"]:
                hit_cell = (cell, d)
                break
        if hit_cell:
            cell, dist = hit_cell
            lead = None
            if from_ts and now_ts:
                lead = round((now_ts - from_ts).total_seconds() / 60.0, 1)
            events.append(
                {
                    "kind": "formation_hit",
                    "zoneId": zid,
                    "lat": round(cell["lat"], 4),
                    "lon": round(cell["lon"], 4),
                    "distKm": round(dist, 1),
                    "hitDbz": cell["maxDbz"],
                    "birthDbz": cell.get("birthDbz"),
                    "leadMin": lead,
                    **ages,
                }
            )
            samples.append(
                {
                    "type": "formation",
                    "ts": zone.get("fromTs"),
                    "zoneId": zid,
                    "score": zone.get("score"),
                    "cape": zone.get("cape"),
                    "shear": zone.get("shear"),
                    "dew": zone.get("dew"),
                    "li": zone.get("li"),
                    "cooling": zone.get("cooling"),
                    "coolingSource": zone.get("coolingSource"),
                    "freezingLevelM": zone.get("freezingLevelM"),
                    "cinJkg": zone.get("cinJkg"),
                    "leadMin": lead,
                    "hit": True,
                    "distKm": round(dist, 1),
                    "hitDbz": cell["maxDbz"],
                    "birthDbz": cell.get("birthDbz"),
                    "verifiedAt": ts,
                    **ages,
                }
            )
        else:
            still_pending[zid] = zone

    # limituj pending intensity / purple (max ~2000)
    if len(still_intensity) > 2000:
        keys = sorted(still_intensity.keys())[-2000:]
        still_intensity = {k: still_intensity[k] for k in keys}
    if len(still_purple) > 1500:
        keys = sorted(still_purple.keys())[-1500:]
        still_purple = {k: still_purple[k] for k in keys}

    n_ev = append_jsonl(events_path(now), events)
    n_sa = append_jsonl(samples_path(now), samples)
    save_state(
        {
            "tracks": new_tracks,
            "formationPending": still_pending,
            "intensityPending": still_intensity,
            "purplePending": still_purple,
            "lastConstants": ACTIVE_CONSTANTS,
            "schemaVersion": SCHEMA_VERSION,
        }
    )

    stats = {
        "events": n_ev,
        "samples": n_sa,
        "tracksLive": len(new_tracks),
        "eventsFile": count_lines(events_path(now)),
        "samplesFile": count_lines(samples_path(now)),
    }
    print(
        f"Learning: +{n_ev} events, +{n_sa} samples "
        f"(file totals events={stats['eventsFile']} samples={stats['samplesFile']}, "
        f"live tracks={stats['tracksLive']})",
        flush=True,
    )
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit learning events/samples")
    parser.parse_args()
    try:
        emit()
        return 0
    except Exception as e:
        print(f"Learning emit failed: {e}", flush=True)
        import traceback

        traceback.print_exc()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
