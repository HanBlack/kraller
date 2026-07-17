/**
 * Jednotná pravidla pro zrod, stopu a trajektorii bouřek.
 * Směr: deep-layer vítr (850+500) je priorita — buňky většinou jedou s ním.
 * Radarovou stopu bereme jen když je konzistentní a sedí s větrem.
 */

import { angleDiffDeg, bearingDeg, distanceKm } from "../lib/geo";
import { stormSteeringMotion, type WindGrid } from "../lib/windField";

/** Max. důvěryhodná rychlost buňky z OPERA matchingu (km/h). */
export const MAX_TRUSTED_TRACK_KMH = 70;
/** Nad touto rychlostí + konfliktem s větrem → čistý vítr. */
export const FAST_TRACK_KMH = 32;
/** Tvrdý konflikt radar vs steering → vítr. */
export const MAX_WIND_CONFLICT_DEG = 55;
/** Mírný konflikt → blend s převahou větru. */
export const SOFT_WIND_CONFLICT_DEG = 28;
/** Max. nesoulad dvou po sobě jdoucích radarových segmentů. */
export const MAX_SEGMENT_JITTER_DEG = 40;

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
 * Vyžaduje shodu sousedních segmentů — jinak radarovou stopu zahodíme.
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

  const a = recent[0];
  const b = recent[recent.length - 1];
  return segmentMotion(a, b);
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
 * Trajektorie buňky: deep-layer vítr je priorita.
 * Radar jen když je konzistentní a úhel s větrem je malý.
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

  // Pipeline track bez historie: méně důvěry — jen pokud sedí s větrem
  const fromPipelineOnly = fromHist == null && radarH != null && radarS != null;

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

  // Tvrdý konflikt → vždy vítr (i při nižší rychlosti)
  if (diff > MAX_WIND_CONFLICT_DEG) {
    return {
      ...steering,
      source: "wind-fallback",
      reason: `konflikt radar↔vítr ${diff.toFixed(0)}°`,
    };
  }

  // Rychlý radar + střední konflikt → vítr
  if (diff > SOFT_WIND_CONFLICT_DEG && radarS! >= FAST_TRACK_KMH) {
    return {
      ...steering,
      source: "wind-fallback",
      reason: `rychlý track vs vítr ${diff.toFixed(0)}°`,
    };
  }

  // Pipeline-only (bez multi-frame historie) → silně větru
  if (fromPipelineOnly && diff > 20) {
    const blended = blendMotion(
      radarH!,
      Math.min(55, radarS!),
      steering.headingDeg,
      steering.speedKmh,
      0.75,
    );
    return {
      ...blended,
      source: "wind-fallback",
      reason: `pipeline track + vítr (diff ${diff.toFixed(0)}°)`,
    };
  }

  // Mírný konflikt → blend s převahou větru (buňky jedou se steeringem)
  if (diff > SOFT_WIND_CONFLICT_DEG) {
    const blended = blendMotion(
      radarH!,
      Math.min(55, radarS!),
      steering.headingDeg,
      steering.speedKmh,
      0.65,
    );
    return {
      ...blended,
      source: "wind-fallback",
      reason: `blend vítr+radar (diff ${diff.toFixed(0)}°)`,
    };
  }

  // Dobrá shoda → radarová stopa (jemně přikloněná k větru)
  const trusted = blendMotion(
    radarH!,
    Math.min(55, radarS!),
    steering.headingDeg,
    steering.speedKmh,
    0.25,
  );
  return {
    ...trusted,
    source: "radar-track",
    reason: "radar sedí s větrem",
  };
}

/** Max. vzdálenost matchování mezi framy (km) — proti skokům identity. */
export function maxMatchDistanceKm(dtMinutes: number): number {
  const dt = Math.max(1, dtMinutes);
  // ~55 km/h + 2.5 km jitter peaku; strop 12 km (~5min)
  return Math.min(12, 2.5 + (dt / 60) * 55);
}
