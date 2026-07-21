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
    "MAX_SEGMENT_JITTER_DEG": 55,
    "TRUE_BIRTH_MAX_DBZ": 39,
    "TRUE_BIRTH_MAX_AGE_MIN": 10,
    "MIN_ZONE_SCORE": 28,
    "FORMATION_HIT_KM": 35,
    "FORMATION_TIMEOUT_MIN": 90,
    "FCT_AGREE_MAX_DEG": 35,
    "INTENSIFY_ALERT_SCORE_MIN": 46,
    "INTENSIFY_SUPPRESS_GROWTH_DBZ": 0,
    "HAIL_LIKELY_DBZ": 55,
    "HAIL_MIN_ABOVE_FZL_KM": 1.5,
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
    """
    Prah MIN_ZONE_SCORE podle F1.
    Timeout-miss (hit=false po dlouhém leadMin) datový set zanášejí — ignoruj je.
    """
    # Ověřené hity + krátké miss (ne 2–4 h timeout)
    usable = [
        f
        for f in forms
        if f.get("hit")
        or (
            f.get("leadMin") is not None
            and float(f["leadMin"]) <= CURRENT.get("FORMATION_TIMEOUT_MIN", 90)
            and not f.get("hit")
        )
    ]
    # po filtru často skoro jen hity → práh z F1 nejde spolehlivě
    n_hit = sum(1 for f in usable if f.get("hit"))
    n_miss = sum(1 for f in usable if not f.get("hit"))
    if len(forms) < 20 or n_miss < 15:
        return {
            "param": "MIN_ZONE_SCORE",
            "current": CURRENT["MIN_ZONE_SCORE"],
            "proposed": CURRENT["MIN_ZONE_SCORE"],
            "confidence": "low",
            "n": len(forms),
            "nUsable": len(usable),
            "nHit": n_hit,
            "nMiss": n_miss,
            "reason": "málo ověřených miss (timeouty nepočítat) — práh nedržet z F1",
        }
    best = CURRENT["MIN_ZONE_SCORE"]
    best_f1 = -1.0
    evidence = []
    for thr in (22, 26, 28, 32, 36, 40, 45):
        subset = [f for f in usable if float(f.get("score") or 0) >= thr]
        if len(subset) < 5:
            continue
        tp = sum(1 for f in subset if f.get("hit"))
        fp = sum(1 for f in subset if not f.get("hit"))
        fn = sum(
            1
            for f in usable
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
        # vyžaduj lepší F1 než dosud (ne remízu → první thr)
        if f1 > best_f1 + 0.01:
            best_f1 = f1
            best = thr
    best_ev = next((e for e in evidence if e["thr"] == best), None)
    prec_best = (best_ev or {}).get("precision") or 0
    conf = "low"
    if len(usable) >= 60 and n_miss >= 30 and prec_best >= 15:
        conf = "high"
    elif len(usable) >= 40 and n_miss >= 20:
        conf = "medium"
    return {
        "param": "MIN_ZONE_SCORE",
        "current": CURRENT["MIN_ZONE_SCORE"],
        "proposed": best if best_f1 >= 0 else CURRENT["MIN_ZONE_SCORE"],
        "confidence": conf,
        "n": len(forms),
        "nUsable": len(usable),
        "nHit": n_hit,
        "nMiss": n_miss,
        "evidence": evidence,
        "reason": "max F1 na ověřených formation (bez dlouhých timeout miss)",
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


def propose_fct_agree(tracks: list[dict]) -> dict:
    """Když FCT nesouhlasí, je track err větší? → práh FCT_AGREE_MAX_DEG."""
    pairs = [
        (
            float(s["fctAngleDiffDeg"]),
            float(s["errKm"]),
            bool(s.get("fctAgree")),
        )
        for s in tracks
        if s.get("fctAngleDiffDeg") is not None
        and s.get("errKm") is not None
        and int(s.get("horizonMin") or 0) == 15
    ]
    if len(pairs) < 15:
        return {
            "param": "FCT_AGREE_MAX_DEG",
            "current": CURRENT["FCT_AGREE_MAX_DEG"],
            "proposed": CURRENT["FCT_AGREE_MAX_DEG"],
            "confidence": "low",
            "n": len(pairs),
            "file": "scripts/chmi_radar.py + src/storm/radarCells.ts",
            "reason": "málo track samples s FCT (sběr ČHMÚ Fáze 3)",
        }
    best = CURRENT["FCT_AGREE_MAX_DEG"]
    best_gap = -1.0
    evidence = []
    for thr in (25, 30, 35, 40, 50):
        agree_err = [e for a, e, _ in pairs if a <= thr]
        disagree_err = [e for a, e, _ in pairs if a > thr]
        if len(agree_err) < 3 or len(disagree_err) < 3:
            continue
        ma, md = med(agree_err) or 0, med(disagree_err) or 0
        gap = md - ma  # očekáváme vyšší err při disagree
        evidence.append(
            {
                "thr": thr,
                "nAgree": len(agree_err),
                "nDisagree": len(disagree_err),
                "medErrAgree": ma,
                "medErrDisagree": md,
                "gapKm": round(gap, 2),
            }
        )
        if gap > best_gap:
            best_gap = gap
            best = thr
    return {
        "param": "FCT_AGREE_MAX_DEG",
        "current": CURRENT["FCT_AGREE_MAX_DEG"],
        "proposed": best,
        "confidence": "high" if len(pairs) >= 40 else "medium",
        "n": len(pairs),
        "evidence": evidence,
        "file": "scripts/chmi_radar.py (FCT_AGREE_MAX_DEG)",
        "reason": "max gap median errKm agree vs disagree podle úhlu FCT",
    }


def propose_intensify(purples: list[dict]) -> dict:
    """Hit rate fialové → alertScoreMin / suppress growth."""
    if len(purples) < 12:
        return {
            "param": "intensification.alertScoreMin",
            "current": CURRENT["INTENSIFY_ALERT_SCORE_MIN"],
            "proposed": CURRENT["INTENSIFY_ALERT_SCORE_MIN"],
            "confidence": "low",
            "n": len(purples),
            "file": "src/storm/config.ts",
            "reason": "malo intensify samples (purple candidate -> T+15/30)",
        }
    hits = [p for p in purples if p.get("hitIntensify")]
    misses = [p for p in purples if p.get("hitIntensify") is False]
    hit_rate = len(hits) / max(1, len(purples))
    # nízký hit rate → zpřísnit (vyšší alertScoreMin)
    if hit_rate < 0.35:
        proposed = min(48, CURRENT["INTENSIFY_ALERT_SCORE_MIN"] + 8)
        reason = f"hit rate {hit_rate:.0%} — příliš false positive, zpřísnit"
    elif hit_rate > 0.7:
        proposed = max(24, CURRENT["INTENSIFY_ALERT_SCORE_MIN"] - 4)
        reason = f"hit rate {hit_rate:.0%} — lze mírně uvolnit"
    else:
        proposed = CURRENT["INTENSIFY_ALERT_SCORE_MIN"]
        reason = f"hit rate {hit_rate:.0%} — držet"
    return {
        "param": "intensification.alertScoreMin",
        "current": CURRENT["INTENSIFY_ALERT_SCORE_MIN"],
        "proposed": proposed,
        "confidence": "high" if len(purples) >= 40 else "medium",
        "n": len(purples),
        "hitRate": round(hit_rate, 3),
        "nHit": len(hits),
        "nMiss": len(misses),
        "file": "src/storm/config.ts",
        "reason": reason,
        "alsoReview": {
            "param": "intensification.suppressIfGrowthDbzBelow",
            "current": CURRENT["INTENSIFY_SUPPRESS_GROWTH_DBZ"],
            "hint": "při fade po purple zkontroluj růst dBZ před kandidátem",
        },
    }


def propose_hail(events_hail_hint: list[dict], demises: list[dict]) -> dict:
    """
    Heuristika: silné echo + hailCmProxy — pokud po tom rychlý fade,
    možná příliš agresivní FZL práh (nebo naopak).
    """
    with_hail = [d for d in demises if d.get("hailCmProxy")]
    if len(with_hail) < 5 and len(events_hail_hint) < 10:
        return {
            "param": "active.hail.minAboveFreezingKm",
            "current": CURRENT["HAIL_MIN_ABOVE_FZL_KM"],
            "proposed": CURRENT["HAIL_MIN_ABOVE_FZL_KM"],
            "confidence": "low",
            "n": len(with_hail) + len(events_hail_hint),
            "file": "src/storm/config.ts",
            "reason": "málo hail proxy samples (čekej silné buňky + FZL v env)",
        }
    fade_after = sum(
        1
        for d in with_hail
        if d.get("demiseReason") == "fade"
        and d.get("lifeMin") is not None
        and float(d["lifeMin"]) < 40
    )
    # hodně krátkých fade po „kroupách“ → přísnější (vyšší minAboveFreezing)
    if with_hail and fade_after / max(1, len(with_hail)) > 0.55:
        proposed = round(CURRENT["HAIL_MIN_ABOVE_FZL_KM"] + 0.5, 1)
        reason = "častý krátký fade po hail proxy — zpřísnit FZL excess"
    else:
        proposed = CURRENT["HAIL_MIN_ABOVE_FZL_KM"]
        reason = "zatím držet; ladit až s víc bouřkami"
    return {
        "param": "active.hail.minAboveFreezingKm",
        "current": CURRENT["HAIL_MIN_ABOVE_FZL_KM"],
        "proposed": proposed,
        "confidence": "medium" if len(with_hail) >= 15 else "low",
        "n": len(with_hail),
        "nHailEvents": len(events_hail_hint),
        "shortFadeShare": round(fade_after / max(1, len(with_hail)), 2) if with_hail else None,
        "file": "src/storm/config.ts",
        "reason": reason,
        "alsoReview": {
            "param": "active.hail.likelyDbz",
            "current": CURRENT["HAIL_LIKELY_DBZ"],
        },
    }


def load_track_sample_events() -> list[dict]:
    rows: list[dict] = []
    if not LEARNING_DIR.is_dir():
        return rows
    for path in sorted(LEARNING_DIR.glob("events-*.jsonl")):
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("kind") == "track_sample":
                    rows.append(ev)
    return rows


def main() -> int:
    samples = load_samples()
    tracks = [s for s in samples if s.get("type") == "track"]
    forms = [s for s in samples if s.get("type") == "formation"]
    births = [s for s in samples if s.get("type") == "birth_features"]
    intens = [s for s in samples if s.get("type") == "intensity"]
    demises = [s for s in samples if s.get("type") == "demise"]
    purples = [s for s in samples if s.get("type") == "intensify"]
    track_ev = load_track_sample_events()
    hail_ev = [e for e in track_ev if e.get("hailCmProxy")]

    proposals = [
        propose_wind_align(tracks),
        propose_segment_jitter(),
        propose_birth(births),
        propose_formation(forms),
        propose_speed_bias(tracks),
        propose_fct_agree(tracks),
        propose_intensify(purples),
        propose_hail(hail_ev, demises),
    ]

    intens_note = None
    if intens:
        errs = [abs(float(s["errDbz"])) for s in intens if s.get("errDbz") is not None]
        intens_note = {
            "n": len(intens),
            "medianAbsErrDbz": med(errs),
            "hint": "slope z historie; při velké chybě doladit intensifikaci / env weight",
        }

    purple_note = None
    if purples:
        hits = sum(1 for p in purples if p.get("hitIntensify"))
        purple_note = {
            "n": len(purples),
            "hitRate": round(hits / len(purples), 3),
            "hint": "upřímná fialová — nízký hitRate → vyšší alertScoreMin / suppress",
        }

    demise_note = None
    if demises:
        by_r: dict[str, int] = defaultdict(int)
        lives: list[float] = []
        fade_lives: list[float] = []
        for d in demises:
            reason = str(d.get("demiseReason") or "?")
            by_r[reason] += 1
            if d.get("lifeMin") is not None:
                life = float(d["lifeMin"])
                lives.append(life)
                # merge_or_jump ≠ reálný zánik — life kalibrace jen z fade
                if reason == "fade":
                    fade_lives.append(life)
        demise_note = {
            "n": len(demises),
            "reasons": dict(by_r),
            "medianLifeMin": med(lives),
            "medianFadeLifeMin": med(fade_lives),
            "nFade": len(fade_lives),
            "nWithHailProxy": sum(1 for d in demises if d.get("hailCmProxy")),
            "nAfterPurple": sum(1 for d in demises if d.get("purpleCandidate")),
            "hint": "medianLifeMin je zkreslené merge_or_jump — ber medianFadeLifeMin",
        }

    surface_n = sum(1 for e in track_ev if e.get("surfaceDbz") is not None)
    fct_n = sum(1 for e in track_ev if e.get("fctAgree") is not None)
    fzl_n = sum(1 for e in track_ev if e.get("freezingLevelM") is not None)

    ready = (
        len(tracks) >= 50
        and len(forms) >= 20
        and (len(purples) >= 12 or len(tracks) >= 120)
    )

    report = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sampleCounts": {
            "track": len(tracks),
            "formation": len(forms),
            "birth_features": len(births),
            "intensity": len(intens),
            "intensify": len(purples),
            "demise": len(demises),
            "track_sample_events": len(track_ev),
            "withSurfaceDbz": surface_n,
            "withFct": fct_n,
            "withFreezingLevel": fzl_n,
            "withHailProxy": len(hail_ev),
            "total": len(samples),
        },
        "readyForApply": ready,
        "proposals": proposals,
        "intensity": intens_note,
        "intensifyPurple": purple_note,
        "demise": demise_note,
        "applyHint": (
            "Po review propsat: "
            "src/storm/stormTrackRules.ts (motion/birth), "
            "src/storm/formationData.ts (MIN_ZONE_SCORE), "
            "src/storm/config.ts (hail / intensification), "
            "scripts/chmi_radar.py (FCT_AGREE_MAX_DEG), "
            "ACTIVE_CONSTANTS v scripts/emit_learning.py"
        ),
        "tuneInDays": (
            "Po ~2 dnech bouřek: npm run data:learning-summary && "
            "npm run data:propose-calibration → public/data/calibration/proposal.json"
        ),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUT}")
    print(
        f"readyForApply={report['readyForApply']} "
        f"tracks={len(tracks)} formation={len(forms)} intensify={len(purples)}"
    )
    for p in proposals:
        cur = p.get("current")
        prop = p.get("proposed")
        reason = str(p.get("reason", "")).replace("\u2192", "->").replace("\u2014", "-")[:70]
        print(
            f"  {p['param']}: {cur} -> {prop} "
            f"[{p.get('confidence')}] {reason}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
