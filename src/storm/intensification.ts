import type { FeatureCollection, Polygon } from "geojson";
import { destinationPoint, distanceKm } from "../lib/geo";
import { stormConfig } from "./config";
import {
  meanForecastDelta,
  peakAtForecastMinutes,
} from "./radarCells";
import type { ScoredFormationPoint } from "./formationData";
import { circlePolygon } from "./mapFeatures";
import type { EnvironmentSignals } from "./types";
import { dewpointCOr } from "./types";

/** Minimální tvar buňky pro predikci zesílení (bez kruhu s radarCells). */
export type IntensTrackCell = {
  id: string;
  maxDbz: number;
  peak: [number, number];
  headingDeg: number;
  speedKmh: number;
  /** Změna dBZ od zrodu / historie — záporné = slábne. */
  growthDbz?: number;
};

export type IntensSegment = {
  etaMin: number;
  etaMax: number;
  score: number;
  expectedDbz: number;
  headroomDbz: number;
  /** Střed segmentu [lon, lat]. */
  center: [number, number];
  /** Úsek stopy [lon, lat][]. */
  path: [number, number][];
};

export type CellIntensification = {
  cellId: string;
  /** Max skóre zesílení podél stopy. */
  score: number;
  /** První ETA vstupu do zóny zesílení. */
  enterEtaMin: number | null;
  /** Očekávané max dBZ po průchodu zónou. */
  peakExpectedDbz: number;
  segments: IntensSegment[];
  willIntensify: boolean;
  /** Proč zesílí — headline + body. */
  whyHeadline?: string;
  whyReasons?: string[];
  /** Body podél stopy pro růst/rozpad v čase. */
  timeline: Array<{
    eta: number;
    expectedDbz: number;
    score: number;
  }>;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Teoretický strop odrazivosti, který prostředí umí „uživit“ (střední Evropa). */
export function envPotentialDbz(env: EnvironmentSignals): number {
  let dbz = 36;
  if (env.capeJkg >= 1000) dbz = 58;
  else if (env.capeJkg >= 600) dbz = 54;
  else if (env.capeJkg >= 300) dbz = 50;
  else if (env.capeJkg >= 150) dbz = 47;
  else if (env.capeJkg >= 80) dbz = 44;
  else if (env.capeJkg >= 40) dbz = 41;
  else if (env.capeJkg >= 20) dbz = 38;
  else dbz = 35;

  const dew = dewpointCOr(env);
  if (dew >= 17) dbz += 3;
  else if (dew >= 15) dbz += 2;
  else if (dew >= 13) dbz += 1;
  else if (dew < 10) dbz -= 2;

  if (env.shear0to6Ms >= 16) dbz += 3;
  else if (env.shear0to6Ms >= 10) dbz += 2;
  else if (env.shear0to6Ms >= 6) dbz += 1;

  const li = env.liftedIndexC ?? 2;
  if (li <= -2) dbz += 3;
  else if (li <= 0) dbz += 1.5;
  else if (li >= 3) dbz -= 2;

  const cooling = Math.max(0, -env.cloudTopCoolingCPer15min);
  if (cooling >= 2) dbz += 1.5;
  if (cooling >= 4) dbz += 1.5;

  return clamp(dbz, 32, 65);
}

function nearestEnv(
  lat: number,
  lon: number,
  points: ScoredFormationPoint[],
): ScoredFormationPoint | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestD = Infinity;
  for (const p of points) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  // Grid ~30–40 km — dál už nemá smysl interpolovat
  if (bestD > 55) return null;
  return best;
}

/**
 * Skóre zesílení v jednom bodě stopy.
 * Headroom = potenciál prostředí − aktuální síla buňky.
 * Slabé (zelené) buňky v silném prostředí mají vyšší skóre.
 */
