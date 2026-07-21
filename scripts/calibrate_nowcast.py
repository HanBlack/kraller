"""
Backtest nowcastu proti OPERA historii / archive.

Měří:
  A) Track skill — predikce pozice T+15 / T+30 vs reálný peak
  B) ETA skill — syntetická adresa na trase vs skutečný příjezd
  C) Formation skill — zóny Vznik vs nové slabé echo v okolí

Výstup: public/data/calibration/last_report.json
"""

from __future__ import annotations

import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MAX_TRUSTED_TRACK_KMH = 70
FAST_TRACK_KMH = 32
MAX_WIND_CONFLICT_DEG = 55
SOFT_WIND_CONFLICT_DEG = 28
MAX_SEGMENT_JITTER_DEG = 55
MIN_ZONE_SCORE = 32
FORMATION_HIT_KM = 35
ETA_ARRIVAL_KM = 6
APPROACH_COS_MIN = 0.24


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δλ = math.radians(lon2 - lon1)
    y = math.sin(Δλ) * math.cos(φ2)
    x = math.cos(φ1) * math.sin(φ2) - math.sin(φ1) * math.cos(φ2) * math.cos(Δλ)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff_deg(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


def destination_point(
    lat: float, lon: float, bearing: float, dist_km: float
) -> tuple[float, float]:
    r = 6371.0
    δ = dist_km / r
    θ = math.radians(bearing)
    φ1 = math.radians(lat)
    λ1 = math.radians(lon)
    φ2 = math.asin(math.sin(φ1) * math.cos(δ) + math.cos(φ1) * math.sin(δ) * math.cos(θ))
    λ2 = λ1 + math.atan2(
        math.sin(θ) * math.sin(δ) * math.cos(φ1),
        math.cos(δ) - math.sin(φ1) * math.sin(φ2),
    )
    return math.degrees(φ2), ((math.degrees(λ2) + 540) % 360) - 180


def parse_opera_time(s: str) -> datetime:
    return datetime.strptime(s, "%Y%m%d%H%M%S")


def median_or_none(vals: list[float]) -> float | None:
    if not vals:
        return None
    return round(statistics.median(vals), 2)


def pct_under(vals: list[float], thresh: float) -> float | None:
    if not vals:
        return None
    return round(100.0 * sum(1 for v in vals if v <= thresh) / len(vals), 1)


def recent_radar_motion(hist: list[dict]) -> tuple[float, float] | None:
    """heading, speed from last 2–3 points; require segment agreement."""
    if len(hist) < 2:
        return None
    recent = hist[-3:] if len(hist) >= 3 else hist

    def seg(a: dict, b: dict) -> tuple[float, float] | None:
        dt_min = max(
            1.0,
            (parse_opera_time(b["time"]) - parse_opera_time(a["time"])).total_seconds()
            / 60.0,
        )
        dist = haversine_km(a["peakLat"], a["peakLon"], b["peakLat"], b["peakLon"])
        speed = (dist / dt_min) * 60.0
        if not math.isfinite(speed) or speed < 5 or speed > MAX_TRUSTED_TRACK_KMH:
            return None
        hdg = bearing_deg(a["peakLat"], a["peakLon"], b["peakLat"], b["peakLon"])
        return hdg, speed

    if len(recent) >= 3:
        s1 = seg(recent[0], recent[1])
        s2 = seg(recent[1], recent[2])
        if not s1 or not s2:
            return None
        if angle_diff_deg(s1[0], s2[0]) > MAX_SEGMENT_JITTER_DEG:
            return None

    return seg(recent[0], recent[-1])


def resolve_motion(
    hist_prefix: list[dict],
    fallback_hdg: float | None,
    fallback_spd: float | None,
    wind_hdg: float | None,
    wind_spd: float | None,
) -> tuple[float, float, str]:
    """Směr vždy z větru; radar jen na rychlost při shodě směru."""
    from_hist = recent_radar_motion(hist_prefix)
    radar_h = from_hist[0] if from_hist else fallback_hdg
    radar_s = from_hist[1] if from_hist else fallback_spd
    steer_h = wind_hdg if wind_hdg is not None else 90.0
    steer_s = wind_spd if wind_spd is not None else 28.0

    has_radar = (
        radar_h is not None
        and radar_s is not None
        and 5 <= radar_s <= MAX_TRUSTED_TRACK_KMH
        and angle_diff_deg(radar_h, steer_h) <= SOFT_WIND_CONFLICT_DEG
    )
    if has_radar:
        speed = min(58.0, max(8.0, 0.7 * radar_s + 0.3 * steer_s))
        return steer_h, speed, "radar-track"
    return steer_h, steer_s, "wind-fallback"


def sample_wind_steer(lon: float, lat: float, wind: dict | None) -> tuple[float, float] | None:
    if not wind or not wind.get("u") or not wind.get("v"):
        return None
    west, south, east, north = wind["west"], wind["south"], wind["east"], wind["north"]
    cols, rows = wind["cols"], wind["rows"]
    if lon < west or lon > east or lat < south or lat > north:
        return None
    x = ((lon - west) / (east - west)) * (cols - 1)
    y = ((lat - south) / (north - south)) * (rows - 1)
    x0, y0 = int(x), int(y)
    x1, y1 = min(x0 + 1, cols - 1), min(y0 + 1, rows - 1)
    tx, ty = x - x0, y - y0

    def at(i: int, j: int) -> tuple[float, float]:
        idx = j * cols + i
        return float(wind["u"][idx]), float(wind["v"][idx])

    u00, v00 = at(x0, y0)
    u10, v10 = at(x1, y0)
    u01, v01 = at(x0, y1)
    u11, v11 = at(x1, y1)
    u = u00 * (1 - tx) * (1 - ty) + u10 * tx * (1 - ty) + u01 * (1 - tx) * ty + u11 * tx * ty
    v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    speed_ms = math.hypot(u, v)
    if speed_ms < 0.1:
        return None
    hdg = (math.degrees(math.atan2(u, v)) + 360) % 360
    return hdg, speed_ms * 3.6


def blend_steering_grids(low: dict | None, upper: dict | None) -> dict | None:
    if not low or not upper:
        return low or upper
    if len(low.get("u", [])) != len(upper.get("u", [])):
        return low
    u = [0.35 * a + 0.65 * b for a, b in zip(low["u"], upper["u"])]
    v = [0.35 * a + 0.65 * b for a, b in zip(low["v"], upper["v"])]
    out = dict(low)
    out["u"] = u
    out["v"] = v
    out["level"] = "steer"
    return out


def estimate_eta_min(dist_km: float, speed_kmh: float, approach_angle_deg: float) -> float | None:
    max_eta = 75
    if dist_km <= 15:
        speed = max(speed_kmh, 12) * 1.15
        return round(((dist_km / speed) * 60) / 5) * 5
    approach = math.cos(math.radians(approach_angle_deg))
    if approach <= 0.24:
        return None
    closing = speed_kmh * approach * 1.2
    if closing < 5:
        return None
    minutes = (dist_km / closing) * 60
    if minutes < 0 or minutes > max_eta:
        return None
    return round(minutes / 5) * 5


def cell_features(cells_fc: dict) -> list[dict]:
    return [
        f
        for f in cells_fc.get("features", [])
        if (f.get("properties") or {}).get("kind") == "cell"
    ]


def hist_as_peaks(hist: list[dict]) -> list[dict]:
    return [
        {
            "time": h["time"],
            "peakLon": h["peakLon"],
            "peakLat": h["peakLat"],
            "maxDbz": h.get("maxDbz"),
        }
        for h in hist
        if "peakLon" in h and "peakLat" in h and "time" in h
    ]


def calibrate_tracks(
    cells: list[dict], steer_grid: dict | None, horizons: tuple[int, ...] = (10, 15, 20, 30)
) -> dict:
    errors: dict[int, list[float]] = {h: [] for h in horizons}
    sources: dict[str, int] = {}

    for feat in cells:
        p = feat["properties"]
        hist = hist_as_peaks(p.get("history") or [])
        if len(hist) < 4:
            continue
        # Pro každý index i (s dostatkem minulosti) predikuj budoucnost v historii
        for i in range(2, len(hist) - 1):
            prefix = hist[: i + 1]
            cur = hist[i]
            t0 = parse_opera_time(cur["time"])
            wind = sample_wind_steer(cur["peakLon"], cur["peakLat"], steer_grid)
            wh, ws = (wind if wind else (None, None))
            hdg, spd, src = resolve_motion(
                prefix,
                p.get("trackHeadingDeg"),
                p.get("trackSpeedKmh"),
                wh,
                ws,
            )
            sources[src] = sources.get(src, 0) + 1
            for h in horizons:
                target_t = t0.timestamp() + h * 60
                # najdi hist bod nejblíž target
                best = None
                best_dt = 1e9
                for later in hist[i + 1 :]:
                    dt = abs(parse_opera_time(later["time"]).timestamp() - target_t)
                    if dt < best_dt:
                        best_dt = dt
                        best = later
                if best is None or best_dt > 8 * 60:
                    continue
                pred_lat, pred_lon = destination_point(
                    cur["peakLat"], cur["peakLon"], hdg, spd * (h / 60.0)
                )
                err = haversine_km(pred_lat, pred_lon, best["peakLat"], best["peakLon"])
                errors[h].append(err)

    out = {"samples": {}, "medianKm": {}, "pctUnder15km": {}, "pctUnder25km": {}, "sources": sources}
    for h, vals in errors.items():
        out["samples"][str(h)] = len(vals)
        out["medianKm"][str(h)] = median_or_none(vals)
        out["pctUnder15km"][str(h)] = pct_under(vals, 15)
        out["pctUnder25km"][str(h)] = pct_under(vals, 25)
    return out


def calibrate_eta(cells: list[dict], steer_grid: dict | None) -> dict:
    """Syntetický uživatel po směru pohybu; porovnej predikci vs skutečný čas."""
    abs_err: list[float] = []
    bias: list[float] = []  # pred - actual (kladné = pozdě)

    for feat in cells:
        p = feat["properties"]
        hist = hist_as_peaks(p.get("history") or [])
        if len(hist) < 3:
            continue
        for i in range(1, len(hist) - 1):
            prefix = hist[: i + 1]
            cur = hist[i]
            wind = sample_wind_steer(cur["peakLon"], cur["peakLat"], steer_grid)
            wh, ws = (wind if wind else (None, None))
            hdg, spd, _ = resolve_motion(
                prefix,
                p.get("trackHeadingDeg"),
                p.get("trackSpeedKmh"),
                wh,
                ws,
            )
            if spd < 8:
                continue
            # Zkus několik vzdáleností — krátká historie stačí na 10–20 km
            for ahead_km in (10.0, 15.0, 20.0, 25.0):
                user_lat, user_lon = destination_point(
                    cur["peakLat"], cur["peakLon"], hdg, ahead_km
                )
                dist = haversine_km(cur["peakLat"], cur["peakLon"], user_lat, user_lon)
                to_user = bearing_deg(cur["peakLat"], cur["peakLon"], user_lat, user_lon)
                approach_ang = angle_diff_deg(hdg, to_user)
                pred = estimate_eta_min(dist, spd, approach_ang)
                if pred is None:
                    continue
                t0 = parse_opera_time(cur["time"])
                actual = None
                for later in hist[i + 1 :]:
                    d = haversine_km(later["peakLat"], later["peakLon"], user_lat, user_lon)
                    if d <= ETA_ARRIVAL_KM:
                        actual = (
                            parse_opera_time(later["time"]) - t0
                        ).total_seconds() / 60.0
                        break
                if actual is None or actual <= 0:
                    continue
                abs_err.append(abs(pred - actual))
                bias.append(pred - actual)

    return {
        "samples": len(abs_err),
        "medianAbsErrMin": median_or_none(abs_err),
        "medianBiasMin": median_or_none(bias),
    }


def simple_formation_score(env: dict) -> float:
    """Lehká proxy skóre (ne plný TS scoreFormation)."""
    cape = float(env.get("capeJkg") or 0)
    dew = float(env.get("dewpointC") if env.get("dewpointC") is not None else -40)
    shear = float(env.get("shear0to6Ms") or 0)
    li = env.get("liftedIndexC")
    li_v = float(li) if li is not None else 2.0
    if dew < 11 or cape < 25:
        return 0.0
    score = 0.0
    score += min(40.0, cape / 40.0)  # ~40 při 1600
    score += min(20.0, max(0.0, dew - 10) * 2.5)
    score += min(20.0, shear * 1.2)
    if li_v <= 0:
        score += min(15.0, -li_v * 4)
    return score


def calibrate_formation(grid: dict, cells: list[dict], archive_slots: list[dict]) -> dict:
    """
    Precision zón: body se score≥práh — hit pokud do ~90 min (archive nebo trueBirth buňky)
    vznikne slabé echo v okolí.
    """
    points = grid.get("points") or []
    candidates = []
    for p in points:
        env = p.get("environment") or {}
        sc = simple_formation_score(env)
        if sc < MIN_ZONE_SCORE:
            continue
        # viability-ish
        if float(env.get("capeJkg") or 0) < 25:
            continue
        candidates.append({"lat": p["lat"], "lon": p["lon"], "score": sc})

    # cluster na ~20 km — jen centra
    candidates.sort(key=lambda x: -x["score"])
    zones = []
    used = [False] * len(candidates)
    for i, c in enumerate(candidates):
        if used[i]:
            continue
        used[i] = True
        zones.append(c)
        for j in range(i + 1, len(candidates)):
            if used[j]:
                continue
            if (
                haversine_km(c["lat"], c["lon"], candidates[j]["lat"], candidates[j]["lon"])
                <= 20
            ):
                used[j] = True
        if len(zones) >= 12:
            break

    # cílové peaky: trueBirth / newborn / slabé nové z archive
    target_peaks: list[tuple[float, float]] = []
    for feat in cells:
        p = feat["properties"]
        if p.get("trueBirth") or p.get("isNewborn") or float(p.get("birthDbz") or 99) <= 38:
            # peak z geometrie polygonu — použij history last nebo centroid
            hist = p.get("history") or []
            if hist:
                target_peaks.append((hist[-1]["peakLat"], hist[-1]["peakLon"]))
            geom = feat.get("geometry") or {}
            if geom.get("type") == "Polygon":
                # skip heavy — history enough
                pass

    for slot in archive_slots:
        for pk in slot.get("peaks") or []:
            if pk.get("trueBirth") or pk.get("isNewborn") or float(pk.get("birthDbz") or 99) <= 38:
                target_peaks.append((pk["lat"], pk["lon"]))
            # také všechna peaky v pozdějších slotách jako „echo vzniklo“
            if float(pk.get("maxDbz") or 0) >= 30:
                target_peaks.append((pk["lat"], pk["lon"]))

    hits = 0
    for z in zones:
        ok = False
        for lat, lon in target_peaks:
            if haversine_km(z["lat"], z["lon"], lat, lon) <= FORMATION_HIT_KM:
                ok = True
                break
        if ok:
            hits += 1

    precision = round(100.0 * hits / len(zones), 1) if zones else None
    return {
        "zones": len(zones),
        "hits": hits,
        "precisionPct": precision,
        "targetPeaks": len(target_peaks),
        "note": "precision = podíl zón s echem ≤35 km (archive+trueBirth)",
    }


def load_archive_slots(archive_dir: Path, limit: int = 36) -> list[dict]:
    man_path = archive_dir / "manifest.json"
    if not man_path.is_file():
        return []
    man = load_json(man_path)
    frames = man.get("frames") or []
    slots = []
    for fr in frames[-limit:]:
        rel = fr.get("path") or ""
        # path like data/opera/archive/peaks-….json
        name = Path(rel).name if rel else ""
        path = archive_dir / name
        if path.is_file():
            slots.append(load_json(path))
    return slots


def suggest_tweaks(report: dict) -> list[dict]:
    """Doporučení úprav konstant podle metrik."""
    tips: list[dict] = []
    track = report.get("track") or {}
    med30 = (track.get("medianKm") or {}).get("30")
    if med30 is not None and med30 > 20:
        tips.append(
            {
                "area": "track",
                "issue": f"T+30 medián {med30} km > 20",
                "action": "více věřit recent radar / přísnější wind conflict",
            }
        )
    eta = report.get("eta") or {}
    med_eta = eta.get("medianAbsErrMin")
    bias = eta.get("medianBiasMin")
    if med_eta is not None and med_eta > 15:
        tips.append(
            {
                "area": "eta",
                "issue": f"|ETA| medián {med_eta} min > 15",
                "action": "přísnější approach / closing min",
            }
        )
    if bias is not None and bias > 12:
        tips.append(
            {
                "area": "eta",
                "issue": f"ETA bias +{bias} (pozdě)",
                "action": "mírně zvýšit closing / snížit zaokrouhlení",
            }
        )
    if bias is not None and bias < -12:
        tips.append(
            {
                "area": "eta",
                "issue": f"ETA bias {bias} (brzy)",
                "action": "přísnější approach cos / vyšší closing min",
            }
        )
    form = report.get("formation") or {}
    prec = form.get("precisionPct")
    if prec is not None and prec < 35 and (form.get("zones") or 0) >= 3:
        tips.append(
            {
                "area": "formation",
                "issue": f"precision {prec}% < 35",
                "action": "zvýšit MIN_ZONE_SCORE / viability CAPE",
            }
        )
    return tips


def seed_archive_from_cells(cells: list[dict], archive_dir: Path) -> list[dict]:
    """Z historie buněk vytvoří více archive slotů (různé časy)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from opera_fetch_convert import export_radar_archive

    by_time: dict[str, list[dict]] = {}
    for f in cells:
        p = f["properties"]
        hist = p.get("history") or []
        for h in hist:
            t = h["time"]
            by_time.setdefault(t, []).append(
                {
                    "id": p.get("id"),
                    "trackId": p.get("trackId"),
                    "peakLon": h["peakLon"],
                    "peakLat": h["peakLat"],
                    "maxDbz": h.get("maxDbz", p.get("maxDbz")),
                    "trackHeadingDeg": p.get("trackHeadingDeg"),
                    "trackSpeedKmh": p.get("trackSpeedKmh"),
                    "birthDbz": p.get("birthDbz"),
                    "trueBirth": p.get("trueBirth"),
                    "isNewborn": p.get("isNewborn"),
                    "ageMinutes": p.get("ageMinutes"),
                    "history": hist,
                }
            )
    for t in sorted(by_time.keys()):
        export_radar_archive(by_time[t], t, str(archive_dir))
    return load_archive_slots(archive_dir)


def main() -> int:
    cells_path = ROOT / "public" / "data" / "opera" / "cells.geojson"
    grid_path = ROOT / "public" / "data" / "formation" / "grid.json"
    low_path = ROOT / "public" / "data" / "wind" / "low.json"
    upper_path = ROOT / "public" / "data" / "wind" / "upper.json"
    archive_dir = ROOT / "public" / "data" / "opera" / "archive"
    out_dir = ROOT / "public" / "data" / "calibration"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not cells_path.is_file():
        print("FAIL: chybí cells.geojson")
        return 1

    cells_fc = load_json(cells_path)
    cells = cell_features(cells_fc)
    low = load_json(low_path) if low_path.is_file() else None
    upper = load_json(upper_path) if upper_path.is_file() else None
    steer = blend_steering_grids(low, upper)
    grid = load_json(grid_path) if grid_path.is_file() else {"points": []}
    archive_slots = load_archive_slots(archive_dir)

    if len(archive_slots) < 3 and cells:
        archive_slots = seed_archive_from_cells(cells, archive_dir)

    track = calibrate_tracks(cells, steer)
    eta = calibrate_eta(cells, steer)
    formation = calibrate_formation(grid, cells, archive_slots)

    report = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cellCount": len(cells),
        "archiveSlots": len(archive_slots),
        "track": track,
        "eta": eta,
        "formation": formation,
        "targets": {
            "trackMedianKm30": 20,
            "etaMedianAbsErrMin": 15,
            "formationPrecisionPct": 35,
        },
    }
    report["suggestions"] = suggest_tweaks(report)
    report["ok"] = _report_ok(report)

    out_path = out_dir / "last_report.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("=== Nowcast calibration ===")
    print(f"cells={len(cells)} archiveSlots={len(archive_slots)}")
    t30 = track.get("medianKm", {}).get("30")
    t15 = track.get("medianKm", {}).get("15")
    print(
        f"Track median km: T+15={t15} (n={track.get('samples', {}).get('15')}) "
        f"T+30={t30} (n={track.get('samples', {}).get('30')})"
    )
    print(
        f"ETA |err| median={eta.get('medianAbsErrMin')} min "
        f"bias={eta.get('medianBiasMin')} (n={eta.get('samples')})"
    )
    print(
        f"Formation zones={formation.get('zones')} hits={formation.get('hits')} "
        f"precision={formation.get('precisionPct')}%"
    )
    if report["suggestions"]:
        print("Suggestions:")
        for s in report["suggestions"]:
            print(f"  - [{s['area']}] {s['issue']} → {s['action']}")
    print(f"Wrote {out_path}")
    print("OK" if report["ok"] else "WARN: skill below target (see suggestions)")
    return 0


def _report_ok(report: dict) -> bool:
    """True pokud máme málo vzorků NEBO metriky v cíli."""
    track = report.get("track") or {}
    n30 = (track.get("samples") or {}).get("30") or 0
    med30 = (track.get("medianKm") or {}).get("30")
    if n30 >= 8 and med30 is not None and med30 > 28:
        return False
    eta = report.get("eta") or {}
    if (eta.get("samples") or 0) >= 5:
        me = eta.get("medianAbsErrMin")
        if me is not None and me > 25:
            return False
    form = report.get("formation") or {}
    if (form.get("zones") or 0) >= 4:
        prec = form.get("precisionPct")
        if prec is not None and prec < 20:
            return False
    return True


if __name__ == "__main__":
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
