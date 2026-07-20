"""Souhrn learning JSONL — přesnost stopy, zrod, zánik, vznik, intenzita."""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learning_store import LEARNING_DIR  # noqa: E402


def load_jsonl(pattern: str) -> list[dict]:
    rows: list[dict] = []
    if not LEARNING_DIR.is_dir():
        return rows
    for path in sorted(LEARNING_DIR.glob(pattern)):
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def med(vals: list[float]) -> float | None:
    if not vals:
        return None
    return round(statistics.median(vals), 2)


def p90(vals: list[float]) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    return round(s[int(0.9 * (len(s) - 1))], 2)


def main() -> int:
    events = load_jsonl("events-*.jsonl")
    samples = load_jsonl("samples-*.jsonl")

    kinds: dict[str, int] = defaultdict(int)
    for e in events:
        kinds[str(e.get("kind"))] += 1

    types: dict[str, int] = defaultdict(int)
    for s in samples:
        types[str(s.get("type"))] += 1

    track_err: dict[str, list[float]] = defaultdict(list)
    heading_err: dict[str, list[float]] = defaultdict(list)
    along: dict[str, list[float]] = defaultdict(list)
    cross: dict[str, list[float]] = defaultdict(list)
    by_source: dict[str, list[float]] = defaultdict(list)
    by_align: list[tuple[float, float]] = []  # align, err

    form_hits = form_miss = 0
    form_by_score: list[tuple[float, bool]] = []
    intens_err: list[float] = []
    demise_reasons: dict[str, int] = defaultdict(int)
    birth_n = 0
    wind_ages: list[float] = []

    for s in samples:
        t = s.get("type")
        if t == "track" and s.get("errKm") is not None:
            h = str(s.get("horizonMin"))
            track_err[h].append(float(s["errKm"]))
            if s.get("headingErrDeg") is not None:
                heading_err[h].append(float(s["headingErrDeg"]))
            if s.get("alongErrKm") is not None:
                along[h].append(abs(float(s["alongErrKm"])))
            if s.get("crossErrKm") is not None:
                cross[h].append(abs(float(s["crossErrKm"])))
            src = str(s.get("motionSource") or "?")
            by_source[src].append(float(s["errKm"]))
            if s.get("windAlignDeg") is not None:
                by_align.append((float(s["windAlignDeg"]), float(s["errKm"])))
        elif t == "formation":
            hit = bool(s.get("hit"))
            if hit:
                form_hits += 1
            else:
                form_miss += 1
            if s.get("score") is not None:
                form_by_score.append((float(s["score"]), hit))
        elif t == "intensity" and s.get("errDbz") is not None:
            intens_err.append(abs(float(s["errDbz"])))
        elif t == "demise":
            demise_reasons[str(s.get("demiseReason") or "?")] += 1
        elif t == "birth_features":
            birth_n += 1
        if s.get("windAgeMin") is not None:
            wind_ages.append(float(s["windAgeMin"]))

    print("=== Learning summary (schema v2) ===")
    print(f"events={len(events)} samples={len(samples)}")
    print("events by kind:", dict(kinds))
    print("samples by type:", dict(types))

    for h in sorted(track_err.keys(), key=lambda x: int(x)):
        vals = track_err[h]
        print(
            f"track T+{h}: n={len(vals)} medianKm={med(vals)} p90={p90(vals)} "
            f"headingErrMed={med(heading_err[h])} "
            f"|along|={med(along[h])} |cross|={med(cross[h])}"
        )
    for src, vals in sorted(by_source.items()):
        print(f"  source {src}: n={len(vals)} medianKm={med(vals)}")

    # align buckets
    if by_align:
        buckets = [(0, 20), (20, 35), (35, 55), (55, 180)]
        for lo, hi in buckets:
            errs = [e for a, e in by_align if lo <= a < hi]
            if errs:
                print(f"  windAlign {lo}-{hi}°: n={len(errs)} medianKm={med(errs)}")

    total_f = form_hits + form_miss
    if total_f:
        print(
            f"formation: hits={form_hits} miss={form_miss} "
            f"precision={100 * form_hits / total_f:.1f}%"
        )
    if intens_err:
        print(f"intensity: n={len(intens_err)} median|errDbz|={med(intens_err)}")
    if demise_reasons:
        print(f"demise reasons: {dict(demise_reasons)}")
    if birth_n:
        print(f"birth_features samples: {birth_n}")
    if wind_ages:
        print(f"windAgeMin median={med(wind_ages)} (stale wind skews direction)")

    n_track = sum(len(v) for v in track_err.values())
    if n_track < 50:
        print("Tip: potrebujeme ~50+ track samples (~1-2 dny bourek) -> pak npm run data:propose-calibration")
    else:
        print("Dost track samples -> npm run data:propose-calibration")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