export function intensificationScoreAt(
  currentDbz: number,
  env: EnvironmentSignals,
  envScore: number,
  envScoreHere = envScore,
): { score: number; expectedDbz: number; headroomDbz: number } {
  const cfg = stormConfig.intensification;
  const expectedDbz = envPotentialDbz(env);
  const headroomDbz = expectedDbz - currentDbz;
  const relativeBoost = envScore - envScoreHere;

  // Relativní zlepšení podél stopy počítá i při slabém absolutním skóre
  const usableEnv =
    envScore >= cfg.minEnvScore ||
    (relativeBoost >= 5 && envScore >= 12) ||
    (headroomDbz >= 3 && env.capeJkg >= 40) ||
    (headroomDbz >= 2 && dewpointCOr(env) >= 13 && currentDbz < 50);

  if (!usableEnv || headroomDbz < cfg.minHeadroomDbz) {
    return { score: 0, expectedDbz, headroomDbz };
  }

  // Už silná buňka: jen když prostředí opravdu unese ještě víc
  if (currentDbz >= 55 && headroomDbz < cfg.minHeadroomDbz) {
    return { score: 0, expectedDbz, headroomDbz };
  }
  if (
    currentDbz >= 50 &&
    headroomDbz < cfg.minHeadroomDbz - 1.5 &&
    relativeBoost < 6
  ) {
    return { score: 0, expectedDbz, headroomDbz };
  }

  const headroomN = clamp(headroomDbz / 16, 0, 1);
  const envN = clamp((envScore - cfg.minEnvScore) / 40, 0, 1);
  const relN = clamp(relativeBoost / 20, 0, 1);
  const weakN =
    currentDbz < 40 ? 1 : currentDbz < 48 ? 0.55 : currentDbz < 55 ? 0.25 : 0;

  const score =
    (headroomN * 0.4 + envN * 0.25 + weakN * 0.2 + relN * 0.15) * 100;

  return {
    score: Math.round(score),
    expectedDbz: Math.round(expectedDbz),
    headroomDbz: Math.round(headroomDbz * 10) / 10,
  };
}

function samplePointAlongTrack(
  feature: IntensTrackCell,
  etaMin: number,
): [number, number] {
  const km = (feature.speedKmh * etaMin) / 60;
  return destinationPoint(
    feature.peak[1],
    feature.peak[0],
    feature.headingDeg,
    km,
  );
}

