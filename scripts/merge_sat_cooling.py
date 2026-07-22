#!/usr/bin/env python3
"""Sloučí public/data/satellite/cooling.json do formation/grid.json.

Kde je sat cooling validní → cloudTopCoolingCPer15min + coolingSource=satellite.
Jinak nechá model proxy (coolingSource=model).
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

FORM = Path("public/data/formation/grid.json")
COOL = Path("public/data/satellite/cooling.json")
MAX_MATCH_KM = 55.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def nearest(points: list[dict], lat: float, lon: float) -> dict | None:
    best = None
    best_d = 1e9
    for p in points:
        d = haversine_km(lat, lon, float(p["lat"]), float(p["lon"]))
        if d < best_d:
            best_d = d
            best = p
    if best is None or best_d > MAX_MATCH_KM:
        return None
    return best


def merge() -> int:
    if not FORM.is_file():
        print(f"skip merge — chybí {FORM}", flush=True)
        return 0
    if not COOL.is_file():
        print(f"skip merge — chybí {COOL}", flush=True)
        return 0

    form = json.loads(FORM.read_text(encoding="utf-8"))
    cool = json.loads(COOL.read_text(encoding="utf-8"))
    status = cool.get("status")
    cool_pts = cool.get("points") or []

    # Vždy označ model, pokud není sat
    n_sat = 0
    for p in form.get("points") or []:
        env = p.setdefault("environment", {})
        if env.get("coolingSource") is None:
            env["coolingSource"] = "model"

    if status != "ok" or not cool_pts:
        form["coolingMerge"] = {
            "status": status or "missing",
            "satellitePoints": 0,
            "message": cool.get("message") or "no sat cooling",
        }
        FORM.write_text(json.dumps(form), encoding="utf-8")
        print(
            f"merge: no sat applied (status={status}) — model proxy remains",
            flush=True,
        )
        return 0

    for p in form.get("points") or []:
        env = p.setdefault("environment", {})
        hit = nearest(cool_pts, float(p["lat"]), float(p["lon"]))
        if not hit or hit.get("hasCloudTop") is False:
            env["coolingSource"] = env.get("coolingSource") or "model"
            continue
        val = hit.get("cloudTopCoolingCPer15min")
        val45 = hit.get("cloudTopCoolingCPer45min")
        if hit.get("cloudTopTempC") is None:
            continue
        # Prefer 15min; pokud slabý ale 45min silný → škáluj do 15min proxy
        cooling = None
        if val is not None and math.isfinite(float(val)):
            cooling = float(val)
        if val45 is not None and math.isfinite(float(val45)):
            growth45 = max(0.0, -float(val45))
            growth15 = max(0.0, -(cooling or 0.0))
            if growth15 < 1.5 and growth45 >= 4.0:
                cooling = -(growth45 * (15.0 / 45.0))
        if cooling is None:
            continue
        env["cloudTopCoolingCPer15min"] = round(cooling, 2)
        env["coolingSource"] = "satellite"
        env["cloudTopTempC"] = hit["cloudTopTempC"]
        if hit.get("cloudTopHeightM") is not None:
            env["cloudTopHeightM"] = hit["cloudTopHeightM"]
        if hit.get("cloudTopHeightDeltaMPer15min") is not None:
            env["cloudTopHeightDeltaMPer15min"] = hit["cloudTopHeightDeltaMPer15min"]
        if val45 is not None and math.isfinite(float(val45)):
            env["cloudTopCoolingCPer45min"] = round(float(val45), 2)
        if hit.get("deepIceTop") is True:
            env["deepIceTop"] = True
        li_n = hit.get("lightningFlashes15min")
        if li_n is not None:
            try:
                env["lightningFlashes15min"] = int(li_n)
            except (TypeError, ValueError):
                pass
        n_sat += 1

    form["coolingMerge"] = {
        "status": "ok",
        "satellitePoints": n_sat,
        "source": cool.get("source"),
        "validAt": cool.get("validAt"),
    }
    FORM.write_text(json.dumps(form), encoding="utf-8")
    print(f"merge: satellite cooling on {n_sat} formation points", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(merge())
