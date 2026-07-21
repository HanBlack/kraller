"""Rychlá kontrola dat + guardy proti falešnému zrodu / divokým stopám."""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TRUE_BIRTH_MAX_DBZ = 39
MAX_TRUSTED_TRACK_KMH = 70


def load_json(rel: str):
    path = os.path.join(ROOT, rel)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    meta = load_json("public/data/meta.json")
    grid = load_json("public/data/formation/grid.json")
    manifest = load_json("public/data/opera/history/manifest.json")
    cells = load_json("public/data/opera/cells.geojson")
    latest = load_json("public/data/opera/latest.geojson")

    points = grid.get("points", [])
    cols = grid.get("cols", 0)
    rows = grid.get("rows", 0)
    print(f"Formation grid: {cols}x{rows} = {len(points)} points")
    if len(points) < 150:
        errors.append(f"Formation grid too small: {len(points)}")

    cape_pos = sum(1 for p in points if p["environment"].get("capeJkg", 0) > 0)
    cape_now_zero = sum(
        1 for p in points if (p["environment"].get("capeNowJkg") or 0) <= 0
    )
    print(f"  CAPE peak>0: {cape_pos}/{len(points)} (now~0: {cape_now_zero})")
    print(f"  source: {grid.get('source')} validAt={grid.get('validAt')} mode={grid.get('capeMode')}")
    if cape_pos < len(points) * 0.3:
        warnings.append(
            f"CAPE peak>0 jen u {cape_pos}/{len(points)} bodů — zkontroluj fetch_formation (hodina/model)"
        )

    # Vítr musí být z aktuální hodiny (ne [0] = půlnoc)
    wind_low_path = os.path.join(ROOT, "public", "data", "wind", "low.json")
    if os.path.isfile(wind_low_path):
        wind = load_json("public/data/wind/low.json")
        hi = wind.get("hourIndex")
        print(f"Wind low: hourIndex={hi} validAt={wind.get('validAt')}")
        if hi is None:
            warnings.append("wind/low.json bez hourIndex — spusť fetch_wind.py znovu")
        elif hi == 0:
            from datetime import datetime, timezone

            utc_h = datetime.now(timezone.utc).hour
            src = wind.get("source") or ""
            if utc_h >= 2 and "fallback" not in src:
                errors.append(
                    f"wind hourIndex=0 při UTC hodině {utc_h} — pravděpodobně starý fetch (půlnoc)"
                )
    else:
        warnings.append("chybí public/data/wind/low.json")

    frames = manifest.get("frames", [])
    print(f"Radar history frames: {len(frames)}")
    if len(frames) < 4:
        errors.append("Too few radar history frames")

    cell_feats = [
        f for f in cells["features"] if f.get("properties", {}).get("kind") == "cell"
    ]
    peak_count = sum(
        1 for f in cells["features"] if f.get("properties", {}).get("kind") == "peak"
    )
    print(f"Tracked cells: {len(cell_feats)}, peaks: {peak_count}")

    fake_births = 0
    wild_tracks = 0
    for f in cell_feats:
        p = f.get("properties") or {}
        birth_dbz = float(p.get("birthDbz") or p.get("maxDbz") or 0)
        is_newborn = bool(p.get("isNewborn"))
        true_birth = p.get("trueBirth")
        spd = p.get("trackSpeedKmh")

        # Pipeline nesmí tvrdit trueBirth/newborn u silného echa
        if true_birth is True and birth_dbz > TRUE_BIRTH_MAX_DBZ:
            fake_births += 1
            errors.append(
                f"{p.get('id')}: trueBirth=true při birthDbz={birth_dbz:.0f}"
            )
        elif is_newborn and birth_dbz > TRUE_BIRTH_MAX_DBZ:
            # Staré exporty bez trueBirth — frontend už opraví; po data:update zmizí
            fake_births += 1
            warnings.append(
                f"{p.get('id')}: isNewborn=true při birthDbz={birth_dbz:.0f} "
                f"(max {TRUE_BIRTH_MAX_DBZ}) — falešný zrod, opraví se při příštím OPERA update"
            )

        if spd is not None and float(spd) > MAX_TRUSTED_TRACK_KMH:
            wild_tracks += 1
            warnings.append(
                f"{p.get('id')}: trackSpeed={spd} km/h > {MAX_TRUSTED_TRACK_KMH} "
                "(frontend musí použít vítr)"
            )

    print(f"Fake-birth guards: {fake_births} errors, wild tracks: {wild_tracks}")

    radar_polys = sum(
        1 for f in latest["features"] if f["geometry"]["type"] == "Polygon"
    )
    print(f"Latest radar polygons: {radar_polys}")
    print(f"Meta updated: {meta.get('updatedAt')}")

    # Calibration skill (pokud už běžel data:calibrate)
    cal_path = os.path.join(ROOT, "public", "data", "calibration", "last_report.json")
    if os.path.isfile(cal_path):
        cal = load_json("public/data/calibration/last_report.json")
        track = cal.get("track") or {}
        eta = cal.get("eta") or {}
        form = cal.get("formation") or {}
        med30 = (track.get("medianKm") or {}).get("30")
        med15 = (track.get("medianKm") or {}).get("15")
        eta_err = eta.get("medianAbsErrMin")
        prec = form.get("precisionPct")
        print(
            f"Calibration: track T+15={med15}km T+30={med30}km | "
            f"ETA|err|={eta_err}min | form precision={prec}% | ok={cal.get('ok')}"
        )
        if cal.get("ok") is False:
            warnings.append("nowcast calibration skill below target — viz last_report.json")
        for s in (cal.get("suggestions") or [])[:5]:
            warnings.append(f"calibrate [{s.get('area')}]: {s.get('issue')}")
    else:
        warnings.append("chybí calibration/last_report.json — spusť npm run data:calibrate")

    archive_man = os.path.join(ROOT, "public", "data", "opera", "archive", "manifest.json")
    if os.path.isfile(archive_man):
        am = load_json("public/data/opera/archive/manifest.json")
        print(f"Opera archive slots: {len(am.get('frames') or [])}/{am.get('maxSlots', 36)}")
    else:
        warnings.append("chybí opera/archive — doplní se při opera:update")

    if warnings:
        print("WARN:")
        for w in warnings[:12]:
            print(f"  - {w}")
        if len(warnings) > 12:
            print(f"  … +{len(warnings) - 12} further")

    if errors:
        print("FAIL:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("OK: data + track/birth guards healthy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