/** Predikce zesílení jedné buňky podél stopy (0–horizont). */
export function forecastCellIntensification(
  feature: IntensTrackCell,
  points: ScoredFormationPoint[],
): CellIntensification {
  const cfg = stormConfig.intensification;
  const horizon = stormConfig.alertHorizonMin;
  const step = cfg.sampleStepMin;
  const raw: Array<{
    eta: number;
    score: number;
    expectedDbz: number;
    headroomDbz: number;
    lon: number;
    lat: number;
  }> = [];

  const here = nearestEnv(feature.peak[1], feature.peak[0], points);
  const envScoreHere = here?.assessment.score ?? 0;

  for (let eta = 0; eta <= horizon; eta += step) {
    const [lon, lat] = samplePointAlongTrack(feature, eta);
    const near = nearestEnv(lat, lon, points);
    if (!near) {
      raw.push({
        eta,
        score: 0,
        expectedDbz: feature.maxDbz,
        headroomDbz: 0,
        lon,
        lat,
      });
      continue;
    }
    const s = intensificationScoreAt(
      feature.maxDbz,
      near.environment,
      near.assessment.score,
      envScoreHere,
    );
    raw.push({
      eta,
      score: s.score,
      expectedDbz: s.expectedDbz,
      headroomDbz: s.headroomDbz,
      lon,
      lat,
    });
  }

  const segments: IntensSegment[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].score < cfg.segmentScoreMin) {
      i += 1;
      continue;
    }
    let j = i;
    let maxScore = raw[i].score;
    let peakExpected = raw[i].expectedDbz;
    let peakHeadroom = raw[i].headroomDbz;
    let bestIdx = i;
    while (j + 1 < raw.length && raw[j + 1].score >= cfg.segmentScoreMin) {
      j += 1;
      if (raw[j].score > maxScore) {
        maxScore = raw[j].score;
        peakExpected = raw[j].expectedDbz;
        peakHeadroom = raw[j].headroomDbz;
        bestIdx = j;
      }
    }
    const path = raw.slice(i, j + 1).map((p) => [p.lon, p.lat] as [number, number]);
    segments.push({
      etaMin: raw[i].eta,
      etaMax: raw[j].eta,
      score: maxScore,
      expectedDbz: peakExpected,
      headroomDbz: peakHeadroom,
      center: [raw[bestIdx].lon, raw[bestIdx].lat],
      path: path.length >= 2 ? path : [path[0], path[0]],
    });
    i = j + 1;
  }

  const alertSegs = segments.filter((s) => s.score >= cfg.alertScoreMin);
  const peakExpectedDbz =
    alertSegs.length > 0
      ? Math.max(...alertSegs.map((s) => s.expectedDbz))
      : feature.maxDbz;

  let whyHeadline: string | undefined;
  let whyReasons: string[] | undefined;
  /** Neznámý / flat / slabý growth → žádná fialová (nejen klesající echo). */
  const trendUnknown = feature.growthDbz == null;
  const trendTooWeak =
    feature.growthDbz != null &&
    feature.growthDbz < cfg.suppressIfGrowthDbzBelow;
  const suppressPurple = trendUnknown || trendTooWeak;

  if (alertSegs.length > 0 && !suppressPurple) {
    const peak = alertSegs.reduce((a, b) => (b.score > a.score ? b : a));
    const at = nearestEnv(peak.center[1], peak.center[0], points);
    if (at) {
      const reasons: string[] = [];
      const env = at.environment;
      const envDew = dewpointCOr(env);
      const headroom = peakExpectedDbz - feature.maxDbz;
      if (headroom >= 3) {
        reasons.push(
          `prostředí unese silnější echo (~${peakExpectedDbz} dBZ vs teď ${Math.round(feature.maxDbz)})`,
        );
      }
      if (env.capeJkg >= 80) {
        reasons.push(`CAPE ~${Math.round(env.capeJkg)} J/kg na trase`);
      }
      if (envDew >= 13) {
        reasons.push(`vlhkost · rosný bod ${envDew.toFixed(0)} °C`);
      }
      if (env.shear0to6Ms >= 8) {
        reasons.push(`střih ${env.shear0to6Ms.toFixed(0)} m/s organizuje buňku`);
      }
      if (here && env.capeJkg >= here.environment.capeJkg + 40) {
        reasons.push(
          `více energie než teď (+${Math.round(env.capeJkg - here.environment.capeJkg)} CAPE)`,
        );
      }
      if (reasons.length === 0) {
        reasons.push("lepší podmínky podél trasy než v místě teď");
      }
      whyReasons = reasons.slice(0, 4);
      whyHeadline = `Může zesílit — lepší prostředí na trase (${reasons[0]}).`;
    }
  }

  const showSegs = suppressPurple ? [] : alertSegs;
  const willIntensify = showSegs.length > 0;

  let suppressHeadline: string | undefined;
  let suppressReasons: string[] | undefined;
  if (suppressPurple && alertSegs.length > 0) {
    if (trendUnknown) {
      suppressHeadline =
        "Trend echa neznámý — fialovou zónu nezobrazujeme (zesílení není jistota).";
      suppressReasons = ["chybí růst dBZ z historie"];
    } else if (feature.growthDbz != null && feature.growthDbz < 0) {
      suppressHeadline =
        "Echo slábne — fialovou zónu nezobrazujeme (zesílení je nepravděpodobné).";
      suppressReasons = [`růst echa ${feature.growthDbz.toFixed(1)} dBZ`];
    } else {
      suppressHeadline =
        "Echo neroste dost — fialovou zónu nezobrazujeme (může zesílit jen při jasném růstu).";
      suppressReasons = [
        `růst echa ${feature.growthDbz?.toFixed(1) ?? "?"} dBZ (min. ${cfg.suppressIfGrowthDbzBelow})`,
      ];
    }
  }

  return {
    cellId: feature.id,
    score: willIntensify ? Math.max(...showSegs.map((s) => s.score)) : 0,
    enterEtaMin: willIntensify ? showSegs[0].etaMin : null,
    peakExpectedDbz: willIntensify
      ? Math.max(...showSegs.map((s) => s.expectedDbz))
      : feature.maxDbz,
    segments: showSegs,
    willIntensify,
    whyHeadline: suppressHeadline ?? whyHeadline,
    whyReasons: suppressReasons ?? whyReasons,
    timeline: raw.map((p) => ({
      eta: p.eta,
      expectedDbz: p.expectedDbz,
      score: p.score,
    })),
  };
}

