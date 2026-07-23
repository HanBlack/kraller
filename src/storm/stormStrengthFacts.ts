import type { Severity } from "../lib/severity";
import { estimateRainMmH } from "../storm/hitAtUser";
import type { CellHistoryPoint } from "../storm/radarCells";
import type { SatelliteSample } from "../storm/satelliteCooling";
import {
  formatCloudHeightKm,
  resolveCloudHeight,
  type CloudHeightReading,
} from "../storm/stormCloudHeight";
import type { TrackedCell } from "../storm/radarCells";

export type DbzTrend = {
  /** Δ dBZ přes okno (kladné = sílí). */
  deltaDbz: number;
  /** Skutečná délka okna (min). */
  windowMin: number;
  fromDbz: number;
  toDbz: number;
};

/**
 * Krátký trend dBZ z historie buňky (~15–25 min dozadu).
 * Null = málo bodů / příliš krátké okno → neukazovat.
 */
export function recentDbzTrend(
  history: CellHistoryPoint[] | undefined,
  currentDbz: number,
  preferWindowMin = 20,
): DbzTrend | null {
  if (!history || history.length < 2) return null;
  if (!Number.isFinite(currentDbz)) return null;

  const last = history[history.length - 1]!;
  const age = last.minutesFromBirth;
  if (!Number.isFinite(age) || age < 10) return null;

  const targetAge = age - preferWindowMin;
  let best = history[0]!;
  for (const h of history) {
    if (h.minutesFromBirth <= targetAge) best = h;
    else break;
  }

  const span = age - best.minutesFromBirth;
  if (span < 12) return null;
  if (history.length < 3 && span < 18) return null;

  const fromDbz = best.maxDbz;
  const toDbz = currentDbz;
  if (!Number.isFinite(fromDbz)) return null;

  return {
    deltaDbz: Math.round((toDbz - fromDbz) * 10) / 10,
    windowMin: Math.round(span),
    fromDbz: Math.round(fromDbz * 10) / 10,
    toDbz: Math.round(toDbz * 10) / 10,
  };
}

/** Lidský stupeň blískavosti z MTG LI (15min součet → rate). */
export type LightningActivityLevel =
  | "none"
  | "occasional"
  | "frequent"
  | "very_frequent";

export type LightningActivity = {
  level: LightningActivityLevel;
  flashes15min: number;
  /** Zaokrouhlené blesky/min pro UI (min. 1 když je aspoň jeden flash). */
  ratePerMin: number;
};

/**
 * Agresivita blesků: flash rate z 15min okna.
 * 0 → none; &lt;1/min → občas; 1–5/min → časté; ≥5/min → velmi časté.
 */
export function lightningActivityFromFlashes15min(
  flashes: number | null | undefined,
): LightningActivity | null {
  if (flashes == null || !Number.isFinite(flashes)) return null;
  const n = Math.max(0, Math.round(flashes));
  if (n === 0) {
    return { level: "none", flashes15min: 0, ratePerMin: 0 };
  }
  const ratePerMin = Math.max(1, Math.round(n / 15));
  const level: LightningActivityLevel =
    n < 15 ? "occasional" : n < 75 ? "frequent" : "very_frequent";
  return { level, flashes15min: n, ratePerMin };
}

export type StormStrengthFacts = {
  cloudHeight: CloudHeightReading | null;
  cloudTopTempC: number | null;
  lightningFlashes15min: number | null;
  lightningActivity: LightningActivity | null;
  dbzTrend: DbzTrend | null;
  ageMinutes: number | null;
  growthDbz: number | null;
  dualpolLabel: TrackedCell["dualpolLabel"] | null;
  dualpolHailLikely: boolean;
  maxDbz: number | null;
  severity: Severity | null;
  /** Odhad mm/h z jádra — stejná tabulka jako na mapě. */
  rainMmH: [number, number] | null;
};

export function buildStormStrengthFacts(input: {
  maxDbz?: number | null;
  severity?: Severity | null;
  echoTopKm?: number | null;
  ageMinutes?: number | null;
  growthDbz?: number | null;
  history?: CellHistoryPoint[];
  satAtPeak?: SatelliteSample | null;
  /** Live sat cooling běží — teprve pak ukazuj blesky / CTT. */
  satLive?: boolean;
  dualpolLabel?: TrackedCell["dualpolLabel"] | null;
  dualpolHailLikely?: boolean;
  envCloudTopHeightM?: number | null;
}): StormStrengthFacts {
  const sat = input.satAtPeak ?? null;
  const satLive = Boolean(input.satLive);
  const lightningRaw =
    satLive && sat != null && sat.lightningFlashes15min != null
      ? sat.lightningFlashes15min
      : null;
  const lightning =
    lightningRaw != null && Number.isFinite(lightningRaw)
      ? Math.max(0, Math.round(lightningRaw))
      : null;
  const ctt =
    satLive &&
    sat?.cloudTopTempC != null &&
    Number.isFinite(sat.cloudTopTempC)
      ? Math.round(sat.cloudTopTempC)
      : null;
  const maxDbz =
    input.maxDbz != null && Number.isFinite(input.maxDbz)
      ? Math.round(input.maxDbz)
      : null;
  const rainMmH =
    maxDbz != null ? (estimateRainMmH(maxDbz) as [number, number] | null) : null;

  return {
    cloudHeight: resolveCloudHeight({
      cloudTopHeightM: sat?.cloudTopHeightM ?? input.envCloudTopHeightM,
      echoTopKm: input.echoTopKm,
    }),
    cloudTopTempC: ctt,
    lightningFlashes15min: lightning,
    lightningActivity: lightningActivityFromFlashes15min(lightning),
    dbzTrend: recentDbzTrend(input.history, input.maxDbz ?? NaN),
    ageMinutes:
      input.ageMinutes != null && Number.isFinite(input.ageMinutes)
        ? Math.round(input.ageMinutes)
        : null,
    growthDbz:
      input.growthDbz != null && Number.isFinite(input.growthDbz)
        ? Math.round(input.growthDbz * 10) / 10
        : null,
    dualpolLabel: input.dualpolLabel ?? null,
    dualpolHailLikely: Boolean(input.dualpolHailLikely),
    maxDbz,
    severity: input.severity ?? null,
    rainMmH,
  };
}

export { formatCloudHeightKm };
