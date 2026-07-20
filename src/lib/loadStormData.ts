import type { FeatureCollection } from "geojson";
import { dataUrl, fetchDataJson } from "./dataUrls";
import { smoothPolygonFeatures } from "./geoSmooth";
import { loadWindGrids } from "./windField";
import { buildRealFormationZones } from "../storm/formationData";
import type { ScoredFormationPoint } from "../storm/formationData";
import { parseTrackedCells } from "../storm/radarCells";
import type { FormationZone } from "../storm/demo";
import type { WindGrid } from "./windField";
import type { TrackedCell } from "../storm/radarCells";
import type { RadarHistoryManifest } from "./radarHistory";
import { loadRadarHistoryManifest } from "./radarHistory";
import type { RadarRasterMeta } from "./radarRaster";

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
  /** Spojitý PNG radar (preferovaný display); null = fallback na kontury. */
  radarRaster: RadarRasterMeta | null;
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
  return fetchDataJson<T>(path, cacheBust);
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
  const [meta, radarData, chmiRadar, cellsData, wind, radarHistory, rasterMeta] =
    await Promise.all([
      fetchJson<DataMeta>("data/meta.json", cacheBust),
      fetchJson<FeatureCollection>("data/opera/latest.geojson", cacheBust),
      fetchJson<FeatureCollection>("data/chmi/latest.geojson", cacheBust),
      fetchJson<FeatureCollection>("data/opera/cells.geojson", cacheBust),
      loadWindGrids(cacheBust),
      loadRadarHistoryManifest(cacheBust),
      fetchJson<RadarRasterMeta>("data/opera/latest-raster.json", cacheBust),
    ]);

  const cellsFc = cellsData ?? EMPTY_FC;
  const radarFc = smoothPolygonFeatures(
    mergeRadarLayers(radarData ?? EMPTY_FC, chmiRadar),
    1,
  );
  const formation = await buildRealFormationZones(cellsFc, cacheBust);

  let radarRaster: RadarRasterMeta | null = null;
  if (
    rasterMeta?.url &&
    Array.isArray(rasterMeta.coordinates) &&
    rasterMeta.coordinates.length === 4
  ) {
    radarRaster = {
      ...rasterMeta,
      url: dataUrl(rasterMeta.url, cacheBust),
    };
  }

  return {
    radarData: radarFc,
    radarRaster,
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