export function buildIntensificationForecasts(
  features: IntensTrackCell[],
  points: ScoredFormationPoint[],
): Map<string, CellIntensification> {
  const map = new Map<string, CellIntensification>();
  for (const f of features) {
    map.set(f.id, forecastCellIntensification(f, points));
  }
  return map;
}

/** Je buňka v čase T uvnitř zóny zesílení? */
export function isIntensifyingAt(
  intens: CellIntensification | undefined,
  forecastMinutes: number,
): boolean {
  if (!intens?.willIntensify) return false;
  return intens.segments.some(
    (s) => forecastMinutes >= s.etaMin && forecastMinutes <= s.etaMax + 5,
  );
}

/**
 * Odhad dBZ v čase T.
 * Buňky, které teď běží, v horizontu ~60 min jen pomalu slábnou — nezmizí hned.
 */
export function predictedDbzAt(
  feature: IntensTrackCell,
  intens: CellIntensification | undefined,
  forecastMinutes: number,
): number {
  if (forecastMinutes <= 0) return feature.maxDbz;

  const cfg = stormConfig.intensification;
  const timeline = intens?.timeline ?? [];
  const current = feature.maxDbz;

  let envTarget = current;
  if (timeline.length > 0) {
    let sample = timeline[0];
    for (const t of timeline) {
      if (t.eta <= forecastMinutes) sample = t;
    }
    // Neber prostředí slabší než ~současná síla − 8 (jinak všechno „umře“)
    envTarget = Math.max(sample.expectedDbz, current - 8);
  }

  // Zesílení — priorita
  if (intens?.willIntensify && intens.enterEtaMin != null) {
    if (forecastMinutes < intens.enterEtaMin) {
      return current;
    }
    const minutesIn = forecastMinutes - intens.enterEtaMin;
    const growth = (cfg.growthDbzPer15Min * minutesIn) / 15;
    return clamp(
      Math.min(intens.peakExpectedDbz, current + growth),
      30,
      65,
    );
  }

  // Pomalý útlum — životnost podle síly
  let lifeMin: number;
  if (current >= 50) lifeMin = 90;
  else if (current >= 45) lifeMin = 75;
  else if (current >= 40) lifeMin = 60;
  else if (current >= 35) lifeMin = 50;
  else lifeMin = 40;

  const progress = clamp(forecastMinutes / lifeMin, 0, 1);
  // Drží se déle na začátku
  const ease = progress * progress * progress;
  const floor = current >= 40 ? 32 : 28;
  const towardEnv = Math.max(floor, Math.min(current, envTarget));
  return current + (towardEnv - current) * ease;
}

