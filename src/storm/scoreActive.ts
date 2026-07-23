import { stormConfig } from "./config";
import {
  classifyHitAtUser,
  estimateRainMmH,
  severityFromDbz,
} from "./hitAtUser";
import type {
  ActiveStormAssessment,
  EnvironmentSignals,
  HazardScores,
  RadarCellSignals,
} from "./types";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function ramp(value: number, lo: number, hi: number) {
  if (hi <= lo) return value >= hi ? 1 : 0;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * Proxy velikosti krup — jen silné echo.
 * Se známou nulovou izotermou: Waldvogel-style (echo musí být výrazně nad FZL).
 */
export function estimateHailCm(
  echoTopKm: number,
  maxDbz: number,
  freezingLevelM?: number | null,
): number | null {
  const h = stormConfig.active.hail;
  // Jen u silného echa — jinak falešné „kroupy X cm“ z proxy výšky
  if (maxDbz < Math.max(h.likelyDbz, 55)) return null;
  if (echoTopKm < h.likelyEchoTopKm) return null;

  if (freezingLevelM != null && freezingLevelM > 0) {
    const excessKm = echoTopKm - freezingLevelM / 1000;
    if (excessKm < h.minAboveFreezingKm) return null;
  }

  let cm = 1;
  for (const step of h.cmFromEchoTop) {
    if (echoTopKm >= step.minKm) cm = step.cm;
  }

  // Hlubší echo nad FZL → mírně vyšší odhad (stále proxy, ne měření)
  if (freezingLevelM != null && freezingLevelM > 0) {
    const excessKm = echoTopKm - freezingLevelM / 1000;
    if (excessKm >= 4) cm = Math.max(cm, 4);
    else if (excessKm >= 3) cm = Math.max(cm, 2);
  }

  return cm;
}

/** ETA: vzdálenost / složka rychlosti směrem k uživateli (zaokrouhleno, přísnější filtr). */
function estimateEtaMinutes(cell: RadarCellSignals): number | null {
  const maxEta = stormConfig.active.etaAlertMaxMin;
  const approach = Math.cos((cell.approachAngleDeg * Math.PI) / 180);

  // Blízko: ETA jen když ještě míří k lokaci (odcházející ≠ „přijíždí“)
  if (cell.distanceToUserKm <= 15) {
    // Skoro nad tebou — jsi v dosahu, ETA 0
    if (cell.distanceToUserKm <= 5) {
      return 0;
    }
    if (approach <= 0.15) return null;
    const closingKmh = Math.max(cell.speedKmh, 8) * Math.max(approach, 0.25) * 1.15;
    if (closingKmh < 4) return null;
    const minutes = (cell.distanceToUserKm / closingKmh) * 60;
    return roundEtaMin(Math.max(0, Math.min(minutes, maxEta)));
  }

  // Musí mířit k lokaci; kalibrace: mírný bias „pozdě“ → closing ×1.2
  if (approach <= 0.24) return null;

  const closingKmh = cell.speedKmh * approach * 1.2;
  if (closingKmh < 5) return null;

  const minutes = (cell.distanceToUserKm / closingKmh) * 60;
  if (minutes < 0 || minutes > maxEta) return null;
  return roundEtaMin(minutes);
}

/** ETA zaokrouhli na 5 min — přesnější číslo by lhalo. */
function roundEtaMin(minutes: number): number {
  return Math.max(0, Math.round(minutes / 5) * 5);
}

/**
 * Skóre bouře, která už je na radaru.
 * Kam jde + jak silná u tebe (jádro/okraj) + hazard.
 */
export function scoreActiveStorm(
  cell: RadarCellSignals,
  env?: EnvironmentSignals | null,
): ActiveStormAssessment {
  const cfg = stormConfig.active;
  const reasons: string[] = [];

  const hit = classifyHitAtUser(cell);
  // Miss = žádný odhad síly/deště u adresy (ne peak jádra)
  const strengthDbz = hit.atUserDbz;
  let rainDbz: number | null = null;
  if (hit.hitType !== "miss" && strengthDbz != null) {
    if (cell.surfaceDbz != null && cell.surfaceDbz > 0) {
      rainDbz =
        hit.hitType === "core"
          ? cell.surfaceDbz
          : hit.hitType === "fringe"
            ? Math.max(28, cell.surfaceDbz - 10)
            : Math.max(25, cell.surfaceDbz - 18);
    } else {
      rainDbz = strengthDbz;
    }
  }

  const zN = ramp(
    cell.maxDbz,
    cfg.reflectivityDbz.cell,
    cfg.reflectivityDbz.severe,
  );
  const topN = ramp(
    cell.echoTopKm,
    cfg.echoTopKm.moderate,
    cfg.echoTopKm.severe,
  );

  const approach = Math.cos((cell.approachAngleDeg * Math.PI) / 180);
  const towardN = clamp01(approach);

  let envBoost = 0;
  if (env) {
    envBoost = clamp01(
      ramp(env.capeJkg, stormConfig.formation.cape.moderate, stormConfig.formation.cape.strong) *
        0.5 +
        ramp(
          env.shear0to6Ms,
          stormConfig.formation.shear0to6Ms.organized,
          stormConfig.formation.shear0to6Ms.supercell,
        ) *
          0.5,
    );
  }

  const w = cfg.weights;
  const wSum =
    w.reflectivity + w.echoTop + w.motionTowardUser + w.environmentBoost;
  const overall =
    ((zN * w.reflectivity +
      topN * w.echoTop +
      towardN * w.motionTowardUser +
      envBoost * w.environmentBoost) /
      wSum) *
    100;

  reasons.push(`max Z ${cell.maxDbz.toFixed(0)} dBZ`);
  reasons.push(
    `u tebe ~${hit.hitType} (miss ${hit.missKm.toFixed(1)} km` +
      (hit.atUserDbz != null ? `, ~${hit.atUserDbz.toFixed(0)} dBZ` : "") +
      `)`,
  );
  if (cell.echoTopSource === "CHMI") {
    reasons.push(`výška echa ${cell.echoTopKm.toFixed(1)} km (ČHMÚ)`);
  } else if (cell.echoTopKm >= cfg.echoTopKm.moderate) {
    reasons.push(`vrchol echa ~${cell.echoTopKm.toFixed(1)} km`);
  }
  if (cell.surfaceDbz != null && cell.surfaceDbz > 0) {
    reasons.push(`u země ~${cell.surfaceDbz.toFixed(0)} dBZ (PseudoCAPPI)`);
  }
  if (towardN > 0.5) {
    reasons.push(`směr k lokaci (úhel ${cell.approachAngleDeg.toFixed(0)}°)`);
  }

  const hailCm = estimateHailCm(
    cell.echoTopKm,
    cell.maxDbz,
    env?.freezingLevelM,
  );
  const rain = rainDbz != null ? estimateRainMmH(rainDbz) : null;
  const eta = estimateEtaMinutes(cell);

  const hailScore = hailCm != null ? clamp01(hailCm / 5) * 100 : topN * 40;
  const rainScore = rain != null ? clamp01(rain[1] / 60) * 100 : zN * 50;

  const supercell =
    clamp01(zN * 0.35 + topN * 0.35 + (env ? envBoost : 0.3) * 0.3) * 100;

  let tornado = 0;
  if (env && supercell >= stormConfig.severe.supercellScoreMin) {
    tornado =
      clamp01(
        ramp(env.srh01, stormConfig.formation.srh01.elevated, stormConfig.formation.srh01.extreme) *
          0.6 +
          (supercell / 100) * 0.4,
      ) * 100;
  }

  if (hailCm != null) {
    reasons.push(`riziko krup ~${hailCm} cm (proxy)`);
  }
  if (
    supercell >= stormConfig.severe.supercellScoreMin &&
    cell.maxDbz >= cfg.reflectivityDbz.strong
  ) {
    reasons.push(`prostředí vhodné pro supercelu (ne rotace)`);
  }

  const hazards: HazardScores = {
    overall,
    hail: hailScore,
    rain: rainScore,
    supercell,
    tornado,
  };

  return {
    kind: "active",
    cellId: cell.id,
    score: Math.round(overall),
    severity: strengthDbz != null
      ? severityFromDbz(strengthDbz)
      : severityFromDbz(cell.maxDbz),
    etaMinutes: eta,
    fromPlace: cell.fromPlace,
    maxDbz: cell.maxDbz,
    distanceToUserKm: cell.distanceToUserKm,
    hailCmMax: hailCm,
    rainMmPerHour: rain,
    hitType: hit.hitType,
    missKm: hit.missKm,
    atUserDbz: hit.atUserDbz,
    hazards,
    reasons,
  };
}

export function shouldAlertActive(a: ActiveStormAssessment): boolean {
  if (a.etaMinutes == null) return false;
  if (a.etaMinutes > stormConfig.active.etaAlertMaxMin) return false;
  // Blízko + smysluplné echo → varuj i při nižším overall skóre
  if (a.score >= 38 && a.etaMinutes <= 45) return true;
  return a.score >= stormConfig.active.alertScoreMin;
}

/** Zobrazit badge supercely — silné echo + vysoké skóre prostředí. */
export function showSupercellEnvBadge(a: ActiveStormAssessment): boolean {
  return (
    a.hazards.supercell >= stormConfig.severe.supercellScoreMin &&
    a.maxDbz >= stormConfig.active.reflectivityDbz.strong
  );
}
