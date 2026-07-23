import { czechRegionLabel, isInCzechiaApprox } from "../lib/czechRegion";
import { t, getLocale, type Locale } from "../i18n";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  angleDiffDeg,
  bearingDeg,
  destinationPoint,
  distanceKm,
} from "../lib/geo";
import { stormSteeringMotion, type WindGrid } from "../lib/windField";
import { classifyBirth, observedMotionFromHistory, resolveCellMotion } from "./stormTrackRules";
import {
  formatStormWindMapLine,
  stormWindAtCell,
  type StormWindAtCell,
} from "./stormWindAtCell";
import { severityRank } from "../lib/severity";
import { formatCoreStrengthLabel } from "../lib/stormStrength";
import { coreRadiusForDbz, evolveDbzAt } from "../lib/stormEvolution";
import {
  isIntensifyingAt,
  predictedDbzAt,
  type CellIntensification,
} from "./intensification";
import { birthEnvironmentAt, nearestFormationPoint, type BirthEnvironment } from "./birthEnv";
import type { ScoredFormationPoint } from "./formationData";
import {
  mergeSatelliteIntoEnv,
  sampleSatelliteCooling,
  type SatelliteCoolingGrid,
  type SatelliteSample,
} from "./satelliteCooling";
import { explainGrowthWhy } from "./growthWhy";
import {
  scoreActiveStorm,
  shouldAlertActive,
} from "./scoreActive";
import { bandRadiiKm } from "./hitAtUser";
import { stormConfig } from "./config";
import type { ActiveStormAssessment } from "./types";
import type { UserLocation } from "../types";
import { smoothPolygon } from "../lib/geoSmooth";

