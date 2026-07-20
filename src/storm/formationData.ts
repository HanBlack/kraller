import type { FeatureCollection } from "geojson";
import { fetchDataJson } from "../lib/dataUrls";
import { czechRegionLabel, isInCzechiaApprox } from "../lib/czechRegion";
import { distanceKm } from "../lib/geo";
import type { FormationZone } from "./demo";
import { isViableFormationEnv, scoreFormation } from "./scoreFormation";
import type { EnvironmentSignals, FormationAssessment } from "./types";
import type { FormationCellLink } from "./formationLinks";

export type FormationGridJson = {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  source?: string;
  points: Array<{
    lat: number;
    lon: number;
    environment: EnvironmentSignals;
  }>;
};

export type ScoredFormationPoint = {
  lat: number;
  lon: number;
  environment: EnvironmentSignals;
  assessment: FormationAssessment;
};

const FORMATION_GRID_URL = "data/formation/grid.json";
/** Menší clustery = přesnější pozice maxima. */
const CLUSTER_KM = 20;
/** Práh zóny — pod tím jen mřížkové tečky, ne kruh „Vznik“. */
const MIN_ZONE_SCORE = 28;
const FALLBACK_MIN_SCORE = 32;
const MIN_FALLBACK_ZONES = 4;
/** Více zón = méně slepých míst (víkend AT→CZ). */
const MAX_ZONES = 14;
/** U vyzrálejších buněk zónu Vznik schovej (už je echo). */
const RADAR_EXCLUDE_KM = 18;
const RADAR_EXCLUDE_MIN_AGE_MIN = 12;
/** Tečky setupu pod prahem hlavních zón (viditelný kontext). */
const HEAT_MIN_SCORE = 22;
const HEAT_MAX_POINTS = 48;

export async function loadFormationGrid(
  cacheBust?: number,
): Promise<FormationGridJson | null> {
  const data = await fetchDataJson<FormationGridJson>(
    FORMATION_GRID_URL,
    cacheBust,
  );
  if (!data?.points?.length) return null;
  return data;
}

export function scoreFormationGrid(
  grid: FormationGridJson,
): ScoredFormationPoint[] {
  return grid.points.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    environment: p.environment,
    assessment: scoreFormation(p.environment),
  }));
}

type RadarPeak = {
  lon: number;
  lat: number;
  ageMinutes: number;
};

function radarPeakCoords(cells: FeatureCollection): RadarPeak[] {
  const ageById = new Map<string, number>();
  for (const f of cells.features) {
    if (f.properties?.kind !== "cell") continue;
    const id = String(f.properties.id ?? "");
    if (!id) continue;
    ageById.set(
      id,
      Number(f.properties.ageMinutes ?? f.properties.historyMinutes ?? 99),
    );
  }

  const peaks: RadarPeak[] = [];
  for (const f of cells.features) {
    if (f.geometry?.type !== "Point") continue;
    const kind = f.properties?.kind;
    if (kind !== "peak" && f.properties?.maxDbz == null) continue;
    const id = String(f.properties?.cellId ?? f.properties?.id ?? "");
    const [lon, lat] = f.geometry.coordinates as [number, number];
    peaks.push({
      lon,
      lat,
      ageMinutes: ageById.get(id) ?? Number(f.properties?.ageMinutes ?? 99),
    });
  }
  return peaks;
}

function nearRadar(lat: number, lon: number, peaks: RadarPeak[]): boolean {
  for (const p of peaks) {
    // Nové / mladé echo: zónu vzniku nech — právě tam má smysl
    if (p.ageMinutes < RADAR_EXCLUDE_MIN_AGE_MIN) continue;
    if (distanceKm(lat, lon, p.lat, p.lon) <= RADAR_EXCLUDE_KM) return true;
  }
  return false;
}

/** Zóna Vznik jen v ČR (+ krátký okraj hranice) — mimo to popisky zbytečně šumí. */
const ZONE_CZ_MARGIN_KM = 8;

function zoneRelevantToCz(zone: FormationZone): boolean {
  return isInCzechiaApprox(zone.lat, zone.lon, ZONE_CZ_MARGIN_KM);
}

