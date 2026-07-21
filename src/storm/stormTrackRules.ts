/**
 * Jednotná pravidla pro zrod, stopu a trajektorii bouřek.
 * Směr šipek = vždy deep-layer vítr (850+500). Radar jen ladí rychlost,
 * když je stopa konzistentní a sedí se směrem větru.
 */

import { angleDiffDeg, bearingDeg, distanceKm } from "../lib/geo";
import { stormSteeringMotion, type WindGrid } from "../lib/windField";

/** Max. důvěryhodná rychlost buňky z OPERA matchingu (km/h). */
export const MAX_TRUSTED_TRACK_KMH = 70;
/** Max. úhel radar vs vítr, aby se brala radarová rychlost. */
export const MAX_WIND_ALIGN_DEG = 35;
/** Max. nesoulad dvou po sobě jdoucích radarových segmentů. */
export const MAX_SEGMENT_JITTER_DEG = 55;

/** @deprecated — ponecháno kvůli testům / kalibraci */
export const FAST_TRACK_KMH = 32;
/** @deprecated */
export const MAX_WIND_CONFLICT_DEG = 55;
/** @deprecated */
export const SOFT_WIND_CONFLICT_DEG = 28;

/** První detekce se smí jmenovat „zrod“ jen pokud byla slabá. */
export const TRUE_BIRTH_MAX_DBZ = 39;
export const TRUE_BIRTH_MAX_AGE_MIN = 10;
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

function segmentMotion(
  a: HistoryPeak,
  b: HistoryPeak,
): { headingDeg: number; speedKmh: number } | null {
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

/**
 * Pohyb z posledních 2–3 framů; null = nedůvěryhodné (skoky peaku / špatný match).
 */
export function recentRadarMotion(
  history: HistoryPeak[] | undefined,
): { headingDeg: number; speedKmh: number } | null {
  if (!history || history.length < 2) return null;
  const recent = history.length >= 3 ? history.slice(-3) : history;

  if (recent.length >= 3) {
    const s1 = segmentMotion(recent[0], recent[1]);
    const s2 = segmentMotion(recent[1], recent[2]);
    if (!s1 || !s2) return null;
    if (angleDiffDeg(s1.headingDeg, s2.headingDeg) > MAX_SEGMENT_JITTER_DEG) {
      return null;
    }
  }

  return segmentMotion(recent[0], recent[recent.length - 1]);
}

export type CellMotionResult = {
  headingDeg: number;
  speedKmh: number;
  source: "radar-track" | "wind-fallback";
  reason: string;
};

/**
 * Směr = vždy steering vítr (850+500).
 * Rychlost = radar, jen když stopa sedí se směrem větru; jinak rychlost větru.
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
  const radarH =
    fromHist?.headingDeg ??
    (cell.trackHeadingDeg != null && Number.isFinite(cell.trackHeadingDeg)
      ? cell.trackHeadingDeg
      : null);
  const radarS =
    fromHist?.speedKmh ??
    (cell.trackSpeedKmh != null && Number.isFinite(cell.trackSpeedKmh)
      ? cell.trackSpeedKmh
      : null);

  const hasRadarSpeed =
    radarH != null &&
    radarS != null &&
    radarS >= 5 &&
    radarS <= MAX_TRUSTED_TRACK_KMH &&
    angleDiffDeg(radarH, steering.headingDeg) <= MAX_WIND_ALIGN_DEG;

  if (hasRadarSpeed) {
    // Směr větru, rychlost z radaru (typicky o něco realističtější než model)
    const speed = Math.min(
      58,
      Math.max(8, 0.7 * radarS! + 0.3 * steering.speedKmh),
    );
    return {
      headingDeg: steering.headingDeg,
      speedKmh: speed,
      source: "radar-track",
      reason: "směr vítr · rychlost radar",
    };
  }

  return {
    headingDeg: steering.headingDeg,
    speedKmh: steering.speedKmh,
    source: "wind-fallback",
    reason: "směr i rychlost z řídícího větru",
  };
}

/** Max. vzdálenost matchování mezi framy (km) — proti skokům identity. */
export function maxMatchDistanceKm(dtMinutes: number): number {
  const dt = Math.max(1, dtMinutes);
  return Math.min(12, 2.5 + (dt / 60) * 55);
}
