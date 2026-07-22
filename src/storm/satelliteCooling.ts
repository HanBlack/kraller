import { fetchDataJson } from "../lib/dataUrls";
import { distanceKm } from "../lib/geo";
import { stormConfig } from "./config";
import type { EnvironmentSignals } from "./types";

export type SatelliteCoolingPoint = {
  lat: number;
  lon: number;
  cloudTopTempC?: number;
  cloudTopCoolingCPer15min: number;
  cloudTopHeightM?: number;
  cloudTopHeightDeltaMPer15min?: number;
  sampleSource?: "grid" | "cell" | "formation";
};

export type SatelliteCoolingGrid = {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  source?: string;
  status: string;
  message?: string;
  dtMinutes: number;
  validAt?: string;
  points: SatelliteCoolingPoint[];
};

export type SatelliteTrend =
  | "growing"
  | "warming"
  | "steady"
  | "cold_top"
  | "tower_rising";

/** Satelitní vzorek u souřadnice buňky (MTG CTT + CTH). */
export type SatelliteSample = {
  available: true;
  distanceKm: number;
  exactMatch: boolean;
  cloudTopTempC?: number;
  /** Záporné = ochlazování vrcholu (°C / 15 min). */
  cloudTopCoolingCPer15min: number;
  cloudTopHeightM?: number;
  cloudTopHeightDeltaMPer15min?: number;
  trend: SatelliteTrend;
  coldTop: boolean;
  towerRising: boolean;
  towerFalling: boolean;
  validAt?: string;
};

export type SatelliteStatusLine = {
  title: string;
  detail: string;
};

const SAT_URL = "data/satellite/cooling.json";

export async function loadSatelliteCooling(
  cacheBust?: number,
): Promise<SatelliteCoolingGrid | null> {
  return fetchDataJson<SatelliteCoolingGrid>(SAT_URL, cacheBust);
}

export function isSatelliteCoolingLive(
  grid: SatelliteCoolingGrid | null | undefined,
): boolean {
  return grid?.status === "ok" && (grid.points?.length ?? 0) > 0;
}

export function satelliteGrowthRate(coolingPer15min: number): number {
  return Math.max(0, -coolingPer15min);
}

export function satelliteWarmingRate(coolingPer15min: number): number {
  return Math.max(0, coolingPer15min);
}

export function towerRiseRate(deltaMPer15min: number | undefined): number {
  return Math.max(0, deltaMPer15min ?? 0);
}

export function towerFallRate(deltaMPer15min: number | undefined): number {
  return Math.max(0, -(deltaMPer15min ?? 0));
}

function findNearestPoint(
  grid: SatelliteCoolingGrid,
  lat: number,
  lon: number,
): { point: SatelliteCoolingPoint; distanceKm: number } | null {
  if (!grid.points.length) return null;
  let best = grid.points[0];
  let bestD = Infinity;
  for (const p of grid.points) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { point: best, distanceKm: bestD };
}

export function classifySatelliteTrend(input: {
  coolingPer15min: number;
  cloudTopTempC?: number;
  heightDeltaMPer15min?: number;
}): SatelliteTrend {
  const cfg = stormConfig;
  const growth = satelliteGrowthRate(input.coolingPer15min);
  const rise = towerRiseRate(input.heightDeltaMPer15min);
  if (growth >= cfg.formation.cloudTopCoolingCPer15min.growing) return "growing";
  if (rise >= cfg.satellite.towerRisingMPer15min) return "tower_rising";
  if (
    input.cloudTopTempC != null &&
    input.cloudTopTempC <= cfg.satellite.coldTopTempC
  ) {
    return "cold_top";
  }
  if (input.coolingPer15min >= 1.5) return "warming";
  if (Math.abs(input.coolingPer15min) < 1) return "steady";
  return input.coolingPer15min > 0 ? "warming" : "steady";
}

export function sampleSatelliteCooling(
  grid: SatelliteCoolingGrid | null | undefined,
  lat: number,
  lon: number,
  maxKm = stormConfig.satellite.maxMatchKm,
): SatelliteSample | null {
  if (!isSatelliteCoolingLive(grid)) return null;
  const exactKm = stormConfig.satellite.exactMatchKm;
  const exact = grid!.points.find(
    (p) =>
      (p.sampleSource === "cell" || p.sampleSource === "formation") &&
      distanceKm(lat, lon, p.lat, p.lon) <= exactKm,
  );
  const hit = exact
    ? { point: exact, distanceKm: distanceKm(lat, lon, exact.lat, exact.lon) }
    : findNearestPoint(grid!, lat, lon);
  if (!hit || hit.distanceKm > maxKm) return null;

  const { point, distanceKm: dKm } = hit;
  const cooling = point.cloudTopCoolingCPer15min;
  const heightDelta = point.cloudTopHeightDeltaMPer15min;
  const coldTop =
    point.cloudTopTempC != null &&
    point.cloudTopTempC <= stormConfig.satellite.coldTopTempC;
  const towerRising =
    towerRiseRate(heightDelta) >= stormConfig.satellite.towerRisingMPer15min;
  const towerFalling =
    towerFallRate(heightDelta) >= stormConfig.satellite.towerFallingMPer15min;

  return {
    available: true,
    distanceKm: dKm,
    exactMatch: dKm <= exactKm && point.sampleSource === "cell",
    cloudTopTempC: point.cloudTopTempC,
    cloudTopCoolingCPer15min: cooling,
    cloudTopHeightM: point.cloudTopHeightM,
    cloudTopHeightDeltaMPer15min: heightDelta,
    trend: classifySatelliteTrend({
      coolingPer15min: cooling,
      cloudTopTempC: point.cloudTopTempC,
      heightDeltaMPer15min: heightDelta,
    }),
    coldTop,
    towerRising,
    towerFalling,
    validAt: grid!.validAt,
  };
}