function pointToZone(
  cluster: ScoredFormationPoint[],
  suffix: string,
): FormationZone {
  // Střed = nejlepší bod (ne průměr clustrů) — jinak zóna „plave“ mimo maximum
  const best =
    cluster.reduce((a, b) =>
      b.assessment.score > a.assessment.score ? b : a,
    ) ?? cluster[0];
  const place = czechRegionLabel(best.lat, best.lon);

  const maxScore = best.assessment.score;
  const radiusKm = Math.min(
    18,
    Math.max(8, 7 + Math.min(cluster.length, 6) * 1.2 + (maxScore - 30) * 0.15),
  );

  return {
    id: `form-${best.lat.toFixed(2)}-${best.lon.toFixed(2)}${suffix}`,
    name: place,
    placeName: place,
    lat: best.lat,
    lon: best.lon,
    radiusKm,
    environment: best.environment,
  };
}

/** Sloučí blízké body s vysokým skóre do zón — jen realistické prostředí. */
export function clusterFormationZones(
  points: ScoredFormationPoint[],
  radarCells: FeatureCollection | null,
): FormationZone[] {
  const peaks = radarCells ? radarPeakCoords(radarCells) : [];
  const visible = points.filter(
    (p) =>
      isInCzechiaApprox(p.lat, p.lon, ZONE_CZ_MARGIN_KM) &&
      !nearRadar(p.lat, p.lon, peaks),
  );
  const candidates = visible
    .filter(
      (p) =>
        isViableFormationEnv(p.environment) &&
        p.assessment.score >= MIN_ZONE_SCORE,
    )
    .sort((a, b) => b.assessment.score - a.assessment.score);

  const used = new Set<number>();
  const zones: FormationZone[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    const seed = candidates[i];
    const cluster = [seed];
    used.add(i);

    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue;
      const other = candidates[j];
      if (distanceKm(seed.lat, seed.lon, other.lat, other.lon) <= CLUSTER_KM) {
        cluster.push(other);
        used.add(j);
      }
    }

    const zone = pointToZone(cluster, "");
    // Mimo ČR a steering sem nedojde (např. Vídeň → východ) = neukazovat
    if (!zoneRelevantToCz(zone)) continue;
    zones.push(zone);
  }

  if (zones.length === 0) {
    const fallback = visible
      .filter(
        (p) =>
          isViableFormationEnv(p.environment) &&
          p.assessment.score >= FALLBACK_MIN_SCORE,
      )
      .sort((a, b) => b.assessment.score - a.assessment.score)
      .slice(0, MIN_FALLBACK_ZONES * 3);
    for (const point of fallback) {
      const zone = pointToZone([point], "-fb");
      if (!zoneRelevantToCz(zone)) continue;
      zones.push(zone);
      if (zones.length >= MIN_FALLBACK_ZONES) break;
    }
  }

  return zones.slice(0, MAX_ZONES);
}

export function applyFormationLinks(
  zones: FormationZone[],
  links: FormationCellLink[],
): FormationZone[] {
  const byZone = new Map(links.map((l) => [l.zoneId, l]));
  return zones.map((z) => {
    const link = byZone.get(z.id);
    if (!link) return z;
    return {
      ...z,
      linkedCellId: link.cellId,
      linkedCellKm: Math.round(link.distanceKm),
    };
  });
}

/** Slabší tečky setupu — kde může něco vzniknout mimo top zóny. */
export function formationHeatGeoJSON(
  points: ScoredFormationPoint[],
  radarCells: FeatureCollection | null,
): FeatureCollection {
  const peaks = radarCells ? radarPeakCoords(radarCells) : [];
  const ranked = points
    .filter(
      (p) =>
        p.assessment.score >= HEAT_MIN_SCORE &&
        isViableFormationEnv(p.environment) &&
        isInCzechiaApprox(p.lat, p.lon, ZONE_CZ_MARGIN_KM) &&
        !nearRadar(p.lat, p.lon, peaks),
    )
    .sort((a, b) => b.assessment.score - a.assessment.score)
    .slice(0, HEAT_MAX_POINTS);

  return {
    type: "FeatureCollection",
    features: ranked.map((p) => ({
      type: "Feature" as const,
      properties: {
        score: Math.round(p.assessment.score),
        severity: p.assessment.severity,
      },
      geometry: {
        type: "Point" as const,
        coordinates: [p.lon, p.lat],
      },
    })),
  };
}

export async function buildRealFormationZones(
  radarCells: FeatureCollection | null,
  cacheBust?: number,
): Promise<{
  zones: FormationZone[];
  scoredPoints: ScoredFormationPoint[];
  real: boolean;
}> {
  const grid = await loadFormationGrid(cacheBust);
  if (!grid) return { zones: [], scoredPoints: [], real: false };
  const scored = scoreFormationGrid(grid);
  const zones = clusterFormationZones(scored, radarCells);
  return { zones, scoredPoints: scored, real: true };
}
