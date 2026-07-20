"""
Navrhne kalibrační konstanty z learning samples.

Výstup: public/data/calibration/proposal.json
  — doporučené hodnoty + evidence (n, metriky)
  — po ručním / agent review lze propsat do stormTrackRules.ts
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learning_store import LEARNING_DIR  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "calibration" / "proposal.json"

CURRENT = {
    "MAX_WIND_ALIGN_DEG": 35,
    "MAX_SEGMENT_JITTER_DEG": 40,
    "TRUE_BIRTH_MAX_DBZ": 38,
    "TRUE_BIRTH_MAX_AGE_MIN": 18,
    "MIN_ZONE_SCORE": 28,
    "FORMATION_HIT_KM": 35,
}


def load_samples() -> list[dict]:
    rows: list[dict] = []
    if not LEARNING_DIR.is_dir():
        return rows
    for path in sorted(LEARNING_DIR.glob("samples-*.jsonl")):
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


def propose_wind_align(tracks: list[dict]) -> dict:
    """Najdi práh align, pod kterým je median err nejlepší."""
    pairs = [
        (float(s["windAlignDeg"]), float(s["errKm"]))
        for s in tracks
        if s.get("windAlignDeg") is not None and s.get("errKm") is not None
        and int(s.get("horizonMin") or 0) == 15
    ]
    if len(pairs) < 20:
        return {
            "param": "MAX_WIND_ALIGN_DEG",
            "current": CURRENT["MAX_WIND_ALIGN_DEG"],
            "proposed": CURRENT["MAX_WIND_ALIGN_DEG"],
            "confidence": "low",
            "reason": f"málo samples s windAlign ({len(pairs)} < 20)",
            "n": len(pairs),
        }

    best_thr = CURRENT["MAX_WIND_ALIGN_DEG"]
    best_score = 1e9
    evidence = []
    for thr in (20, 25, 30, 35, 40, 45, 55):
        use_radar = [e for a, e in pairs if a <= thr]
        use_wind = [e for a, e in pairs if a > thr]
        # skóre = blended median (váha podle počtu)
        if not use_radar and not use_wind:
            continue
        m_r = med(use_radar) or 99
        m_w = med(use_wind) or 99
        # odhad: pod prahem bereme radar blend, nad vítr — nižší err = lepší
        score = (m_r * len(use_radar) + m_w * len(use_wind)) / max(1, len(pairs))
        evidence.append(
            {
                "thr": thr,
                "nRadarLike": len(use_radar),
                "nWindLike": len(use_wind),
                "medErrRadarLike": m_r,
                "medErrWindLike": m_w,
                "blendScore": round(score, 2),
            }
        )
        if score < best_score:
            best_score = score
            best_thr = thr

    return {
        "param": "MAX_WIND_ALIGN_DEG",
        "current": CURRENT["MAX_WIND_ALIGN_DEG"],
        "proposed": best_thr,
        "confidence": "high" if len(pairs) >= 80 else "medium",
        "reason": "minimum blended median errKm T+15 podle windAlignDeg",
        "n": len(pairs),
        "evidence": evidence,
    }


def propose_segment_jitter(events_path_hint: bool = True) -> dict:
    """Z events track_sample: jitter vs pozdější track err (proxy)."""
    # jednoduchý návrh z distribuce jitteru u „dobrých“ stop
    jitters: list[float] = []
    for path in sorted(LEARNING_DIR.glob("events-*.jsonl")):
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("kind") != "track_sample":
                    continue
                j = e.get("segmentJitterDeg")
                obs = e.get("obsSpd")
                if j is not None and obs is not None and 8 <= float(obs) <= 60:
                    jitters.append(float(j))
    if len(jitters) < 30:
        return {
            "param": "MAX_SEGMENT_JITTER_DEG",
            "current": CURRENT["MAX_SEGMENT_JITTER_DEG"],
            "proposed": CURRENT["MAX_SEGMENT_JITTER_DEG"],
            "confidence": "low",
            "n": len(jitters),
            "reason": "málo jitter samples",
        }
    # p85 „stabilních“ stop — nad tím jitter = špatný match
    s = sorted(jitters)
    p85 = s[int(0.85 * (len(s) - 1))]
    proposed = int(max(25, min(55, round(p85 / 5) * 5)))
    return {
        "param": "MAX_SEGMENT_JITTER_DEG",
        "current": CURRENT["MAX_SEGMENT_JITTER_DEG"],
        "proposed": proposed,
        "confidence": "medium" if len(jitters) >= 100 else "low",
        "n": len(jitters),
        "p85Jitter": round(p85, 1),
        "reason": "p85 segmentJitter u rozumných rychlostí",
    }


def propose_birth(births: list[dict]) -> dict:
    if len(births) < 15:
        return {
            "param": "TRUE_BIRTH_MAX_DBZ",
            "current": CURRENT["TRUE_BIRTH_MAX_DBZ"],
            "proposed": CURRENT["TRUE_BIRTH_MAX_DBZ"],
            "confidence": "low",
            "n": len(births),
            "reason": "málo birth_features",
        }
    # birthDbz u trueBirthLabel=True vs False
    true_dbz = [
        float(b["birthDbz"])
        for b in births
        if b.get("trueBirthLabel") and b.get("birthDbz") is not None
    ]
    false_dbz = [
        float(b["birthDbz"])
        for b in births
        if b.get("trueBirthLabel") is False and b.get("birthDbz") is not None
    ]
    # navrhni práh mezi mediány
    if true_dbz and false_dbz:
        proposed = int(round((statistics.median(true_dbz) + statistics.median(false_dbz)) / 2))
        proposed = max(30, min(45, proposed))
    elif true_dbz:
        proposed = int(max(30, min(45, statistics.median(true_dbz) + 4)))
    else:
        proposed = CURRENT["TRUE_BIRTH_MAX_DBZ"]

    ages = [
        float(b["ageMin"])
        for b in births
        if b.get("trueBirthLabel") and b.get("ageMin") is not None
    ]
    age_prop = CURRENT["TRUE_BIRTH_MAX_AGE_MIN"]
    if len(ages) >= 10:
        age_prop = int(max(10, min(30, round(statistics.quantiles(ages, n=10)[8]))))

    return {
        "param": "TRUE_BIRTH_MAX_DBZ",
        "current": CURRENT["TRUE_BIRTH_MAX_DBZ"],
        "proposed": proposed,
        "also": {
            "TRUE_BIRTH_MAX_AGE_MIN": {
                "current": CURRENT["TRUE_BIRTH_MAX_AGE_MIN"],
                "proposed": age_prop,
            }
        },
        "confidence": "medium" if len(births) >= 40 else "low",
        "n": len(births),
        "medianBirthDbzTrue": med(true_dbz),
        "medianBirthDbzFalse": med(false_dbz),
        "reason": "oddělení trueBirth vs příjezd podle birthDbz",
    }


def propose_formation(forms: list[dict]) -> dict:
    if len(forms) < 20:
        return {
            "param": "MIN_ZONE_SCORE",
            "current": CURRENT["MIN_ZONE_SCORE"],
            "proposed": CURRENT["MIN_ZONE_SCORE"],
            "confidence": "low",
            "n": len(forms),
            "reason": "málo formation samples",
        }
    best = CURRENT["MIN_ZONE_SCORE"]
    best_f1 = -1.0
    evidence = []
    for thr in (22, 26, 28, 32, 36, 40, 45):
        # simulace: bereme jen zóny se score>=thr
        subset = [f for f in forms if float(f.get("score") or 0) >= thr]
        if len(subset) < 5:
            continue
        tp = sum(1 for f in subset if f.get("hit"))
        fp = sum(1 for f in subset if not f.get("hit"))
        # FN = hity pod prahem
        fn = sum(
            1
            for f in forms
            if f.get("hit") and float(f.get("score") or 0) < thr
        )
        prec = tp / max(1, tp + fp)
        rec = tp / max(1, tp + fn)
        f1 = 2 * prec * rec / max(1e-6, prec + rec)
        evidence.append(
            {
                "thr": thr,
                "n": len(subset),
                "precision": round(100 * prec, 1),
                "recall": round(100 * rec, 1),
                "f1": round(f1, 3),
            }
        )
        if f1 > best_f1:
            best_f1 = f1
            best = thr
    return {
        "param": "MIN_ZONE_SCORE",
        "current": CURRENT["MIN_ZONE_SCORE"],
        "proposed": best,
        "confidence": "high" if len(forms) >= 60 else "medium",
        "n": len(forms),
        "evidence": evidence,
        "reason": "max F1 precision/recall formation hit",
    }


def propose_speed_bias(tracks: list[dict]) -> dict:
    errs = [
        float(s["speedErrKmh"])
        for s in tracks
        if s.get("speedErrKmh") is not None and int(s.get("horizonMin") or 0) == 15
    ]
    if len(errs) < 20:
        return {
            "param": "SPEED_BIAS_KMH",
            "proposed": 0,
            "confidence": "low",
            "n": len(errs),
            "reason": "málo speedErr samples",
        }
    bias = med(errs) or 0
    return {
        "param": "SPEED_BIAS_KMH",
        "proposed": round(-bias, 1),  # korekce = −medián chyby
        "observedMedianSpeedErr": bias,
        "confidence": "medium" if len(errs) >= 50 else "low",
        "n": len(errs),
        "reason": "medián (actSpd − predSpd); proposed přičíst k rychlosti",
    }


def main() -> int:
    samples = load_samples()
    tracks = [s for s in samples if s.get("type") == "track"]
    forms = [s for s in samples if s.get("type") == "formation"]
    births = [s for s in samples if s.get("type") == "birth_features"]
    intens = [s for s in samples if s.get("type") == "intensity"]
    demises = [s for s in samples if s.get("type") == "demise"]

    proposals = [
        propose_wind_align(tracks),
        propose_segment_jitter(),
        propose_birth(births),
        propose_formation(forms),
        propose_speed_bias(tracks),
    ]

    intens_note = None
    if intens:
        errs = [abs(float(s["errDbz"])) for s in intens if s.get("errDbz") is not None]
        intens_note = {
            "n": len(intens),
            "medianAbsErrDbz": med(errs),
            "hint": "slope z historie; při velké chybě doladit intensifikaci / env weight",
        }

    demise_note = None
    if demises:
        by_r: dict[str, int] = defaultdict(int)
        lives: list[float] = []
        for d in demises:
            by_r[str(d.get("demiseReason") or "?")] += 1
            if d.get("lifeMin") is not None:
                lives.append(float(d["lifeMin"]))
        demise_note = {
            "n": len(demises),
            "reasons": dict(by_r),
            "medianLifeMin": med(lives),
        }

    report = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sampleCounts": {
            "track": len(tracks),
            "formation": len(forms),
            "birth_features": len(births),
            "intensity": len(intens),
            "demise": len(demises),
            "total": len(samples),
        },
        "readyForApply": len(tracks) >= 50 and len(forms) >= 20,
        "proposals": proposals,
        "intensity": intens_note,
        "demise": demise_note,
        "applyHint": (
            "Po review propsat proposed do src/storm/stormTrackRules.ts "
            "a ACTIVE_CONSTANTS v scripts/emit_learning.py / calibrate_nowcast.py"
        ),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUT}")
    print(f"readyForApply={report['readyForApply']} tracks={len(tracks)} formation={len(forms)}")
    for p in proposals:
        print(
            f"  {p['param']}: {p.get('current')} -> {p.get('proposed')} "
            f"[{p.get('confidence')}] {p.get('reason', '')[:60]}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
