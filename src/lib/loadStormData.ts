import type { FeatureCollection } from "geojson";
import { dataUrl } from "./dataUrls";
import { loadWindGrids } from "./windField";
import { buildRealFormationZones } from "../storm/formationData";
import type { ScoredFormationPoint } from "../storm/formationData";
import { parseTrackedCells } from "../storm/radarCells";
import type { FormationZone } from "../storm/demo";
import type { WindGrid } from "./windField";
import type { TrackedCell } from "../storm/radarCells";
import type { RadarHistoryManifest } from "./radarHistory";
import { loadRadarHistoryManifest } from "./radarHistory";

export type DataSourceStatus = {
  ok: boolean;
  updatedAt?: string | null;
  error?: string | null;
};

export type DataMeta = {
  updatedAt: string;
  operaTime?: string | null;
  chmiTime?: string | null;
  opera?: boolean;
  chmi?: boolean;
  wind?: boolean;
  formation?: boolean;
  sources?: {
    opera?: DataSourceStatus;
    chmi?: DataSourceStatus;
    wind?: DataSourceStatus;
    formation?: DataSourceStatus;
  };
};

export type StormDataBundle = {
  radarData: FeatureCollection;
  cellsData: FeatureCollection;
  trackedCells: TrackedCell[];
  windLow: WindGrid;
  windUpper: WindGrid;
  windReal: boolean;
  formationZones: FormationZone[];
  formationReal: boolean;
  formationScoredPoints: ScoredFormationPoint[];
  metaUpdatedAt: string | null;
  operaTime: string | null;
  chmiTime: string | null;
  dataSources: DataMeta["sources"] | null;
  radarHistory: RadarHistoryManifest | null;
};

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

async function fetchJson<T>(path: string, cacheBust: number): Promise<T | null> {
  try {
    const res = await fetch(dataUrl(path, cacheBust), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Sloučí OPERA (EU) + ČHMÚ kontury (přesnější nad CZ). */
function mergeRadarLayers(
  opera: FeatureCollection,
  chmi: FeatureCollection | null,
): FeatureCollection {
  if (!chmi?.features?.length) return opera;
  const operaFeats = opera.features.filter(
    (f) => f.properties?.source !== "CHMI",
  );
  return {
    type: "FeatureCollection",
    features: [...operaFeats, ...chmi.features],
  };
}

/** Načte radar, buňky, vítr, vznik a metadata. Při chybě vrátí prázdné/fallback hodnoty. */
export async function loadStormData(
  cacheBust: number,
  fallbackFormation: FormationZone[],
): Promise<StormDataBundle> {
  const [meta, radarData, chmiRadar, cellsData, wind, radarHistory] = await Promise.all([
    fetchJson<DataMeta>("data/meta.json", cacheBust),
    fetchJson<FeatureCollection>("data/opera/latest.geojson", cacheBust),
    fetchJson<FeatureCollection>("data/chmi/latest.geojson", cacheBust),
    fetchJson<FeatureCollection>("data/opera/cells.geojson", cacheBust),
    loadWindGrids(cacheBust),
    loadRadarHistoryManifest(cacheBust),
  ]);

  const cellsFc = cellsData ?? EMPTY_FC;
  const radarFc = mergeRadarLayers(radarData ?? EMPTY_FC, chmiRadar);
  const formation = await buildRealFormationZones(cellsFc, cacheBust);

  return {
    radarData: radarFc,
    cellsData: cellsFc,
    trackedCells: parseTrackedCells(cellsFc),
    windLow: wind.low,
    windUpper: wind.upper,
    windReal: wind.real,
    formationZones: formation.real ? formation.zones : fallbackFormation,
    formationReal: formation.real,
    formationScoredPoints: formation.scoredPoints,
    metaUpdatedAt: meta?.updatedAt ?? null,
    operaTime: meta?.operaTime ?? null,
    chmiTime: meta?.chmiTime ?? null,
    dataSources: meta?.sources ?? null,
    radarHistory,
  };
}
