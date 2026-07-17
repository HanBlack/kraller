import { distanceKm } from "../lib/geo";
import type { ScoredFormationPoint } from "./formationData";
import { explainBirthWhy, type BirthFactor } from "./birthWhy";
import type { EnvironmentSignals } from "./types";

export function nearestFormationPoint(
  lat: number,
  lon: number,
  points: ScoredFormationPoint[],
  maxKm = 55,
): ScoredFormationPoint | null {
  if (!points.length) return null;
  let best: ScoredFormationPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > maxKm) return null;
  return best;
}

export type BirthEnvironment = {
  environment: EnvironmentSignals;
  score: number;
  whyHeadline: string;
  whyPrimary: string;
  whyReasons: string[];
  whyFactors: BirthFactor[];
  shearMs: number | null;
  uncertain: boolean;
};

export function birthEnvironmentAt(
  lat: number,
  lon: number,
  points: ScoredFormationPoint[],
): BirthEnvironment | null {
  const near = nearestFormationPoint(lat, lon, points);
  if (!near) return null;
  const why = explainBirthWhy(near.environment, near.assessment, {
    lat,
    lon,
    nearbyPoints: points,
  });
  return {
    environment: near.environment,
    score: why.score,
    whyHeadline: why.headline,
    whyPrimary: why.primary,
    whyReasons: why.reasons,
    whyFactors: why.factors,
    shearMs: why.shearMs,
    uncertain: why.uncertain,
  };
}