function corridorPolygon(
  path: [number, number][],
  halfWidthKm: number,
): Polygon | null {
  if (path.length < 2) {
    const [lon, lat] = path[0] ?? [0, 0];
    return circlePolygon(lat, lon, halfWidthKm, 24);
  }

  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < path.length; i++) {
    const [lon, lat] = path[i];
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const dLon = next[0] - prev[0];
    const dLat = next[1] - prev[1];
    const bearing =
      ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    left.push(destinationPoint(lat, lon, bearing - 90, halfWidthKm));
    right.push(destinationPoint(lat, lon, bearing + 90, halfWidthKm));
  }

  const ring = [...left, ...right.reverse(), left[0]];
  return { type: "Polygon", coordinates: [ring] };
}

export function intensificationCorridorsGeoJSON(
  forecasts: Map<string, CellIntensification>,
): FeatureCollection {
  const half = stormConfig.intensification.corridorHalfWidthKm;
  const features: FeatureCollection["features"] = [];

  for (const intens of forecasts.values()) {
    for (const seg of intens.segments) {
      const geom = corridorPolygon(seg.path, half);
      if (!geom) continue;
      features.push({
        type: "Feature",
        properties: {
          cellId: intens.cellId,
          score: seg.score,
          etaMin: seg.etaMin,
          etaMax: seg.etaMax,
          expectedDbz: seg.expectedDbz,
          label:
            seg.etaMin <= 0
              ? `může zesílit teď\n→ ~${seg.expectedDbz} dBZ`
              : `může zesílit\nza ${seg.etaMin}–${seg.etaMax} min\n→ ~${seg.expectedDbz} dBZ`,
        },
        geometry: geom,
      });
    }
  }

  return { type: "FeatureCollection", features };
}

export function intensificationMarkersGeoJSON(
  forecasts: Map<string, CellIntensification>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...forecasts.values()]
      .filter((f) => f.willIntensify && f.enterEtaMin != null)
      .flatMap((f) =>
        f.segments.map((seg) => ({
          type: "Feature" as const,
          properties: {
            cellId: f.cellId,
            score: seg.score,
            etaMin: seg.etaMin,
            label:
              seg.etaMin <= 0
                ? `↑ může zesílit\n~${seg.expectedDbz} dBZ`
                : `↑ může zesílit\nza ${seg.etaMin} min · ~${seg.expectedDbz} dBZ`,
          },
          geometry: {
            type: "Point" as const,
            coordinates: seg.center,
          },
        })),
      ),
  };
}

export function intensificationActiveHaloGeoJSON(
  features: IntensTrackCell[],
  forecasts: Map<string, CellIntensification>,
  forecastMinutes: number,
  motionFeatures: IntensTrackCell[] = features,
): FeatureCollection {
  const systemDelta = meanForecastDelta(motionFeatures, forecastMinutes);
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => isIntensifyingAt(forecasts.get(f.id), forecastMinutes))
      .map((f) => {
        const intens = forecasts.get(f.id)!;
        const [lon, lat] = peakAtForecastMinutes(
          {
            peak: f.peak,
            headingDeg: f.headingDeg,
            speedKmh: f.speedKmh,
            motionSource: "radar-track",
          },
          forecastMinutes,
          systemDelta,
          "raster",
        );
        const dbz = predictedDbzAt(f, intens, forecastMinutes);
        return {
          type: "Feature" as const,
          properties: {
            id: f.id,
            intensifying: 1,
            dbz,
            expectedDbz: intens.peakExpectedDbz,
          },
          geometry: {
            type: "Point" as const,
            coordinates: [lon, lat],
          },
        };
      }),
  };
}

export function formatIntensificationSummary(
  intens: CellIntensification,
): string {
  if (!intens.willIntensify || intens.enterEtaMin == null) {
    return "Podél stopy zatím nečekáme výrazné zesílení.";
  }
  if (intens.enterEtaMin <= 0) {
    return `Buňka je v zóně, kde může zesílit — odhad až ~${intens.peakExpectedDbz} dBZ (není jistota).`;
  }
  return `Za ~${intens.enterEtaMin} min vstoupí do prostředí, kde může zesílit k ~${intens.peakExpectedDbz} dBZ.`;
}
