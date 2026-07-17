/**
 * Jednotná pravidla pro zrod, stopu a trajektorii bouřek.
 * Cíl: stejné falešné případy (silný „zrod“, divoká rychlost, konflikt s větrem)
 * se nevrací — logika je tady, testovaná, používaná ve frontendu i verify.
 */

import { angleDiffDeg, bearingDeg, distanceKm } from "../lib/geo";
import { stormSteeringMotion, type WindGrid } from "../lib/windField";

/** Max. důvěryhodná rychlost buňky z OPERA matchingu (km/h). */
export const MAX_TRUSTED_TRACK_KMH = 70;
/** Nad touto rychlostí + konfliktem s větrem → steering. */
export const FAST_TRACK_KMH = 40;
/** Max. úhel konfliktu radar vs steering, než mistrujeme radar. */
export const MAX_WIND_CONFLICT_DEG = 85;
/** Mírný konflikt → blend (kalibrace: T+15 medián ~5 km — nechat radar dominantní). */
export const SOFT_WIND_CONFLICT_DEG = 50;

/** První detekce se smí jmenovat „zrod“ jen pokud byla slabá. */
export const TRUE_BIRTH_MAX_DBZ = 38;
export const TRUE_BIRTH_MAX_AGE_MIN = 18;
/** Historické okno OPERA — věk == okno ⇒ spíš příjezd než zrod. */
export const HISTORY_WINDOW_MIN = 25;

export type BirthClassification = {
  trueBirth: boolean;
  isNewborn: boolean;
  phase: "birth" | "growing" | "mature" | "moving";
  /** Pro UI / verify. */
  reason: string;
};

export function classifyBirth(input: {
  birthDbz: number;
  ageMinutes: number;
  growthDbz: number;
  maxDbz: number;
  pipelineNewborn?: boolean;
  motionFromRadar?: boolean;
}): BirthClassification {
  const {
    birthDbz,
    ageMinutes,
    growthDbz,
    pipelineNewborn = false,
    motionFromRadar = false,
  } = input;

  // Silné echo hned na začátku historie = bouřka sem dorazila / okno začalo pozdě
  if (birthDbz > TRUE_BIRTH_MAX_DBZ) {
    return {
      trueBirth: false,
      isNewborn: false,
      phase: ageMinutes >= 15 && motionFromRadar ? "moving" : "mature",
      reason: `birthDbz ${birthDbz.toFixed(0)} > ${TRUE_BIRTH_MAX_DBZ} (první detekce ≠ zrod)`,
    };
  }

  if (ageMinutes >= HISTORY_WINDOW_MIN) {
    return {
      trueBirth: false,
      isNewborn: false,
      phase: motionFromRadar ? "moving" : "mature",
      reason: `age ${ageMinutes} min ≥ okno historie ${HISTORY_WINDOW_MIN} min`,
    };
  }

  const trueBirth =
    birthDbz <= TRUE_BIRTH_MAX_DBZ &&
    ageMinutes <= TRUE_BIRTH_MAX_AGE_MIN &&
    (pipelineNewborn || growthDbz >= 2) &&
    ageMinutes < HISTORY_WINDOW_MIN;

  if (!trueBirth) {
    return {
      trueBirth: false,
      isNewborn: false,
      phase: ageMinutes >= 15 && motionFromRadar ? "moving" : "mature",
      reason: "nesplněna kritéria skutečného zrodu",
    };
  }

  const isNewborn = ageMinutes <= 10;
  if (isNewborn) {
    return {
      trueBirth: true,
      isNewborn: true,
      phase: "birth",
      reason: "slabé nové echo",
    };
  }
  if (growthDbz >= 3 && ageMinutes <= 30) {
    return {
      trueBirth: true,
      isNewborn: false,
      phase: "growing",
      reason: "zrod + růst dBZ",
    };
  }
  return {
    trueBirth: true,
    isNewborn: false,
    phase: "mature",
    reason: "zrod v okně, už ne newborn",
  };
}

export type HistoryPeak = {
  peak: [number, number];
  minutesFromBirth: number;
};

