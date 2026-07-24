import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import { DATA_REFRESH_MS, DATA_REFRESH_STORM_MS } from "../lib/dataUrls";
import {
  loadStormData,
  type DataSourceStatus,
} from "../lib/loadStormData";
import { loadStormDataForBoot } from "../lib/bootData";
import { preloadRadarHistoryFrames, preloadRadarHistoryRasters } from "../lib/radarHistory";
import { preloadMapStyle } from "../lib/preloadBoot";
import type { FormationZone } from "../storm/demo";
import type { WindGrid } from "../lib/windField";
import type { TrackedCell } from "../storm/radarCells";
import type { RadarHistoryManifest } from "../lib/radarHistory";
import type { ScoredFormationPoint } from "../storm/formationData";
import type { SatelliteCoolingGrid } from "../storm/satelliteCooling";
import {
  commitLiveRasterBlobSwap,
  preloadRadarRaster,
  type RadarRasterMeta,
} from "../lib/radarRaster";

export type BootPhase = "data" | "fetch" | "history" | "map" | "refresh" | "done";

export type StormDataState = {
  radarData: FeatureCollection;
  radarRaster: RadarRasterMeta | null;
  trackedCells: TrackedCell[];
  windLow: WindGrid | null;
  windUpper: WindGrid | null;
  windReal: boolean;
  formationZones: FormationZone[];
  formationReal: boolean;
  formationScoredPoints: ScoredFormationPoint[];
  lastUpdated: string | null;
  operaTime: string | null;
  chmiTime: string | null;
  radarTime: string | null;
  radarAttribution: string[];
  dataSources: {
    opera?: DataSourceStatus;
    chmi?: DataSourceStatus;
    wind?: DataSourceStatus;
    formation?: DataSourceStatus;
  } | null;
  radarHistory: RadarHistoryManifest | null;
  satelliteCooling: SatelliteCoolingGrid | null;
  /** První načtení při startu stránky — UI čeká, dokud není hotovo. */
  booting: boolean;
  bootPhase: BootPhase;
  /** Tišší obnovení na pozadí (interval). */
  loading: boolean;
  refresh: () => void;
};

export function useStormData(
  fallbackFormation: FormationZone[],
): StormDataState {
  const [radarData, setRadarData] = useState<FeatureCollection>({
    type: "FeatureCollection",
    features: [],
  });
  const [radarRaster, setRadarRaster] = useState<RadarRasterMeta | null>(null);
  const [trackedCells, setTrackedCells] = useState<TrackedCell[]>([]);
  const [windLow, setWindLow] = useState<WindGrid | null>(null);
  const [windUpper, setWindUpper] = useState<WindGrid | null>(null);
  const [windReal, setWindReal] = useState(false);
  const [formationZones, setFormationZones] =
    useState<FormationZone[]>(fallbackFormation);
  const [formationReal, setFormationReal] = useState(false);
  const [formationScoredPoints, setFormationScoredPoints] = useState<
    ScoredFormationPoint[]
  >([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [operaTime, setOperaTime] = useState<string | null>(null);
  const [chmiTime, setChmiTime] = useState<string | null>(null);
  const [radarTime, setRadarTime] = useState<string | null>(null);
  const [radarAttribution, setRadarAttribution] = useState<string[]>([]);
  const [dataSources, setDataSources] = useState<StormDataState["dataSources"]>(
    null,
  );
  const [radarHistory, setRadarHistory] = useState<RadarHistoryManifest | null>(
    null,
  );
  const [satelliteCooling, setSatelliteCooling] =
    useState<SatelliteCoolingGrid | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootPhase, setBootPhase] = useState<BootPhase>("data");
  const [loading, setLoading] = useState(false);
  const busyRef = useRef(false);
  const bootedRef = useRef(false);
  /** Živá aktivita → kratší poll (15 s). */
  const stormActiveRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const isBoot = !bootedRef.current;
    if (isBoot) setBooting(true);
    else setLoading(true);
    try {
      const bust = Date.now();
      if (isBoot) setBootPhase("data");
      const data = isBoot
        ? await loadStormDataForBoot(fallbackFormation, (phase) => {
            setBootPhase(phase === "fetch" ? "fetch" : "refresh");
          })
        : await loadStormData(bust, fallbackFormation);
      if (isBoot) setBootPhase("history");
      const [rasterReady] = await Promise.all([
        preloadRadarRaster(data.radarRaster, bust),
        preloadRadarHistoryRasters(data.radarHistory, bust),
      ]);
      if (isBoot) {
        setBootPhase("map");
        await preloadMapStyle();
        setBootPhase("done");
      }
      void preloadRadarHistoryFrames(data.radarHistory, bust);
      setRadarData(data.radarData);
      if (rasterReady?.url) commitLiveRasterBlobSwap(rasterReady.url);
      setRadarRaster(rasterReady);
      setTrackedCells(data.trackedCells);
      setWindLow(data.windLow);
      setWindUpper(data.windUpper);
      setWindReal(data.windReal);
      if (data.formationReal) {
        setFormationZones(data.formationZones);
        setFormationScoredPoints(data.formationScoredPoints);
        setFormationReal(true);
      } else {
        setFormationZones(fallbackFormation);
        setFormationScoredPoints([]);
        setFormationReal(false);
      }
      setLastUpdated(data.metaUpdatedAt);
      setOperaTime(data.operaTime);
      setChmiTime(data.chmiTime);
      setRadarTime(data.radarTime);
      setRadarAttribution(data.radarAttribution);
      setDataSources(data.dataSources ?? null);
      setRadarHistory(data.radarHistory);
      setSatelliteCooling(data.satelliteCooling);
      stormActiveRef.current =
        data.trackedCells.length > 0 ||
        (data.radarData.features?.length ?? 0) > 0;
      bootedRef.current = true;
    } catch {
      /* ponechat poslední známá data */
    } finally {
      busyRef.current = false;
      setBooting(false);
      setLoading(false);
    }
  }, [fallbackFormation]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const ms = stormActiveRef.current
        ? DATA_REFRESH_STORM_MS
        : DATA_REFRESH_MS;
      timer = window.setTimeout(() => void tick(), ms);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [refresh]);

  return {
    radarData,
    radarRaster,
    trackedCells,
    windLow,
    windUpper,
    windReal,
    formationZones,
    formationReal,
    formationScoredPoints,
    lastUpdated,
    operaTime,
    chmiTime,
    radarTime,
    radarAttribution,
    dataSources,
    radarHistory,
    satelliteCooling,
    booting,
    bootPhase,
    loading,
    refresh,
  };
}
