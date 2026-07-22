import type { FeatureCollection } from "geojson";
import type { CellIntensification } from "../storm/intensification";
import type { RadarProgressFeature } from "../storm/radarCells";
import {
  cachedHistoryFrame,
  cachedHistoryRaster,
  frameForOffset,
  type RadarHistoryFrame,
  type RadarHistoryManifest,
} from "./radarHistory";
import { motionMinutesForView } from "./liveRadarMotion";
import type { RadarRasterMeta } from "./radarRaster";
import { stormEvolutionAt } from "./stormEvolution";

export type RadarHistoryLoad = {
  framePath: string;
  radar: FeatureCollection | null;
  raster: RadarRasterMeta | null;
};

export type RadarViewRasterInput = {
  timeOffsetMinutes: number;
  productIso: string | null | undefined;
  nowMs: number;
  liveRaster: RadarRasterMeta | null;
  radarHistory: RadarHistoryManifest | null;
  historyLoad: RadarHistoryLoad | null;
  radarProgress: RadarProgressFeature[];
  intensForecasts: Map<string, CellIntensification>;
};

export type RadarViewRasterResult = {
  historyFrame: RadarHistoryFrame | null;
  isHistoryView: boolean;
  motionMinutes: number;
  /** Archivní PNG pro každý krok do minulosti. */
  useHistoricalRaster: boolean;
  historicalRadar: FeatureCollection | null;
  baseRaster: RadarRasterMeta | null;
  /** Vždy přesný snímek z dat — žádná canvas predikce vzhledu. */
  displayRaster: RadarRasterMeta | null;
  /** Vypnuto: neukazujeme „jak bude radar vypadat za N min“. */
  needsAlgorithmicEvolve: boolean;
  evolveMinutes: number;
  evolution: ReturnType<typeof stormEvolutionAt>;
};

function historyForFrame(
  frame: RadarHistoryFrame | null,
  load: RadarHistoryLoad | null,
): FeatureCollection | null {
  if (!frame) return null;
  return (
    cachedHistoryFrame(frame) ??
    (load?.framePath === frame.path ? load.radar : null)
  );
}

function rasterForFrame(
  frame: RadarHistoryFrame | null,
  load: RadarHistoryLoad | null,
): RadarRasterMeta | null {
  if (!frame) return null;
  return (
    cachedHistoryRaster(frame) ??
    (load?.framePath === frame.path ? load.raster : null)
  );
}

/**
 * Raster pro mapu:
 * - minulost: archivní OPERA PNG daného kroku
 * - Teď: přesný latest.png
 * - žádná predikce vzhledu echo do budoucna
 */
export function resolveRadarViewRaster(
  input: RadarViewRasterInput,
): RadarViewRasterResult {
  const isHistoryView = input.timeOffsetMinutes < 0;
  const historyFrame =
    input.radarHistory && isHistoryView
      ? frameForOffset(input.radarHistory, input.timeOffsetMinutes)
      : null;

  const motionMinutes = motionMinutesForView({
    timeOffsetMinutes: input.timeOffsetMinutes,
    productIso: input.productIso,
    nowMs: input.nowMs,
  });

  const historicalRadar = historyForFrame(historyFrame, input.historyLoad);
  const historicalRaster = rasterForFrame(historyFrame, input.historyLoad);

  const useHistoricalRaster = isHistoryView && Boolean(historicalRaster);
  /** Minulost bez načteného archivu → nic (ne live — to „zasekne“ slider). */
  const baseRaster = useHistoricalRaster
    ? historicalRaster
    : isHistoryView
      ? null
      : input.liveRaster;

  const evolution = stormEvolutionAt(
    input.radarProgress,
    input.intensForecasts,
    0,
  );

  return {
    historyFrame,
    isHistoryView,
    motionMinutes,
    useHistoricalRaster,
    historicalRadar,
    baseRaster,
    displayRaster: baseRaster,
    needsAlgorithmicEvolve: false,
    evolveMinutes: 0,
    evolution,
  };
}