/** Pohyb z posledních 2–3 framů; null = nedůvěryhodné. */
export function recentRadarMotion(
  history: HistoryPeak[] | undefined,
): { headingDeg: number; speedKmh: number } | null {
  if (!history || history.length < 2) return null;
  const recent = history.length >= 3 ? history.slice(-3) : history;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dtMin = Math.max(1, b.minutesFromBirth - a.minutesFromBirth);
  const dist = distanceKm(a.peak[1], a.peak[0], b.peak[1], b.peak[0]);
  const speedKmh = (dist / dtMin) * 60;
  if (
    !Number.isFinite(speedKmh) ||
    speedKmh < 5 ||
    speedKmh > MAX_TRUSTED_TRACK_KMH
  ) {
    return null;
  }
  return {
    headingDeg: bearingDeg(a.peak[1], a.peak[0], b.peak[1], b.peak[0]),
    speedKmh,
  };
}

function blendMotion(
  h1: number,
  s1: number,
  h2: number,
  s2: number,
  weight2: number,
): { headingDeg: number; speedKmh: number } {
  const w2 = Math.max(0, Math.min(1, weight2));
  const w1 = 1 - w2;
  const r1 = (h1 * Math.PI) / 180;
  const r2 = (h2 * Math.PI) / 180;
  const u = w1 * Math.sin(r1) * s1 + w2 * Math.sin(r2) * s2;
  const v = w1 * Math.cos(r1) * s1 + w2 * Math.cos(r2) * s2;
  return {
    headingDeg: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
    speedKmh: Math.hypot(u, v),
  };
}

export type CellMotionResult = {
  headingDeg: number;
  speedKmh: number;
  source: "radar-track" | "wind-fallback";
  reason: string;
};

/**
 * Trajektorie buňky: recent radar → jinak deep-layer 850+500.
 * Divoké / konfliktní stopy se zahodí (prevence falešných šipek).
 */
export function resolveCellMotion(
  cell: {
    peak: [number, number];
    trackHeadingDeg?: number | null;
    trackSpeedKmh?: number | null;
    history?: HistoryPeak[];
  },
  windLow: WindGrid | null,
  windUpper: WindGrid | null = null,
): CellMotionResult {
  const steering = stormSteeringMotion(
    windLow,
    windUpper,
    cell.peak[0],
    cell.peak[1],
  );

  const fromHist = recentRadarMotion(cell.history);
  let radarH =
    fromHist?.headingDeg ??
    (cell.trackHeadingDeg != null && Number.isFinite(cell.trackHeadingDeg)
      ? cell.trackHeadingDeg
      : null);
  let radarS =
    fromHist?.speedKmh ??
    (cell.trackSpeedKmh != null && Number.isFinite(cell.trackSpeedKmh)
      ? cell.trackSpeedKmh
      : null);

  if (radarS != null && radarS > MAX_TRUSTED_TRACK_KMH) {
    return {
      ...steering,
      source: "wind-fallback",
      reason: `track ${radarS.toFixed(0)} km/h > ${MAX_TRUSTED_TRACK_KMH}`,
    };
  }

  const hasRadar =
    radarH != null &&
    radarS != null &&
    radarS >= 5 &&
    radarS <= MAX_TRUSTED_TRACK_KMH;

  if (!hasRadar) {
    return {
      ...steering,
      source: "wind-fallback",
      reason: "bez důvěryhodné radarové stopy",
    };
  }

  const diff = angleDiffDeg(radarH!, steering.headingDeg);
  if (diff > MAX_WIND_CONFLICT_DEG && radarS! >= FAST_TRACK_KMH) {
    return {
      ...steering,
      source: "wind-fallback",
      reason: `konflikt radar↔vítr ${diff.toFixed(0)}° při ${radarS!.toFixed(0)} km/h`,
    };
  }
  if (diff > SOFT_WIND_CONFLICT_DEG) {
    const blended = blendMotion(
      radarH!,
      Math.min(60, radarS!),
      steering.headingDeg,
      steering.speedKmh,
      0.4,
    );
    return {
      ...blended,
      source: "radar-track",
      reason: `blend radar+vítr (diff ${diff.toFixed(0)}°)`,
    };
  }
  return {
    headingDeg: radarH!,
    speedKmh: Math.min(60, radarS!),
    source: "radar-track",
    reason: "recent radar track",
  };
}

/** Max. vzdálenost matchování mezi framy (km) — proti skokům identity. */
export function maxMatchDistanceKm(dtMinutes: number): number {
  const dt = Math.max(1, dtMinutes);
  // ~55 km/h + 2.5 km jitter peaku; strop 12 km (~5min)
  return Math.min(12, 2.5 + (dt / 60) * 55);
}
