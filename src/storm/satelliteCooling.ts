import { fetchDataJson } from "../lib/dataUrls";
import { distanceKm } from "../lib/geo";
import { stormConfig } from "./config";
import type { EnvironmentSignals } from "./types";

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
  points: Array<{
    lat: number;
    lon: number;
    cloudTopTempC?: number;
    cloudTopCoolingCPer15min: number;
  }>;
};

export type SatelliteTrend = "growing" | "warming" | "steady" | "unavailable";

/** Satelitní vzorek u souřadnice buňky (MTG cloud-top ΔT). */
export type SatelliteSample = {
  available: true;
  distanceKm: number;
  cloudTopTempC?: number;
  /** Záporné = ochlazování vrcholu (°C / 15 min). */
  cloudTopCoolingCPer15min: number;
  trend: SatelliteTrend;
  validAt?: string;
};

const MAX_MATCH_KM = 55;
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

export function classifySatelliteTrend(coolingPer15min: number): SatelliteTrend {
  const cfg = stormConfig.formation.cloudTopCoolingCPer15min;
  const growth = Math.max(0, -coolingPer15min);
  if (growth >= cfg.growing) return "growing";
  if (coolingPer15min >= 1.5) return "warming";
  if (Math.abs(coolingPer15min) < 1) return "steady";
  return coolingPer15min > 0 ? "warming" : "steady";
}

export function sampleSatelliteCooling(
  grid: SatelliteCoolingGrid | null | undefined,
  lat: number,
  lon: number,
  maxKm = MAX_MATCH_KM,
): SatelliteSample | null {
  if (!isSatelliteCoolingLive(grid)) return null;
  const points = grid!.points;
  let best = points[0];
  let bestD = Infinity;
  for (const p of points) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (bestD > maxKm) return null;
  const cooling = best.cloudTopCoolingCPer15min;
  return {
    available: true,
    distanceKm: bestD,
    cloudTopTempC: best.cloudTopTempC,
    cloudTopCoolingCPer15min: cooling,
    trend: classifySatelliteTrend(cooling),
    validAt: grid!.validAt,
  };
}

export function satelliteGrowthRate(coolingPer15min: number): number {
  return Math.max(0, -coolingPer15min);
}

export function satelliteWarmingRate(coolingPer15min: number): number {
  return Math.max(0, coolingPer15min);
}

export function explainSatelliteGrowth(sample: SatelliteSample): string {
  const rate = satelliteGrowthRate(sample.cloudTopCoolingCPer15min);
  return `vrchol mraku se ochlazuje (satelit −${rate.toFixed(1)} °C / 15 min) — konvekce roste nahoře`;
}

export function explainSatelliteWarming(sample: SatelliteSample): string {
  const rate = satelliteWarmingRate(sample.cloudTopCoolingCPer15min);
  return `vrchol mraku se otepluje (satelit +${rate.toFixed(1)} °C / 15 min) — konvekce nahoře slábne`;
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
  };
}
