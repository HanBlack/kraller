import { fetchDataJson } from "../lib/dataUrls";
import { distanceKm } from "../lib/geo";
import { stormConfig } from "./config";
import type { EnvironmentSignals } from "./types";

export type SatelliteCoolingPoint = {
  lat: number;
  lon: number;
  /** False = vzorek u jádra, ale cloud mask říká bez mraku. */
  hasCloudTop?: boolean;
  cloudTopTempC?: number;
  cloudTopCoolingCPer15min?: number;
  /** ΔT škálované na 45 min (delší trend vzniku). */
  cloudTopCoolingCPer45min?: number;
  cloudTopHeightM?: number;
  cloudTopHeightDeltaMPer15min?: number;
  cloudTypeCode?: number;
  cloudLevel?: "high" | "mid" | "low" | "fractional" | "other";
  /** High/opaque ice cloud type — hluboká konvekce. */
  deepIceTop?: boolean;
  /** MTG LI flashes v okolí (~25 km / ~15 min). */
  lightningFlashes15min?: number;
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
  | "tower_rising"
  | "growing_long";

/** Satelitní vzorek u souřadnice buňky (MTG CTT + CTH + LI). */
export type SatelliteSample = {
  available: true;
  distanceKm: number;
  exactMatch: boolean;
  cloudTopTempC?: number;
  /** Záporné = ochlazování vrcholu (°C / 15 min). */
  cloudTopCoolingCPer15min: number;
  cloudTopCoolingCPer45min?: number;
  cloudTopHeightM?: number;
  cloudTopHeightDeltaMPer15min?: number;
  cloudTypeCode?: number;
  cloudLevel?: SatelliteCoolingPoint["cloudLevel"];
  deepIceTop: boolean;
  lightningFlashes15min: number;
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

export function satelliteLongGrowthRate(coolingPer45min: number | undefined): number {
  return Math.max(0, -(coolingPer45min ?? 0));
}

export function towerRiseRate(deltaMPer15min: number | undefined): number {
  return Math.max(0, deltaMPer15min ?? 0);
}

export function towerFallRate(deltaMPer15min: number | undefined): number {
  return Math.max(0, -(deltaMPer15min ?? 0));
}

function pointHasCloudTop(point: SatelliteCoolingPoint): boolean {
  return point.hasCloudTop !== false && point.cloudTopTempC != null;
}

function findNearestPoint(
  grid: SatelliteCoolingGrid,
  lat: number,
  lon: number,
  accept: (point: SatelliteCoolingPoint) => boolean = pointHasCloudTop,
): { point: SatelliteCoolingPoint; distanceKm: number } | null {
  if (!grid.points.length) return null;
  let best: SatelliteCoolingPoint | null = null;
  let bestD = Infinity;
  for (const p of grid.points) {
    if (!accept(p)) continue;
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best) return null;
  return { point: best, distanceKm: bestD };
}

export function classifySatelliteTrend(input: {
  coolingPer15min: number;
  coolingPer45min?: number;
  cloudTopTempC?: number;
  heightDeltaMPer15min?: number;
}): SatelliteTrend {
  const cfg = stormConfig;
  const growth15 = satelliteGrowthRate(input.coolingPer15min);
  const growth45 = satelliteLongGrowthRate(input.coolingPer45min);
  const rise = towerRiseRate(input.heightDeltaMPer15min);
  if (growth15 >= cfg.formation.cloudTopCoolingCPer15min.growing) return "growing";
  if (growth45 >= cfg.satellite.longCoolingCPer45min) return "growing_long";
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
  const exactCell = grid!.points.find(
    (p) =>
      (p.sampleSource === "cell" || p.sampleSource === "formation") &&
      distanceKm(lat, lon, p.lat, p.lon) <= exactKm,
  );
  const exactCloudy =
    exactCell && pointHasCloudTop(exactCell) ? exactCell : undefined;

  // Clear marker u jádra s LI — drž blesky i když blízký cloudy pixel existuje
  if (
    exactCell &&
    !pointHasCloudTop(exactCell) &&
    (exactCell.lightningFlashes15min ?? 0) > 0
  ) {
    const nearbyCloudy = findNearestPoint(grid!, lat, lon, pointHasCloudTop);
    if (nearbyCloudy && nearbyCloudy.distanceKm <= maxKm) {
      const base = sampleFromPoint(
        nearbyCloudy.point,
        nearbyCloudy.distanceKm,
        false,
        grid!.validAt,
      );
      return {
        ...base,
        lightningFlashes15min: exactCell.lightningFlashes15min ?? 0,
        exactMatch: true,
      };
    }
    return {
      available: true,
      distanceKm: distanceKm(lat, lon, exactCell.lat, exactCell.lon),
      exactMatch: true,
      cloudTopCoolingCPer15min: 0,
      deepIceTop: false,
      lightningFlashes15min: exactCell.lightningFlashes15min ?? 0,
      trend: "steady",
      coldTop: false,
      towerRising: false,
      towerFalling: false,
      validAt: grid!.validAt,
    };
  }

  // Clear marker bez LI — zkus nejbližší cloudy pixel
  const hit = exactCloudy
    ? {
        point: exactCloudy,
        distanceKm: distanceKm(lat, lon, exactCloudy.lat, exactCloudy.lon),
      }
    : findNearestPoint(grid!, lat, lon, pointHasCloudTop);
  if (!hit || hit.distanceKm > maxKm || !pointHasCloudTop(hit.point)) {
    return null;
  }

  return sampleFromPoint(
    hit.point,
    hit.distanceKm,
    hit.distanceKm <= exactKm &&
      (hit.point.sampleSource === "cell" ||
        hit.point.sampleSource === "formation"),
    grid!.validAt,
  );
}

function sampleFromPoint(
  point: SatelliteCoolingPoint,
  dKm: number,
  exactMatch: boolean,
  validAt?: string,
): SatelliteSample {
  const cooling = point.cloudTopCoolingCPer15min ?? 0;
  const cooling45 = point.cloudTopCoolingCPer45min;
  const heightDelta = point.cloudTopHeightDeltaMPer15min;
  const coldTop =
    point.cloudTopTempC != null &&
    point.cloudTopTempC <= stormConfig.satellite.coldTopTempC;
  const towerRising =
    towerRiseRate(heightDelta) >= stormConfig.satellite.towerRisingMPer15min;
  const towerFalling =
    towerFallRate(heightDelta) >= stormConfig.satellite.towerFallingMPer15min;
  const deepIceTop =
    point.deepIceTop === true ||
    point.cloudLevel === "high" ||
    (point.cloudTypeCode != null &&
      [8, 9, 12, 13, 14, 15].includes(point.cloudTypeCode));

  return {
    available: true,
    distanceKm: dKm,
    exactMatch,
    cloudTopTempC: point.cloudTopTempC,
    cloudTopCoolingCPer15min: cooling,
    cloudTopCoolingCPer45min: cooling45,
    cloudTopHeightM: point.cloudTopHeightM,
    cloudTopHeightDeltaMPer15min: heightDelta,
    cloudTypeCode: point.cloudTypeCode,
    cloudLevel: point.cloudLevel,
    deepIceTop,
    lightningFlashes15min: point.lightningFlashes15min ?? 0,
    trend: classifySatelliteTrend({
      coolingPer15min: cooling,
      coolingPer45min: cooling45,
      cloudTopTempC: point.cloudTopTempC,
      heightDeltaMPer15min: heightDelta,
    }),
    coldTop,
    towerRising,
    towerFalling,
    validAt,
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
      detail:
        grid.status === "empty"
          ? "CTTH bez cloud-top vzorků (geometrie/filtr) — příští kolo"
          : (grid.message ?? "data dočasně nedostupná"),
    };
  }
  if (!grid.points?.length) {
    return {
      title: "Satelit (MTG)",
      detail: "žádné cloud-top vzorky v oblasti (pipeline prázdná)",
    };
  }
  const sample = sampleSatelliteCooling(grid, lat, lon);
  if (!sample) {
    return {
      title: "Satelit (MTG)",
      detail: "v místě bez detekovaného vrcholu mraku — FCI nevidí cloud-top",
    };
  }
  const extras = satelliteExtraHints(sample);
  const base = (() => {
    if (sample.trend === "growing") return explainSatelliteGrowth(sample);
    if (sample.trend === "growing_long") return explainSatelliteLongGrowth(sample);
    if (sample.trend === "tower_rising") return explainSatelliteTowerRising(sample);
    if (sample.trend === "cold_top") return explainSatelliteColdTop(sample);
    if (sample.trend === "warming" || sample.towerFalling) {
      return explainSatelliteWarming(sample);
    }
    if (sample.lightningFlashes15min >= stormConfig.satellite.lightningActiveMin) {
      return explainSatelliteLightning(sample);
    }
    if (sample.deepIceTop) return explainSatelliteDeepIce(sample);
    const temp =
      sample.cloudTopTempC != null
        ? `vrchol ~${sample.cloudTopTempC.toFixed(0)} °C`
        : "vrchol detekován";
    return `${temp} — stabilní (ΔT ≈ 0 za 15 min), bez signálu růstu`;
  })();
  return {
    title: "Satelit (MTG)",
    detail: extras.length ? `${base} · ${extras.join(" · ")}` : base,
  };
}

function satelliteExtraHints(sample: SatelliteSample): string[] {
  const hints: string[] = [];
  if (
    sample.lightningFlashes15min >= stormConfig.satellite.lightningActiveMin &&
    sample.trend !== "steady"
  ) {
    hints.push(explainSatelliteLightning(sample));
  }
  if (sample.deepIceTop && sample.trend !== "cold_top" && sample.cloudTopTempC != null) {
    hints.push("high/ice cloud type");
  }
  if (
    sample.cloudTopCoolingCPer45min != null &&
    sample.trend === "growing" &&
    satelliteLongGrowthRate(sample.cloudTopCoolingCPer45min) >=
      stormConfig.satellite.longCoolingCPer45min
  ) {
    hints.push(
      `trend 45 min −${satelliteLongGrowthRate(sample.cloudTopCoolingCPer45min).toFixed(1)} °C`,
    );
  }
  return hints;
}

export function explainSatelliteGrowth(sample: SatelliteSample): string {
  const rate = satelliteGrowthRate(sample.cloudTopCoolingCPer15min);
  return `vrchol mraku se ochlazuje (satelit −${rate.toFixed(1)} °C / 15 min) — konvekce roste nahoře`;
}

export function explainSatelliteLongGrowth(sample: SatelliteSample): string {
  const rate = satelliteLongGrowthRate(sample.cloudTopCoolingCPer45min);
  return `vrchol se ochlazuje dlouhodobě (satelit −${rate.toFixed(1)} °C / 45 min) — růst před silnějším echom`;
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

export function explainSatelliteDeepIce(sample: SatelliteSample): string {
  const t =
    sample.cloudTopTempC != null
      ? `~${sample.cloudTopTempC.toFixed(0)} °C`
      : "high/ice";
  return `hluboká ledová vrstva (cloud type, ${t}) — ne mělká přeháňka`;
}

export function explainSatelliteLightning(sample: SatelliteSample): string {
  const n = sample.lightningFlashes15min;
  return `blesky MTG LI · ${n} flash/15 min v okolí — buňka elektrifikovaná`;
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
  if (sample.trend === "growing_long") lines.push(explainSatelliteLongGrowth(sample));
  if (sample.towerRising) lines.push(explainSatelliteTowerRising(sample));
  if (sample.coldTop && sample.trend !== "growing") {
    lines.push(explainSatelliteColdTop(sample));
  }
  if (sample.deepIceTop && !sample.coldTop) {
    lines.push(explainSatelliteDeepIce(sample));
  }
  if (sample.lightningFlashes15min >= stormConfig.satellite.lightningActiveMin) {
    lines.push(explainSatelliteLightning(sample));
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
  const cooling15 = sample.cloudTopCoolingCPer15min;
  const longRate = satelliteLongGrowthRate(sample.cloudTopCoolingCPer45min);
  // Delší trend: pokud 15min slabý ale 45min silný, použij škálovaný proxy do skóre
  const coolingForScore =
    satelliteGrowthRate(cooling15) >= 1.5
      ? cooling15
      : longRate >= stormConfig.satellite.longCoolingCPer45min
        ? -(longRate * (15 / 45))
        : cooling15;
  return {
    ...env,
    cloudTopCoolingCPer15min: coolingForScore,
    coolingSource: "satellite",
    cloudTopTempC: sample.cloudTopTempC,
    cloudTopHeightM: sample.cloudTopHeightM,
    cloudTopHeightDeltaMPer15min: sample.cloudTopHeightDeltaMPer15min,
    cloudTopCoolingCPer45min: sample.cloudTopCoolingCPer45min,
    deepIceTop: sample.deepIceTop || undefined,
    lightningFlashes15min:
      sample.lightningFlashes15min > 0
        ? sample.lightningFlashes15min
        : undefined,
  };
}
