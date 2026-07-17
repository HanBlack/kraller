"""Audit: radar track vs 850/500 steering for live cells."""
from __future__ import annotations

import json
import math
from pathlib import Path


def sample(grid: dict, lon: float, lat: float) -> tuple[float, float]:
    x = ((lon - grid["west"]) / (grid["east"] - grid["west"])) * (grid["cols"] - 1)
    y = ((lat - grid["south"]) / (grid["north"] - grid["south"])) * (grid["rows"] - 1)
    x0, y0 = int(x), int(y)
    x1 = min(x0 + 1, grid["cols"] - 1)
    y1 = min(y0 + 1, grid["rows"] - 1)
    tx, ty = x - x0, y - y0

    def get(arr: list[float], i: int, j: int) -> float:
        return arr[j * grid["cols"] + i]

    u = (
        get(grid["u"], x0, y0) * (1 - tx) * (1 - ty)
        + get(grid["u"], x1, y0) * tx * (1 - ty)
        + get(grid["u"], x0, y1) * (1 - tx) * ty
        + get(grid["u"], x1, y1) * tx * ty
    )
    v = (
        get(grid["v"], x0, y0) * (1 - tx) * (1 - ty)
        + get(grid["v"], x1, y0) * tx * (1 - ty)
        + get(grid["v"], x0, y1) * (1 - tx) * ty
        + get(grid["v"], x1, y1) * tx * ty
    )
    hdg = (math.degrees(math.atan2(u, v)) + 360) % 360
    return hdg, math.hypot(u, v) * 3.6


def ang_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


def main() -> None:
    root = Path("public/data")
    low = json.loads((root / "wind/low.json").read_text(encoding="utf-8"))
    up = json.loads((root / "wind/upper.json").read_text(encoding="utf-8"))
    cells = json.loads((root / "opera/cells.geojson").read_text(encoding="utf-8"))

    peaks: dict[str, list[float]] = {}
    for f in cells["features"]:
        pr = f.get("properties") or {}
        if pr.get("kind") != "peak":
            continue
        cid = str(pr.get("cellId") or pr.get("id"))
        peaks[cid] = f["geometry"]["coordinates"]

    print(
        f"{'id':10} {'dbz':5} {'trkH':5} {'trkS':5} "
        f"{'850':5} {'s850':5} {'500':5} {'s500':5} "
        f"{'mix':5} {'d850':5} {'d500':5} src"
    )
    rows = []
    for f in cells["features"]:
        pr = f.get("properties") or {}
        if pr.get("kind") != "cell":
            continue
        cid = str(pr["id"])
        peak = peaks.get(cid)
        if not peak:
            continue
        lon, lat = peak
        h850, s850 = sample(low, lon, lat)
        h500, s500 = sample(up, lon, lat)

        def uv(h: float, s: float) -> tuple[float, float]:
            r = math.radians(h)
            return math.sin(r) * s, math.cos(r) * s

        u850, v850 = uv(h850, s850)
        u500, v500 = uv(h500, s500)
        # Classic deep-layer mean ~ 0.3*850 + 0.7*500 for storm steering
        ub = 0.3 * u850 + 0.7 * u500
        vb = 0.3 * v850 + 0.7 * v500
        hmix = (math.degrees(math.atan2(ub, vb)) + 360) % 360
        smix = math.hypot(ub, vb)

        th = pr.get("trackHeadingDeg")
        ts = pr.get("trackSpeedKmh")
        src = "radar" if th is not None and ts is not None and ts >= 5 else "wind850"
        d850 = ang_diff(th, h850) if th is not None else None
        d500 = ang_diff(th, h500) if th is not None else None
        rows.append((pr.get("maxDbz", 0), cid, pr, th, ts, h850, s850, h500, s500, hmix, smix, d850, d500, src))

    for _, cid, pr, th, ts, h850, s850, h500, s500, hmix, smix, d850, d500, src in sorted(
        rows, key=lambda r: -r[0]
    )[:15]:
        print(
            f"{cid:10} {pr.get('maxDbz'):5.1f} "
            f"{'-' if th is None else f'{th:5.0f}'} "
            f"{'-' if ts is None else f'{ts:5.1f}'} "
            f"{h850:5.0f} {s850:5.0f} {h500:5.0f} {s500:5.0f} {hmix:5.0f} "
            f"{'-' if d850 is None else f'{d850:5.0f}'} "
            f"{'-' if d500 is None else f'{d500:5.0f}'} {src}"
        )

    tracked = [r for r in rows if r[3] is not None]
    if tracked:
        avg850 = sum(r[11] for r in tracked if r[11] is not None) / len(tracked)
        avg500 = sum(r[12] for r in tracked if r[12] is not None) / len(tracked)
        print(f"\nTracked cells: {len(tracked)}/{len(rows)}")
        print(f"Mean |track-850| = {avg850:.0f}°")
        print(f"Mean |track-500| = {avg500:.0f}°")
        print(f"Mean |track-mix| = {sum(ang_diff(r[3], r[9]) for r in tracked)/len(tracked):.0f}°")


if __name__ == "__main__":
    main()