/** Poctivý stav satelitu pro UI — pipeline běží, ale signál může chybět. */
export function explainSatelliteStatus(
  grid: SatelliteCoolingGrid | null | undefined,
  lat: number,
  lon: number,
): SatelliteStatusLine {
  if (!grid || grid.status === "no_credentials") {
    return {
      title: "Satelit",
      detail: "bez klíčů EUMETSAT — používáme model",
    };
  }
  if (grid.status !== "ok") {
    return {
      title: "Satelit",
      detail: grid.message ?? "data dočasně nedostupná",
    };
  }
  const sample = sampleSatelliteCooling(grid, lat, lon);
  if (!sample) {
    return {
      title: "Satelit (MTG)",
      detail: "v místě bez detekovaného vrcholu mraku — FCI nevidí cloud-top",
    };
  }
  if (sample.trend === "growing") {
    return {
      title: "Satelit (MTG)",
      detail: explainSatelliteGrowth(sample),
    };
  }
  if (sample.trend === "tower_rising") {
    return {
      title: "Satelit (MTG)",
      detail: explainSatelliteTowerRising(sample),
    };
  }
  if (sample.trend === "cold_top") {
    return {
      title: "Satelit (MTG)",
      detail: explainSatelliteColdTop(sample),
    };
  }
  if (sample.trend === "warming" || sample.towerFalling) {
    return {
      title: "Satelit (MTG)",
      detail: explainSatelliteWarming(sample),
    };
  }
  const temp =
    sample.cloudTopTempC != null
      ? `vrchol ~${sample.cloudTopTempC.toFixed(0)} °C`
      : "vrchol detekován";
  return {
    title: "Satelit (MTG)",
    detail: `${temp} — stabilní (ΔT ≈ 0 za 15 min), bez signálu růstu`,
  };
}

export function explainSatelliteGrowth(sample: SatelliteSample): string {
  const rate = satelliteGrowthRate(sample.cloudTopCoolingCPer15min);
  return `vrchol mraku se ochlazuje (satelit −${rate.toFixed(1)} °C / 15 min) — konvekce roste nahoře`;
}

export function explainSatelliteTowerRising(sample: SatelliteSample): string {
  const km = towerRiseRate(sample.cloudTopHeightDeltaMPer15min) / 1000;
  return `věž mraku stoupá (satelit +${km.toFixed(1)} km / 15 min) — konvekce se prohlubuje`;
}

export function explainSatelliteTowerFalling(sample: SatelliteSample): string {
  const km = towerFallRate(sample.cloudTopHeightDeltaMPer15min) / 1000;
  return `věž mraku klesá (satelit −${km.toFixed(1)} km / 15 min) — konvekce slábne nahoře`;
}

export function explainSatelliteColdTop(sample: SatelliteSample): string {
  const t = sample.cloudTopTempC ?? stormConfig.satellite.coldTopTempC;
  return `studený vrchol mraku (~${t.toFixed(0)} °C) — hluboká konvekce nahoře`;
}

export function explainSatelliteWarming(sample: SatelliteSample): string {
  if (sample.towerFalling) {
    return explainSatelliteTowerFalling(sample);
  }
  const rate = satelliteWarmingRate(sample.cloudTopCoolingCPer15min);
  return `vrchol mraku se otepluje (satelit +${rate.toFixed(1)} °C / 15 min) — konvekce nahoře slábne`;
}

/** Všechny sat signály pro lifecycle (priorita). */
export function satelliteReasonLines(sample: SatelliteSample): string[] {
  const lines: string[] = [];
  if (sample.trend === "growing") lines.push(explainSatelliteGrowth(sample));
  if (sample.towerRising) lines.push(explainSatelliteTowerRising(sample));
  if (sample.coldTop && sample.trend !== "growing") {
    lines.push(explainSatelliteColdTop(sample));
  }
  if (sample.trend === "warming" || sample.towerFalling) {
    lines.push(explainSatelliteWarming(sample));
  }
  return lines;
}

/** Preferuj sat u jádra před formation grid proxy. */
export function mergeSatelliteIntoEnv(
  env: EnvironmentSignals,
  sample: SatelliteSample | null | undefined,
): EnvironmentSignals {
  if (!sample) return env;
  return {
    ...env,
    cloudTopCoolingCPer15min: sample.cloudTopCoolingCPer15min,
    coolingSource: "satellite",
    cloudTopTempC: sample.cloudTopTempC,
    cloudTopHeightM: sample.cloudTopHeightM,
    cloudTopHeightDeltaMPer15min: sample.cloudTopHeightDeltaMPer15min,
  };
}
