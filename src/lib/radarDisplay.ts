import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import { isInCzechiaApprox } from "./czechRegion";

/** Uvnitř ČR (+ malý okraj) plný radar včetně slabého okraje. */
export const CZ_RADAR_FULL_MARGIN_KM = 25;
/**
 * Mimo ČR jen meaningful déšť — bez drobných zelených fleků ~30 dBZ.
 * (okraj/echo zůstává v ČR)
 */
export const OUTSIDE_CZ_MIN_DBZ = 40;

function ringCentroid(ring: Position[]): { lon: number; lat: number } | null {
  if (!ring.length) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of ring) {
    if (p.length < 2) continue;
    sx += Number(p[0]);
    sy += Number(p[1]);
    n += 1;
  }
  if (n === 0) return null;
  return { lon: sx / n, lat: sy / n };
}

function featureLonLat(f: Feature): { lon: number; lat: number } | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Point") {
    const [lon, lat] = g.coordinates;
    return { lon, lat };
  }
  if (g.type === "Polygon") {
    return ringCentroid((g as Polygon).coordinates[0] ?? []);
  }
  if (g.type === "MultiPolygon") {
    const ring = g.coordinates[0]?.[0];
    return ring ? ringCentroid(ring) : null;
  }
  return null;
}

function featureDbz(f: Feature): number {
  const p = f.properties ?? {};
  if (typeof p.dbz === "number") return p.dbz;
  const band = String(p.band ?? "");
  if (band === "light") return 30;
  if (band === "echo") return 35;
  if (band === "rain") return 40;
  if (band === "moderate") return 45;
  if (band === "strong") return 50;
  if (band === "heavy") return 55;
  if (band === "extreme" || band === "core") return 60;
  return 0;
}

/**
 * Radar display: v ČR plný detail; mimo ČR jen ≥ OUTSIDE_CZ_MIN_DBZ.
 */
export function filterRadarForCzFocus(
  fc: FeatureCollection,
  marginKm = CZ_RADAR_FULL_MARGIN_KM,
  outsideMinDbz = OUTSIDE_CZ_MIN_DBZ,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fc.features.filter((f) => {
      const pos = featureLonLat(f);
      if (!pos) return false;
      if (isInCzechiaApprox(pos.lat, pos.lon, marginKm)) return true;
      return featureDbz(f) >= outsideMinDbz;
    }),
  };
}