function parseHistoryTime(raw: string): Date | null {
  if (!raw || String(raw).length < 14) return null;
  const s = String(raw);
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`,
  );
}

function buildHistoryPoints(
  raw:
    | Array<{
        time?: string;
        peakLon: number;
        peakLat: number;
        maxDbz: number;
      }>
    | undefined,
): CellHistoryPoint[] {
  if (!raw?.length) return [];
  const birthT = parseHistoryTime(raw[0].time ?? "");
  return raw.map((h, i) => {
    const t = parseHistoryTime(h.time ?? "");
    const minutesFromBirth =
      birthT && t
        ? Math.max(0, Math.round((t.getTime() - birthT.getTime()) / 60_000))
        : i * 5;
    return {
      time: h.time ?? "",
      peak: [h.peakLon, h.peakLat] as [number, number],
      maxDbz: h.maxDbz,
      minutesFromBirth,
    };
  });
}

export type CellHistoryPoint = {
  time: string;
  peak: [number, number];
  maxDbz: number;
  /** Minuty od zrodu (0 = první detekce). */
  minutesFromBirth: number;
};

export type TrackedCell = {
  id: string;
  maxDbz: number;
  /** ČHMÚ Z u jádra (nad CZ), jinak undefined. */
  chmiDbz?: number;
  peakDbz?: number;
  dbzSource?: "CHMI" | "OPERA";
  echoTopKm?: number;
  echoTopSource?: "CHMI";
  /** PseudoCAPPI 2 km — déšť u země (ČHMÚ). */
  surfaceDbz?: number;
  /** Dual-pol struktura jádra (ČHMÚ volume). */
  dualpolLabel?:
    | "possible_hail"
    | "strong_updraft"
    | "rain"
    | "weakening_or_shallow";
  dualpolZdrColumn?: boolean;
  dualpolHailLikely?: boolean;
  dualpolEchoTop50Km?: number;
  /**
   * ČHMÚ FCT_MAX_Z +30 min vs naše stopa.
   * false = nesouhlas → širší koridor.
   */
  fctAgree?: boolean;
  fctAngleDiffDeg?: number;
  peak: [number, number];
  polygon: Polygon;
  trackHeadingDeg?: number | null;
  trackSpeedKmh?: number | null;
  historyMinutes?: number;
  /** První detekce echa [lon, lat] — místo zrodu. */
  birth?: [number, number];
  birthDbz?: number;
  ageMinutes?: number;
  isNewborn?: boolean;
  growthDbz?: number;
  history?: CellHistoryPoint[];
};

export type RadarProgressFeature = {
  id: string;
  maxDbz: number;
  peak: [number, number];
  polygon: Polygon;
  headingDeg: number;
  speedKmh: number;
  severity: "weak" | "moderate" | "strong";
  rank: number;
  threatens: number;
  label: string;
  trackEnd: [number, number];
  motionSource: "radar-track" | "wind-fallback";
  /** ČHMÚ FCT nesouhlasí se stopou → širší koridor. */
  fctDisagree?: boolean;
  fctAngleDiffDeg?: number;
  historyMinutes: number;
  birth: [number, number];
  birthDbz: number;
  ageMinutes: number;
  isNewborn: boolean;
  /** Skutečný zrod echa (ne jen první snímek v okně historie). */
  trueBirth: boolean;
  growthDbz: number;
  phase: "birth" | "growing" | "mature" | "moving";
  history: CellHistoryPoint[];
  placeLabel: string;
  birthEnv?: BirthEnvironment | null;
  assessment?: ActiveStormAssessment;
  intensification?: CellIntensification;
  growthWhy?: {
    headline: string;
    reasons: string[];
    shortLabel: string | null;
  };
  dualpolLabel?: TrackedCell["dualpolLabel"];
  dualpolZdrColumn?: boolean;
  dualpolHailLikely?: boolean;
  /** Vítr prostředí u jádra + pohyb buňky (ne Doppler). */
  windAtCell?: StormWindAtCell;
  /** Satelitní cloud-top trend u jádra (MTG). */
  satAtPeak?: SatelliteSample | null;
  /** Výška echa (km) — ČHMÚ volume nebo proxy z dBZ. */
  echoTopKm?: number;
  echoTopSource?: "CHMI";
};

/** Peak buňky v čase forecastMinutes (pro klik i vizuál). */
export function peakAtForecast(
  feature: Pick<
    RadarProgressFeature,
    "peak" | "headingDeg" | "speedKmh" | "motionSource"
  >,
  forecastMinutes: number,
  systemDelta?: { dLon: number; dLat: number },
): [number, number] {
  return peakAtForecastMinutes(
    feature,
    forecastMinutes,
    systemDelta,
    "raster",
  );
}

/**
 * Pozice jádra v čase T — stejná logika jako advekce PNG:
 * 1) vlastní pozorovaný pohyb buňky
 * 2) jinak systémový posun (průměr radar-track jader)
 */
export function peakAtForecastMinutes(
  feature: Pick<
    RadarProgressFeature,
    "peak" | "headingDeg" | "speedKmh" | "motionSource"
  >,
  forecastMinutes: number,
  systemDelta?: { dLon: number; dLat: number },
  /** raster = stejný posun jako advekce PNG; track = vlastní pohyb buňky (šipky) */
  motionMode: "raster" | "track" = "track",
): [number, number] {
  if (forecastMinutes <= 0.05) return feature.peak;

  if (
    motionMode === "raster" &&
    systemDelta &&
    (Math.abs(systemDelta.dLon) > 1e-9 || Math.abs(systemDelta.dLat) > 1e-9)
  ) {
    return [
      feature.peak[0] + systemDelta.dLon,
      feature.peak[1] + systemDelta.dLat,
    ];
  }

  if (feature.speedKmh >= 5) {
    return destinationPoint(
      feature.peak[1],
      feature.peak[0],
      feature.headingDeg,
      (feature.speedKmh * forecastMinutes) / 60,
    );
  }

  if (
    systemDelta &&
    (Math.abs(systemDelta.dLon) > 1e-9 || Math.abs(systemDelta.dLat) > 1e-9)
  ) {
    return [
      feature.peak[0] + systemDelta.dLon,
      feature.peak[1] + systemDelta.dLat,
    ];
  }

  return feature.peak;
}

/** Peak z kind=peak (snap na PNG), ne historie tracku. */
function currentPeakFromCell(cell: TrackedCell): [number, number] {
  return cell.peak;
}

function peakHistoryGapKm(
  peak: [number, number],
  history: CellHistoryPoint[],
): number {
  if (history.length === 0) return Infinity;
  const last = history[history.length - 1].peak;
  return distanceKm(peak[1], peak[0], last[1], last[0]);
}

function pickPeakForCell(
  id: string,
  peakCandidates: Map<string, [number, number][]>,
  history: CellHistoryPoint[],
): [number, number] | null {
  const cands = peakCandidates.get(id);
  if (cands?.length) return cands[cands.length - 1]!;
  if (history.length > 0) return history[history.length - 1]!.peak;
  return null;
}

function cellCandidateScore(
  history: CellHistoryPoint[],
  peak: [number, number],
): number {
  return history.length * 100 - peakHistoryGapKm(peak, history) * 8;
}

/**
 * Průměrný posun jader (váha = dBZ) — jen buňky s pozorovaným pohybem.
 */
export function meanForecastDelta(
  features: Array<
    Pick<
      RadarProgressFeature,
      "peak" | "headingDeg" | "speedKmh" | "maxDbz"
    >
  >,
  forecastMinutes: number,
): { dLon: number; dLat: number } {
  if (forecastMinutes <= 0 || features.length === 0) {
    return { dLon: 0, dLat: 0 };
  }
  let wSum = 0;
  let dLon = 0;
  let dLat = 0;
  for (const f of features) {
    if (f.speedKmh < 5) continue;
    const w = Math.max(1, f.maxDbz - 20);
    const [lon, lat] = destinationPoint(
      f.peak[1],
      f.peak[0],
      f.headingDeg,
      (f.speedKmh * forecastMinutes) / 60,
    );
    dLon += (lon - f.peak[0]) * w;
    dLat += (lat - f.peak[1]) * w;
    wSum += w;
  }
  if (wSum <= 0) return { dLon: 0, dLat: 0 };
  return { dLon: dLon / wSum, dLat: dLat / wSum };
}

function shiftPolygon(
  polygon: Polygon,
  dx: number,
  dy: number,
): Polygon {
  return {
    ...polygon,
    coordinates: polygon.coordinates.map((ring) =>
      ring.map(([lon, lat]) => [lon + dx, lat + dy]),
    ),
  };
}

function bandForDbz(dbz: number): string {
  if (dbz >= 60) return "extreme";
  if (dbz >= 55) return "heavy";
  if (dbz >= 50) return "strong";
  if (dbz >= 45) return "moderate";
  if (dbz >= 40) return "rain";
  if (dbz >= 35) return "echo";
  if (dbz >= 30) return "light";
  return "fade";
}

function echoTopKmEstimate(dbz: number): number {
  return Math.min(15, 7.5 + (dbz - 35) * 0.2);
}

function effectivePeakDbz(cell: Pick<TrackedCell, "peakDbz" | "chmiDbz" | "maxDbz">): number {
  return cell.peakDbz ?? cell.chmiDbz ?? cell.maxDbz;
}

function effectiveEchoTopKm(cell: Pick<TrackedCell, "echoTopKm" | "peakDbz" | "chmiDbz" | "maxDbz">): number {
  if (cell.echoTopKm != null && cell.echoTopKm > 0) return cell.echoTopKm;
  return echoTopKmEstimate(effectivePeakDbz(cell));
}

/** Zvětší / zmenší polygon kolem kotvy (peak) — ať jádro zůstane ve středu vizuálu. */
function scalePolygonAround(
  polygon: Polygon,
  factor: number,
  anchor: [number, number],
): Polygon {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return polygon;
  const ring = polygon.coordinates[0];
  if (!ring || ring.length < 3) return polygon;
  const [ax, ay] = anchor;
  return {
    ...polygon,
    coordinates: [
      ring.map(([lon, lat]) => [ax + (lon - ax) * factor, ay + (lat - ay) * factor]),
    ],
  };
}

/** @deprecated centroid scale — trhá vazbu peak ↔ polygon */
function scalePolygon(polygon: Polygon, factor: number): Polygon {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return polygon;
  const ring = polygon.coordinates[0];
  if (!ring || ring.length < 3) return polygon;
  let sx = 0;
  let sy = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return scalePolygonAround(polygon, factor, [sx / n, sy / n]);
}

function sizeFactorFromDbz(currentDbz: number, predictedDbz: number): number {
  if (currentDbz < 1) return 1;
  if (predictedDbz < 26) return Math.max(0.4, predictedDbz / 38);
  const ratio = predictedDbz / currentDbz;
  return Math.max(0.55, Math.min(1.55, Math.pow(ratio, 0.7)));
}

/** Pro canvas vývoj PNG. */
export function footprintFactorFromDbz(
  currentDbz: number,
  predictedDbz: number,
): number {
  return sizeFactorFromDbz(currentDbz, predictedDbz);
}

export function parseTrackedCells(fc: FeatureCollection): TrackedCell[] {
  const peakCandidates = new Map<string, [number, number][]>();
  const cellFeatures: Feature[] = [];

  for (const f of fc.features) {
    const kind = f.properties?.kind as string | undefined;
    const id = (f.properties?.cellId ?? f.properties?.id) as string | undefined;
    if (!id) continue;

    if (kind === "peak" && f.geometry?.type === "Point") {
      const list = peakCandidates.get(id) ?? [];
      list.push(f.geometry.coordinates as [number, number]);
      peakCandidates.set(id, list);
      continue;
    }

    if (kind === "cell" && f.geometry?.type === "Polygon") {
      cellFeatures.push(f);
    }
  }

  const bestCellById = new Map<string, Feature>();
  for (const f of cellFeatures) {
    const id = f.properties!.id as string;
    const history = buildHistoryPoints(
      f.properties!.history as
        | Array<{
            time?: string;
            peakLon: number;
            peakLat: number;
            maxDbz: number;
          }>
        | undefined,
    );
    const peak = pickPeakForCell(id, peakCandidates, history);
    if (!peak) continue;
    const score = cellCandidateScore(history, peak);
    const prev = bestCellById.get(id);
    if (!prev) {
      bestCellById.set(id, f);
      continue;
    }
    const prevHistory = buildHistoryPoints(
      prev.properties!.history as
        | Array<{
            time?: string;
            peakLon: number;
            peakLat: number;
            maxDbz: number;
          }>
        | undefined,
    );
    const prevPeak = pickPeakForCell(id, peakCandidates, prevHistory);
    if (!prevPeak) {
      bestCellById.set(id, f);
      continue;
    }
    if (score > cellCandidateScore(prevHistory, prevPeak)) {
      bestCellById.set(id, f);
    }
  }

  const cells: TrackedCell[] = [];

  for (const f of bestCellById.values()) {
    const id = f.properties!.id as string;
    const history = buildHistoryPoints(
      f.properties!.history as
        | Array<{
            time?: string;
            peakLon: number;
            peakLat: number;
            maxDbz: number;
          }>
        | undefined,
    );
    const peak = pickPeakForCell(id, peakCandidates, history);
    if (!peak) continue;
    const birthFromHist =
      history.length > 0 ? history[0].peak : peak;
    const birthDbz =
      typeof f.properties!.birthDbz === "number"
        ? Number(f.properties!.birthDbz)
        : history.length > 0
          ? history[0].maxDbz
          : Number(f.properties!.maxDbz ?? 35);
    const birth: [number, number] =
      typeof f.properties!.birthLon === "number" &&
      typeof f.properties!.birthLat === "number"
        ? [Number(f.properties!.birthLon), Number(f.properties!.birthLat)]
        : birthFromHist;
    const ageMinutes = Number(
      f.properties!.ageMinutes ?? f.properties!.historyMinutes ?? 0,
    );
    const growthDbz = Number(
      f.properties!.growthDbz ?? Number(f.properties!.maxDbz ?? 35) - birthDbz,
    );

    cells.push({
      id,
      maxDbz: Number(f.properties!.maxDbz ?? 35),
      chmiDbz:
        typeof f.properties!.chmiDbz === "number"
          ? Number(f.properties!.chmiDbz)
          : undefined,
      peakDbz:
        typeof f.properties!.peakDbz === "number"
          ? Number(f.properties!.peakDbz)
          : undefined,
      dbzSource: f.properties!.dbzSource as "CHMI" | "OPERA" | undefined,
      echoTopKm:
        typeof f.properties!.echoTopKm === "number"
          ? Number(f.properties!.echoTopKm)
          : undefined,
      echoTopSource:
        f.properties!.echoTopSource === "CHMI" ? "CHMI" : undefined,
      surfaceDbz:
        typeof f.properties!.chmiSurfaceDbz === "number"
          ? Number(f.properties!.chmiSurfaceDbz)
          : undefined,
      dualpolLabel: (() => {
        const v = f.properties!.dualpolLabel;
        if (
          v === "possible_hail" ||
          v === "strong_updraft" ||
          v === "rain" ||
          v === "weakening_or_shallow"
        ) {
          return v;
        }
        return undefined;
      })(),
      dualpolZdrColumn:
        typeof f.properties!.dualpolZdrColumn === "boolean"
          ? f.properties!.dualpolZdrColumn
          : undefined,
      dualpolHailLikely:
        typeof f.properties!.dualpolHailLikely === "boolean"
          ? f.properties!.dualpolHailLikely
          : f.properties!.hailLikely === true
            ? true
            : undefined,
      dualpolEchoTop50Km:
        typeof f.properties!.dualpolEchoTop50Km === "number"
          ? Number(f.properties!.dualpolEchoTop50Km)
          : undefined,
      fctAgree:
        typeof f.properties!.chmiFctAgree === "boolean"
          ? f.properties!.chmiFctAgree
          : undefined,
      fctAngleDiffDeg:
        typeof f.properties!.chmiFctAngleDiffDeg === "number"
          ? Number(f.properties!.chmiFctAngleDiffDeg)
          : undefined,
      peak,
      polygon: f.geometry as Polygon,
      trackHeadingDeg:
        typeof f.properties!.trackHeadingDeg === "number"
          ? Number(f.properties!.trackHeadingDeg)
          : null,
      trackSpeedKmh:
        typeof f.properties!.trackSpeedKmh === "number"
          ? Number(f.properties!.trackSpeedKmh)
          : null,
      historyMinutes: Number(f.properties!.historyMinutes ?? 0),
      birth,
      birthDbz,
      ageMinutes,
      isNewborn: Boolean(f.properties!.isNewborn ?? ageMinutes <= 10),
      growthDbz,
      history,
    });
  }

  cells.sort((a, b) => b.maxDbz - a.maxDbz);
  return cells;
}

export function motionFromWind(
  grid: WindGrid | null,
  lon: number,
  lat: number,
): { headingDeg: number; speedKmh: number } {
  return stormSteeringMotion(grid, null, lon, lat);
}

/**
 * Směr/rychlost pro zobrazení — šipka = systémový steering (850+500).
 * Peak na mapě zůstává „nejhorší déšť teď“; track nekopíruje skákající jádro.
 */
export function displayMotionFromCell(
  cell: Pick<
    TrackedCell,
    "trackHeadingDeg" | "trackSpeedKmh" | "history" | "peak"
  >,
  windLow: WindGrid | null,
  windUpper: WindGrid | null = null,
): { headingDeg: number; speedKmh: number; source: "radar-track" | "wind-fallback" } {
  const motion = resolveCellMotion(cell, windLow, windUpper);
  return {
    headingDeg: motion.headingDeg,
    speedKmh: motion.speedKmh,
    source: motion.source,
  };
}

/** @deprecated použij displayMotionFromCell */
export function cellMotion(
  cell: Pick<
    TrackedCell,
    "trackHeadingDeg" | "trackSpeedKmh" | "peak" | "history"
  >,
  windLow: WindGrid | null,
  windUpper: WindGrid | null = null,
): {
  headingDeg: number;
  speedKmh: number;
  source: "radar-track" | "wind-fallback";
} {
  return displayMotionFromCell(cell, windLow, windUpper);
}

/** Všechny smysluplné buňky — i v budoucnosti musí jet. */
const MAX_MAP_CELLS = 80;
const MIN_MAP_DBZ = 26;

export function buildRadarProgressFeatures(
  cells: TrackedCell[],
  windLow: WindGrid | null,
  user: UserLocation | null,
  formationPoints: ScoredFormationPoint[] = [],
  windUpper: WindGrid | null = null,
  locale: Locale = getLocale(),
  satelliteGrid: SatelliteCoolingGrid | null = null,
): RadarProgressFeature[] {
  const ranked = [...cells].sort((a, b) => b.maxDbz - a.maxDbz);
  const strong = ranked.filter((c) => c.maxDbz >= MIN_MAP_DBZ);
  let picked =
    strong.length > 0
      ? strong.slice(0, MAX_MAP_CELLS)
      : ranked.slice(0, Math.min(4, ranked.length));

  // Vždy nech buňky blízké uživateli (i když jsou slabší)
  if (user) {
    const nearIds = new Set(
      ranked
        .filter((c) => {
          const d = distanceKm(c.peak[1], c.peak[0], user.lat, user.lon);
          return d <= 90 && c.maxDbz >= 30;
        })
        .slice(0, 3)
        .map((c) => c.id),
    );
    const merged = new Map(picked.map((c) => [c.id, c]));
    for (const c of ranked) {
      if (nearIds.has(c.id)) merged.set(c.id, c);
    }
    picked = [...merged.values()]
      .sort((a, b) => b.maxDbz - a.maxDbz)
      .slice(0, MAX_MAP_CELLS + 2);
  }

  return picked.map((cell) => {
    const peak = currentPeakFromCell(cell);
    const [peakLon, peakLat] = peak;
    const observed = observedMotionFromHistory(cell);
    const motion = displayMotionFromCell(cell, windLow, windUpper);
    const peakDbz = effectivePeakDbz(cell);
    const echoTopKm = effectiveEchoTopKm(cell);

    let distanceToUserKm = 80;
    let approachAngleDeg = 90;
    if (user) {
      distanceToUserKm = distanceKm(peakLat, peakLon, user.lat, user.lon);
      const toUser = bearingDeg(peakLat, peakLon, user.lat, user.lon);
      approachAngleDeg = angleDiffDeg(motion.headingDeg, toUser);
    }

    const peakEnvRaw =
      nearestFormationPoint(peakLat, peakLon, formationPoints)?.environment ??
      null;
    const satAtPeak = sampleSatelliteCooling(satelliteGrid, peakLat, peakLon);
    const peakEnv =
      peakEnvRaw && satAtPeak
        ? mergeSatelliteIntoEnv(peakEnvRaw, satAtPeak)
        : peakEnvRaw;

    const assessment = scoreActiveStorm(
      {
        id: cell.id,
        lat: peakLat,
        lon: peakLon,
        maxDbz: peakDbz,
        echoTopKm,
        echoTopSource: cell.echoTopSource,
        dbzSource: cell.dbzSource,
        surfaceDbz: cell.surfaceDbz,
        speedKmh: motion.speedKmh,
        headingDeg: motion.headingDeg,
        distanceToUserKm,
        approachAngleDeg,
        fromPlace: cell.dbzSource === "CHMI" ? "Radar ČHMÚ" : "Radar OPERA",
      },
      peakEnv,
    );

    const age = cell.ageMinutes ?? cell.historyMinutes ?? 0;
    const birth = cell.birth ?? cell.peak;
    const birthDbz = cell.birthDbz ?? cell.maxDbz;
    const growthDbz = cell.growthDbz ?? cell.maxDbz - birthDbz;
    const birthClass = classifyBirth({
      birthDbz,
      ageMinutes: age,
      growthDbz,
      maxDbz: cell.maxDbz,
      pipelineNewborn: Boolean(cell.isNewborn),
      motionFromRadar: observed != null,
    });
    const { trueBirth, isNewborn, phase } = birthClass;

    const birthEnv = birthEnvironmentAt(
      birth[1],
      birth[0],
      formationPoints,
      satelliteGrid,
    );

    const alert = user ? shouldAlertActive(assessment) : false;
    const growthWhy =
      phase === "birth" || phase === "growing"
        ? explainGrowthWhy(
            {
              phase,
              growthDbz,
              ageMinutes: age,
              birthDbz,
              maxDbz: cell.maxDbz,
              history: cell.history ?? [],
              birthEnv,
              isNewborn,
              satAtPeak,
            },
            satAtPeak,
          )
        : null;

    let label: string;
    if (phase === "birth") {
      label = `${t("storm.born", undefined, locale)} · ${formatCoreStrengthLabel(peakDbz, assessment.severity, locale)}${
        growthWhy?.shortLabel ? `\n${growthWhy.shortLabel}` : ""
      }`;
    } else if (phase === "growing") {
      label = `${t("storm.growing", undefined, locale)} · ${formatCoreStrengthLabel(peakDbz, assessment.severity, locale)}${
        growthWhy?.shortLabel ? `\n${growthWhy.shortLabel}` : ""
      }`;
    } else {
      label = formatCoreStrengthLabel(peakDbz, assessment.severity, locale);
      if (assessment.etaMinutes != null && alert) {
        label += `\n~${assessment.etaMinutes} min`;
      }
    }

    const headingDeg = motion.headingDeg;
    const speedKmh = motion.speedKmh;
    const motionSource = motion.source;
    const trackKm = (speedKmh * stormConfig.alertHorizonMin) / 60;
    const trackEnd: [number, number] =
      speedKmh >= 5
        ? destinationPoint(peakLat, peakLon, headingDeg, trackKm)
        : peak;

    const windAt = stormWindAtCell(
      peak,
      speedKmh,
      windLow,
      windUpper,
      peakEnv,
    );
    if (
      (alert || assessment.severity === "strong") &&
      phase !== "birth"
    ) {
      label += `\n${formatStormWindMapLine(windAt, locale)}`;
    }

    return {
      id: cell.id,
      maxDbz: peakDbz,
      peak,
      polygon: cell.polygon,
      headingDeg,
      speedKmh,
      severity: assessment.severity,
      rank: severityRank(assessment.severity),
      threatens: alert ? 1 : 0,
      label,
      trackEnd,
      motionSource,
      fctDisagree: cell.fctAgree === false,
      fctAngleDiffDeg: cell.fctAngleDiffDeg,
      historyMinutes: cell.historyMinutes ?? 0,
      birth,
      birthDbz,
      ageMinutes: age,
      isNewborn,
      trueBirth,
      growthDbz,
      phase,
      history: cell.history ?? [],
      placeLabel: czechRegionLabel(peakLat, peakLon, locale),
      birthEnv,
      assessment: user ? assessment : undefined,
      growthWhy: growthWhy ?? undefined,
      dualpolLabel: cell.dualpolLabel,
      dualpolZdrColumn: cell.dualpolZdrColumn,
      dualpolHailLikely: cell.dualpolHailLikely,
      windAtCell: windAt,
      satAtPeak,
      echoTopKm,
      echoTopSource: cell.echoTopSource,
    };
  });
}

export function radarCellsGeoJSON(features: RadarProgressFeature[]): FeatureCollection {
  return radarCellsGeoJSONAt(features, 0);
}

export function radarCellsGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
  intensByCell?: Map<string, CellIntensification>,
): FeatureCollection {
  const systemDelta = meanForecastDelta(features, forecastMinutes);
  return {
    type: "FeatureCollection",
    features: features
      .map((f) => {
        const intens = intensByCell?.get(f.id);
        const dbz = predictedDbzAt(f, intens, forecastMinutes);
        // V horizontu předpovědi buňky držíme viditelné (nefiltrujeme pryč)
        if (dbz < 22 && forecastMinutes > 75) return null;
        const intensifying = isIntensifyingAt(intens, forecastMinutes) ? 1 : 0;
        const decaying =
          forecastMinutes > 0 && dbz < f.maxDbz - 2 ? 1 : 0;
        const shiftedPeak = peakAtForecastMinutes(
          f,
          forecastMinutes,
          systemDelta,
          "raster",
        );
        const moved = shiftPolygon(
          f.polygon,
          shiftedPeak[0] - f.peak[0],
          shiftedPeak[1] - f.peak[1],
        );
        // Škálovat kolem peaku — jinak jádro „uteče“ ze středu zeleného polygonu
        const scaled = scalePolygonAround(
          moved,
          sizeFactorFromDbz(f.maxDbz, dbz),
          shiftedPeak,
        );
        return {
          type: "Feature" as const,
          properties: {
            id: f.id,
            band: bandForDbz(dbz),
            dbz,
            threatens: f.threatens,
            severity: f.severity,
            intensifying,
            decaying,
            opacity: dbz < 30 ? 0.35 : dbz < 40 ? 0.55 : dbz < 50 ? 0.7 : 0.82,
          },
          geometry: smoothPolygon(scaled, 1),
        };
      })
      .filter((f): f is NonNullable<typeof f> => f != null),
  };
}

export function radarCellsGhostGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
): FeatureCollection {
  // Budoucnost: ghost = kde je buňka teď (před posunem)
  if (forecastMinutes > 0) {
    return radarCellsGeoJSONAt(features, 0);
  }

  // Teď: ghost = místo zrodu (jako na fotkách: šedá stopa odkud to přišlo)
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => {
        if (f.ageMinutes < 5) return false;
        const dx = f.peak[0] - f.birth[0];
        const dy = f.peak[1] - f.birth[1];
        return dx * dx + dy * dy > 1e-8;
      })
      .map((f) => {
        const birthPoly = shiftPolygon(
          f.polygon,
          f.birth[0] - f.peak[0],
          f.birth[1] - f.peak[1],
        );
        const shrunk = scalePolygon(
          birthPoly,
          Math.max(0.45, Math.min(0.85, f.birthDbz / Math.max(f.maxDbz, 1))),
        );
        return {
          type: "Feature" as const,
          properties: {
            id: f.id,
            band: "echo",
            dbz: f.birthDbz,
            birth: 1,
          },
          geometry: shrunk,
        };
      }),
  };
}

/** Stopa historie: polyline po reálných peacích (ne přímka „falešný zrod → teď“). */
export function birthTrailGeoJSON(
  features: RadarProgressFeature[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f.history.length >= 2 && f.maxDbz >= 32)
      .sort(
        (a, b) =>
          Number(b.trueBirth) - Number(a.trueBirth) ||
          a.ageMinutes - b.ageMinutes ||
          b.maxDbz - a.maxDbz,
      )
      .slice(0, 14)
      .map((f) => ({
        type: "Feature" as const,
        properties: {
          id: f.id,
          age: f.ageMinutes,
          phase: f.phase,
          newborn: f.trueBirth ? 1 : 0,
          trueBirth: f.trueBirth ? 1 : 0,
        },
        geometry: {
          type: "LineString" as const,
          coordinates: f.history.map((h) => h.peak),
        },
      })),
  };
}

/** Marker skutečného zrodu — jen když echo opravdu vzniklo slabé v okně. */
export function birthMarkersGeoJSON(
  features: RadarProgressFeature[],
  locale: Locale = getLocale(),
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f.trueBirth && f.maxDbz >= 30)
      .sort(
        (a, b) =>
          Number(b.isNewborn) - Number(a.isNewborn) ||
          a.ageMinutes - b.ageMinutes ||
          b.maxDbz - a.maxDbz,
      )
      .slice(0, 10)
      .map((f) => ({
        type: "Feature" as const,
        properties: {
          id: f.id,
          newborn: f.isNewborn ? 1 : 0,
          phase: f.phase,
          label: f.isNewborn
            ? t("storm.birth", undefined, locale)
            : t("storm.birthAgo", { min: f.ageMinutes }, locale),
        },
        geometry: {
          type: "Point" as const,
          coordinates: f.birth,
        },
      })),
  };
}

export function radarPointsGeoJSON(features: RadarProgressFeature[]): FeatureCollection {
  return radarPointsGeoJSONAt(features, 0);
}

/**
 * Tečka / šipka na mapě: v ČR (+okraj) vždy; mimo ČR jen opravdu silné jádro.
 * (Mimo ČR peaky na hraně cropu často lžou.)
 */
export function showCoreMarkerOnMap(f: {
  peak: [number, number];
  maxDbz: number;
}): boolean {
  const [lon, lat] = f.peak;
  if (isInCzechiaApprox(lat, lon, 40)) return true;
  return f.maxDbz >= 52;
}

export function radarPointsGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
  intensByCell?: Map<string, CellIntensification>,
  locale: Locale = getLocale(),
): FeatureCollection {
  const systemDelta = meanForecastDelta(features, forecastMinutes);
  return {
    type: "FeatureCollection",
    features: features
      .filter(showCoreMarkerOnMap)
      .map((f) => {
      const intens = intensByCell?.get(f.id);
      const dbz = evolveDbzAt(f, intens, forecastMinutes);
      const intensifying = isIntensifyingAt(intens, forecastMinutes) ? 1 : 0;
      const strength = formatCoreStrengthLabel(dbz, f.severity, locale);
      let label: string;
      if (forecastMinutes > 0.5) {
        const arrow =
          intensifying === 1 ? " ↑" : dbz < f.maxDbz - 1.5 ? " ↓" : "";
        label = `${strength}${arrow}`;
        if (intensifying === 1) {
          label += `\n${t("storm.intensifying", undefined, locale)}`;
        }
      } else if (intensifying === 1) {
        label = `${strength} ↑\n${t("storm.intensifying", undefined, locale)}`;
      } else {
        label = strength;
        if (f.assessment?.etaMinutes != null && f.threatens === 1) {
          label += `\n~${f.assessment.etaMinutes} min`;
        }
      }
      return {
        type: "Feature" as const,
        id: f.id,
        properties: {
          id: f.id,
          dbz,
          coreR: coreRadiusForDbz(dbz),
          heading: f.headingDeg,
          severity: f.severity,
          rank: f.rank,
          threatens: f.threatens,
          intensifying,
          label,
        },
        geometry: {
          type: "Point" as const,
          coordinates: peakAtForecastMinutes(
            f,
            forecastMinutes,
            systemDelta,
            "raster",
          ),
        },
      };
    }),
  };
}

export function radarTracksGeoJSON(features: RadarProgressFeature[]): FeatureCollection {
  return radarTracksGeoJSONAt(features, stormConfig.alertHorizonMin);
}

/** Koridor nejistoty kolem stopy — jádro skáče, uživatel vidí pás ne přímku.
 * Jen u hrozby k tobě (nebo vybrané buňky) — mapa není plná pásů. */
export function radarTrackCorridorsGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
  selectedId: string | null = null,
): FeatureCollection {
  const horizon = stormConfig.alertHorizonMin;
  const systemDelta = meanForecastDelta(features, forecastMinutes);
  const featuresOut: FeatureCollection["features"] = [];

  for (const f of features) {
    if (!showCoreMarkerOnMap(f)) continue;
    if (f.threatens !== 1 && f.id !== selectedId) continue;
    const here = peakAtForecastMinutes(f, forecastMinutes, systemDelta, "raster");
    let tip = destinationPoint(
      here[1],
      here[0],
      f.headingDeg,
      Math.max(6, (f.speedKmh * Math.max(5, horizon - forecastMinutes)) / 60),
    );
    const dx = tip[0] - here[0];
    const dy = tip[1] - here[1];
    if (dx * dx + dy * dy < 1e-10 || forecastMinutes >= horizon - 1) {
      tip = destinationPoint(here[1], here[0], f.headingDeg, 10);
    }
    const { fringeKm } = bandRadiiKm(f.maxDbz);
    let halfKm = Math.min(
      5,
      Math.max(1.4, fringeKm * (0.35 + forecastMinutes / 240)),
    );
    if (
      f.phase === "birth" ||
      f.phase === "growing" ||
      f.ageMinutes < 20 ||
      f.trueBirth
    ) {
      halfKm = Math.min(6.5, halfKm * 1.1);
    }
    if (f.fctDisagree) {
      halfKm = Math.min(7, halfKm * 1.15);
    }
    const mid = destinationPoint(
      here[1],
      here[0],
      f.headingDeg,
      distanceKm(here[1], here[0], tip[1], tip[0]) / 2,
    );
    const path: [number, number][] = [here, mid, tip];
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i < path.length; i++) {
      const [lon, lat] = path[i];
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      const bearing =
        ((Math.atan2(next[0] - prev[0], next[1] - prev[1]) * 180) / Math.PI +
          360) %
        360;
      left.push(destinationPoint(lat, lon, bearing - 90, halfKm));
      right.push(destinationPoint(lat, lon, bearing + 90, halfKm));
    }
    const ring = [...left, ...right.reverse(), left[0]];
    featuresOut.push({
      type: "Feature",
      properties: {
        id: f.id,
        threatens: f.threatens,
        severity: f.severity,
        halfKm: Math.round(halfKm * 10) / 10,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  return { type: "FeatureCollection", features: featuresOut };
}

export function radarTracksGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
  selectedId: string | null = null,
): FeatureCollection {
  const horizon = stormConfig.alertHorizonMin;
  const systemDelta = meanForecastDelta(features, forecastMinutes);
  return {
    type: "FeatureCollection",
    features: features
      .filter(showCoreMarkerOnMap)
      // U hrozby / výběru pás nahrazuje tenkou přímku („musíš trefit peak“)
      .filter((f) => f.threatens !== 1 && f.id !== selectedId)
      .map((f) => {
      const here = peakAtForecastMinutes(f, forecastMinutes, systemDelta, "raster");
      let tip = destinationPoint(
        here[1],
        here[0],
        f.headingDeg,
        Math.max(6, (f.speedKmh * Math.max(5, horizon - forecastMinutes)) / 60),
      );
      const dx = tip[0] - here[0];
      const dy = tip[1] - here[1];
      if (dx * dx + dy * dy < 1e-10) {
        tip = destinationPoint(here[1], here[0], f.headingDeg, 10);
      } else if (forecastMinutes >= horizon - 1) {
        tip = destinationPoint(here[1], here[0], f.headingDeg, 10);
      }
      return {
        type: "Feature" as const,
        properties: {
          id: f.id,
          threatens: f.threatens,
          severity: f.severity,
          rank: f.rank,
        },
        geometry: {
          type: "LineString" as const,
          coordinates: [here, tip],
        },
      };
    }),
  };
}

export function radarArrowsGeoJSON(features: RadarProgressFeature[]): FeatureCollection {
  return radarArrowsGeoJSONAt(features, 0);
}

export function radarArrowsGeoJSONAt(
  features: RadarProgressFeature[],
  forecastMinutes: number,
): FeatureCollection {
  const systemDelta = meanForecastDelta(features, forecastMinutes);
  return {
    type: "FeatureCollection",
    features: features.filter(showCoreMarkerOnMap).map((f) => {
      const here = peakAtForecastMinutes(f, forecastMinutes, systemDelta, "raster");
      return {
        type: "Feature" as const,
        properties: {
          id: f.id,
          heading: f.headingDeg,
          threatens: f.threatens,
          severity: f.severity,
          rank: f.rank,
        },
        geometry: {
          type: "Point" as const,
          coordinates: here,
        },
      };
    }),
  };
}
