import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useI18n } from "../i18n";
import { createArrowImageData } from "../lib/arrowIcon";
import { headingPhrase } from "../lib/direction";
import { distanceKm } from "../lib/geo";
import { severityLabel, severityRank } from "../lib/severity";
import type { WindLayerMode } from "../lib/windField";
import { WindParticleOverlay } from "../lib/windParticles";
import {
  frameForOffset,
  loadRadarHistoryFrame,
  loadRadarHistoryRaster,
} from "../lib/radarHistory";
import { filterRadarForCzFocus } from "../lib/radarDisplay";
import {
  scaleRadarRaster,
  stormEvolutionAt,
} from "../lib/stormEvolution";
import { shiftRadarRaster, type RadarRasterMeta } from "../lib/radarRaster";
import {
  motionMinutesForView,
} from "../lib/liveRadarMotion";
import { useStormDataContext } from "../providers/StormDataProvider";
import { MAP_STYLE_URL } from "../lib/preloadBoot";
import {
  demoActiveStorms,
} from "../storm/demo";
import {
  bandCenter,
  ellipsePolygon,
} from "../storm/cellShape";
import { applyFormationLinks } from "../storm/formationData";
import { linkFormationToRadarCells } from "../storm/formationLinks";
import {
  formationArrowsGeoJSON,
  formationCentersGeoJSON,
  formationGridGeoJSON,
  formationLinksGeoJSON,
  formationTracksGeoJSON,
  formationZonesGeoJSON,
} from "../storm/formationVisual";
import {
  buildActiveFeatures,
  buildFormationFeatures,
  type ActiveFeature,
} from "../storm/mapFeatures";
import {
  buildIntensificationForecasts,
  intensificationActiveHaloGeoJSON,
  intensificationCorridorsGeoJSON,
  intensificationMarkersGeoJSON,
} from "../storm/intensification";
import {
  buildStormLifecycle,
  lifecycleMapGeoJSON,
} from "../storm/lifecycle";
import {
  birthMarkersGeoJSON,
  birthTrailGeoJSON,
  buildRadarProgressFeatures,
  meanForecastDelta,
  peakAtForecast,
  radarArrowsGeoJSONAt,
  radarCellsGeoJSONAt,
  radarCellsGhostGeoJSONAt,
  radarPointsGeoJSONAt,
  radarTracksGeoJSONAt,
  radarTrackCorridorsGeoJSONAt,
} from "../storm/radarCells";
import { pickThreatBanners, type ThreatBannerItem } from "../storm/userThreats";
import type { ScoredFormationPoint } from "../storm/formationData";
import type { SelectedStorm } from "./StormDetail";
import type { UserLocation } from "../types";
import { stormConfig } from "../storm/config";

const CZ_BOUNDS: [[number, number], [number, number]] = [
  [12.05, 48.5],
  [18.95, 51.1],
];
const CZ_CENTER: [number, number] = [15.5, 49.75];

const FORM_SOURCE = "formation-zones";
const FORM_GRID_SOURCE = "formation-grid";
const FORM_LINK_SOURCE = "formation-links";
const FORM_CENTER_SOURCE = "formation-centers";
const FORM_TRACK_SOURCE = "formation-track-source";
const FORM_ARROW_SOURCE = "formation-arrow-source";
const FORM_FILL = "formation-fill";
const FORM_GRID = "formation-grid-layer";
const FORM_LINE = "formation-line";
const FORM_LINK = "formation-link";
const FORM_CENTER = "formation-center";
const FORM_TRACK_LINE = "formation-track";
const FORM_ARROW_LAYER = "formation-arrow";
const FORM_LABEL = "formation-label";

const GHOST_SOURCE = "progress-ghost-source";
const GHOST_FILL = "progress-ghost-fill";
const GHOST_LINE = "progress-ghost-line";

const BIRTH_TRAIL_SOURCE = "birth-trail-source";
const BIRTH_TRAIL = "birth-trail";
const BIRTH_MARK_SOURCE = "birth-mark-source";
const BIRTH_MARK = "birth-mark";
const BIRTH_LABEL = "birth-label";

const INTENS_SOURCE = "intens-corridor-source";
const INTENS_FILL = "intens-corridor-fill";
const INTENS_LINE = "intens-corridor-line";
const INTENS_MARK_SOURCE = "intens-mark-source";
const INTENS_MARK = "intens-mark";
const INTENS_LABEL = "intens-label";
const INTENS_HALO_SOURCE = "intens-halo-source";
const INTENS_HALO = "intens-halo";

const LIFE_SOURCE = "lifecycle-source";
const LIFE_PATH = "lifecycle-path";
const LIFE_BIRTH = "lifecycle-birth";
const LIFE_INTENS = "lifecycle-intensify";
const LIFE_DEMISE = "lifecycle-demise";
const LIFE_LABEL = "lifecycle-label";

const CELL_SOURCE = "active-cell-source";
const CELL_FILL = "active-cell-fill";
const CELL_LINE = "active-cell-line";
const RADAR_SOURCE = "opera-radar-source";
const RADAR_FILL = "opera-radar-fill";
const RADAR_LINE = "opera-radar-line";
const RADAR_PEAK = "opera-radar-peak";
const RADAR_RASTER_SOURCE = "opera-radar-raster";
const RADAR_RASTER = "opera-radar-raster-layer";
const ACT_SOURCE = "active-storms";
const ACT_HALO = "active-halo";
const ACT_CORE = "active-core";
const ACT_LABEL = "active-label";
const TRACK_SOURCE = "active-track-source";
const TRACK_CORRIDOR_SOURCE = "active-track-corridor";
const TRACK_CORRIDOR_FILL = "active-track-corridor-fill";
const TRACK_LINE = "active-track-line";
const ARROW_SOURCE = "active-arrow-source";
const ARROW_LAYER = "active-arrow";

/** Přesné státní hranice z OpenFreeMap (OSM) — jen zvýraznit, ne kreslit odhad. */
const COUNTRY_BORDER_LAYERS = [
  "boundary_country_z0-4",
  "boundary_country_z5-",
] as const;

function emphasizeCountryBorders(map: maplibregl.Map) {
  for (const id of COUNTRY_BORDER_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, "line-color", "rgba(195, 215, 235, 0.78)");
    map.setPaintProperty(id, "line-opacity", 0.95);
    map.setPaintProperty(id, "line-width", [
      "interpolate",
      ["exponential", 1.15],
      ["zoom"],
      5,
      1.15,
      8,
      1.8,
      12,
      2.6,
    ]);
    map.setPaintProperty(id, "line-blur", 0.15);
  }
}

/**
 * dBZ hodnota pro barvy — preferuje properties.dbz, jinak band.
 */
const dbzValue: maplibregl.ExpressionSpecification = [
  "coalesce",
  ["get", "dbz"],
  [
    "match",
    ["get", "band"],
    "fade",
    28,
    "light",
    32,
    "echo",
    36,
    "rain",
    42,
    "moderate",
    46,
    "strong",
    52,
    "heavy",
    56,
    "extreme",
    66,
    "core",
    62,
    45,
  ],
];

/**
 * 5 úrovní síly — neprůhledné barvy (alfa v rgba by u nested kontur
 * zase dělala tmavé „švy“ mezi kruhy).
 */
const dbzFillColor: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  dbzValue,
  25,
  "#2a6e68",
  30,
  "#2e9a72",
  38,
  "#5aaf3e",
  40,
  "#c9b02a",
  48,
  "#d99224",
  50,
  "#d96e22",
  56,
  "#d44a32",
  58,
  "#c42845",
  63,
  "#b0288a",
  65,
  "#a028c8",
  72,
  "#c85af0",
];

const dbzOutlineColor: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  dbzValue,
  25,
  "rgba(100, 195, 185, 0.35)",
  30,
  "rgba(80, 200, 160, 0.48)",
  40,
  "rgba(235, 210, 70, 0.62)",
  50,
  "rgba(245, 150, 60, 0.72)",
  58,
  "rgba(245, 70, 95, 0.85)",
  65,
  "rgba(230, 120, 255, 0.94)",
  72,
  "rgba(245, 170, 255, 0.96)",
];

const dbzFillOpacity: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  dbzValue,
  25,
  0.4,
  35,
  0.55,
  45,
  0.68,
  55,
  0.82,
  62,
  0.9,
  70,
  0.96,
];

/** Kontura buňky — intensifying / decaying / threat mají prioritu. */
const cellLineColor: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "intensifying"], 1],
  "rgba(200, 120, 255, 0.9)",
  ["==", ["get", "decaying"], 1],
  "rgba(145, 160, 175, 0.65)",
  ["==", ["get", "threatens"], 1],
  "rgba(255, 107, 61, 0.85)",
  dbzOutlineColor,
];

const cellLineWidth: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "intensifying"], 1],
  2.2,
  ["==", ["get", "threatens"], 1],
  1.6,
  [
    "interpolate",
    ["linear"],
    dbzValue,
    30,
    0.9,
    58,
    1.2,
    65,
    1.5,
  ],
];
/** Barva stopy / šipky podle síly (oranžová = míří k uživateli). */
const trackColorExpr: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "threatens"], 1],
  "#ff6b3d",
  [
    "match",
    ["get", "severity"],
    "strong",
    "#e85d4b",
    "moderate",
    "#e8a54b",
    "#5eb0e0",
  ],
];

/** Starší neonové vrstvy — odklidit při hot-reloadu. */
const LEGACY_PROGRESS_LAYERS = [
  "active-track-glow",
  "active-track-core",
  "active-flare-glow",
  "active-flare-line",
  "active-end-dot",
];
const LEGACY_PROGRESS_SOURCES = ["active-flare-source", "active-end-source"];

type Props = {
  location: UserLocation | null;
  showFormation: boolean;
  showProgress: boolean;
  showRadar: boolean;
  windMode: WindLayerMode;
  timeOffsetMinutes: number;
  selected: SelectedStorm | null;
  onSelect: (storm: SelectedStorm | null) => void;
  onWindSource?: (real: boolean) => void;
  onFormationSource?: (real: boolean) => void;
  onThreatAlerts?: (threats: ThreatBannerItem[]) => void;
  onHistoryRadarTime?: (time: string | null) => void;
  onFormationStats?: (stats: { count: number; linkCount: number }) => void;
  onFormationPoints?: (points: ScoredFormationPoint[]) => void;
  onMapReady?: () => void;
};

function activeCellGeoJSON(
  features: ActiveFeature[],
  forecastMinutes: number,
): FeatureCollection {
  const feats: FeatureCollection["features"] = [];
  const ratio = Math.max(0, Math.min(1, forecastMinutes / stormConfig.alertHorizonMin));

  for (const f of features) {
    const dx = (f.trackEnd[0] - f.cell.epicenter[0]) * ratio;
    const dy = (f.trackEnd[1] - f.cell.epicenter[1]) * ratio;
    // Od nejsilnějšího k nejslabšímu fill order řešíme přes sort-key / pořadí vrstev
    for (const band of f.cell.bands) {
      const center = bandCenter(
        f.storm.lat,
        f.storm.lon,
        f.storm.headingDeg,
        band.forwardOffsetKm,
      );
      const order =
        band.band === "light"
          ? 1
          : band.band === "echo"
            ? 2
            : band.band === "rain"
              ? 3
              : band.band === "moderate"
                ? 4
                : band.band === "strong"
                  ? 5
                  : band.band === "heavy"
                    ? 6
                    : band.band === "extreme"
                      ? 7
                      : 8;

      feats.push({
        type: "Feature",
        properties: {
          id: f.storm.id,
          band: band.band,
          dbz: band.dbz,
          order,
          threatens: f.alert ? 1 : 0,
          severity: f.assessment.severity,
        },
        geometry: ellipsePolygon(
          center.lat + dy,
          center.lon + dx,
          band.majorKm,
          band.minorKm,
          f.storm.headingDeg,
        ),
      });
    }
  }

  feats.sort(
    (a, b) =>
      ((a.properties?.order as number) ?? 0) -
      ((b.properties?.order as number) ?? 0),
  );

  return { type: "FeatureCollection", features: feats };
}

function activePointsGeoJSON(
  features: ActiveFeature[],
  forecastMinutes: number,
  locale?: import("../i18n").Locale,
): FeatureCollection {
  const ratio = Math.max(0, Math.min(1, forecastMinutes / stormConfig.alertHorizonMin));
  return {
    type: "FeatureCollection",
    features: features.map((f) => {
      const sev = f.assessment.severity;
      const strength = severityLabel(sev, locale);
      const move = headingPhrase(f.storm.headingDeg, locale);
      const eta =
        f.assessment.etaMinutes != null && f.alert
          ? `\n~${f.assessment.etaMinutes} min`
          : "";

      return {
        type: "Feature" as const,
        id: f.storm.id,
        properties: {
          id: f.storm.id,
          fromPlace: f.storm.fromPlace,
          dbz: f.storm.maxDbz,
          heading: f.storm.headingDeg,
          severity: sev,
          rank: severityRank(sev),
          eta: f.assessment.etaMinutes,
          threatens: f.alert ? 1 : 0,
          label: `${strength} · ${f.storm.maxDbz} dBZ\n${move}${eta}`,
        },
        geometry: {
          type: "Point" as const,
          // Epicentrum = nejsilnější jádro
          coordinates: [
            f.cell.epicenter[0] + (f.trackEnd[0] - f.cell.epicenter[0]) * ratio,
            f.cell.epicenter[1] + (f.trackEnd[1] - f.cell.epicenter[1]) * ratio,
          ],
        },
      };
    }),
  };
}

function activeTracksGeoJSON(
  features: ActiveFeature[],
  forecastMinutes: number,
): FeatureCollection {
  const ratio = Math.max(0, Math.min(1, forecastMinutes / stormConfig.alertHorizonMin));
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature",
      properties: {
        id: f.storm.id,
        threatens: f.alert ? 1 : 0,
        severity: f.assessment.severity,
        rank: severityRank(f.assessment.severity),
      },
      geometry: {
        type: "LineString",
        coordinates: [
          f.cell.epicenter,
          [
            f.cell.epicenter[0] + (f.trackEnd[0] - f.cell.epicenter[0]) * ratio,
            f.cell.epicenter[1] + (f.trackEnd[1] - f.cell.epicenter[1]) * ratio,
          ],
        ],
      },
    })),
  };
}

function activeArrowsGeoJSON(
  features: ActiveFeature[],
  forecastMinutes: number,
): FeatureCollection {
  const ratio = Math.max(0, Math.min(1, forecastMinutes / stormConfig.alertHorizonMin));
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature",
      properties: {
        id: f.storm.id,
        heading: f.storm.headingDeg,
        threatens: f.alert ? 1 : 0,
        severity: f.assessment.severity,
        rank: severityRank(f.assessment.severity),
      },
      geometry: {
        type: "Point",
        coordinates: [
          f.cell.epicenter[0] + (f.trackEnd[0] - f.cell.epicenter[0]) * ratio,
          f.cell.epicenter[1] + (f.trackEnd[1] - f.cell.epicenter[1]) * ratio,
        ],
      },
    })),
  };
}

function removeLayerIfExists(map: maplibregl.Map, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
}

function removeSourceIfExists(map: maplibregl.Map, id: string) {
  if (map.getSource(id)) map.removeSource(id);
}

function setLayerVisibility(
  map: maplibregl.Map,
  layerIds: string[],
  visible: boolean,
) {
  const v = visible ? "visible" : "none";
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
  }
}

/**
 * Spolehlivé spuštění po načtení stylu.
 * `once("load")` nestačí: po loadu může `isStyleLoaded()` krátce vrátit false
 * a load už se neopakuje → slider / vrstvy se „zaseknou“.
 */
function whenStyleReady(
  map: maplibregl.Map,
  fn: () => void,
): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    try {
      if (!map.getStyle() || !map.isStyleLoaded()) return;
    } catch {
      return;
    }
    done = true;
    map.off("load", run);
    map.off("idle", run);
    map.off("styledata", run);
    fn();
  };
  run();
  if (!done) {
    map.on("load", run);
    map.on("idle", run);
    map.on("styledata", run);
  }
  return () => {
    done = true;
    map.off("load", run);
    map.off("idle", run);
    map.off("styledata", run);
  };
}

/**
 * Nahraje PNG do image source a počká, až je ready.
 * Do té doby vrstva zůstat hidden — jinak MapLibre ukáže červený „error“ obdélník.
 * Stejné URL = jen setCoordinates (rychlý forecast scrub).
 * Generace ruší zastaralé async load (rychlý scrub historie).
 */
let lastSyncedRasterUrl: string | null = null;
let rasterSyncGeneration = 0;

/** Jen posun rohů — sync, bez reload PNG. */
function applyRadarRasterCoordinates(
  map: maplibregl.Map,
  meta: RadarRasterMeta,
): boolean {
  ensureStormLayers(map);
  const existing = map.getSource(RADAR_RASTER_SOURCE) as
    | maplibregl.ImageSource
    | undefined;
  if (!existing || lastSyncedRasterUrl !== meta.url) return false;
  try {
    existing.setCoordinates(meta.coordinates);
    map.triggerRepaint();
    return true;
  } catch {
    return false;
  }
}

function syncRadarRasterImage(
  map: maplibregl.Map,
  meta: RadarRasterMeta | null,
): Promise<boolean> {
  const gen = ++rasterSyncGeneration;
  ensureStormLayers(map);
  if (!meta?.url) {
    lastSyncedRasterUrl = null;
    setLayerVisibility(map, [RADAR_RASTER], false);
    return Promise.resolve(false);
  }

  const existing = map.getSource(RADAR_RASTER_SOURCE) as
    | maplibregl.ImageSource
    | undefined;
  if (existing && lastSyncedRasterUrl === meta.url) {
    try {
      existing.setCoordinates(meta.coordinates);
      map.triggerRepaint();
      return Promise.resolve(true);
    } catch {
      // full reload below
    }
  }

  setLayerVisibility(map, [RADAR_RASTER], false);

  return new Promise((resolve) => {
    const fail = () => resolve(false);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (gen !== rasterSyncGeneration) {
        resolve(false);
        return;
      }
      const src = map.getSource(RADAR_RASTER_SOURCE) as
        | maplibregl.ImageSource
        | undefined;
      if (!src) {
        fail();
        return;
      }
      try {
        src.updateImage({
          url: meta.url,
          coordinates: meta.coordinates,
        });
      } catch {
        fail();
        return;
      }

      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        map.off("sourcedata", onData);
        window.clearTimeout(timer);
        if (gen !== rasterSyncGeneration) {
          resolve(false);
          return;
        }
        if (ok) lastSyncedRasterUrl = meta.url;
        resolve(ok);
      };
      const onData = (e: maplibregl.MapSourceDataEvent) => {
        if (e.sourceId !== RADAR_RASTER_SOURCE) return;
        if (e.isSourceLoaded || map.isSourceLoaded(RADAR_RASTER_SOURCE)) {
          finish(true);
        }
      };
      map.on("sourcedata", onData);
      const timer = window.setTimeout(() => {
        finish(map.isSourceLoaded(RADAR_RASTER_SOURCE));
      }, 2800);
      if (map.isSourceLoaded(RADAR_RASTER_SOURCE)) finish(true);
    };
    img.onerror = fail;
    img.src = meta.url;
  });
}

function ensureStormLayers(map: maplibregl.Map) {
  const needsTrackRebuild =
    LEGACY_PROGRESS_LAYERS.some((id) => map.getLayer(id) != null) ||
    LEGACY_PROGRESS_SOURCES.some((id) => map.getSource(id) != null) ||
    (map.getSource(TRACK_SOURCE) != null && map.getLayer(ARROW_LAYER) == null);

  for (const id of LEGACY_PROGRESS_LAYERS) removeLayerIfExists(map, id);
  for (const id of LEGACY_PROGRESS_SOURCES) removeSourceIfExists(map, id);

  if (needsTrackRebuild) {
    removeLayerIfExists(map, TRACK_LINE);
    removeLayerIfExists(map, TRACK_CORRIDOR_FILL);
    removeLayerIfExists(map, ARROW_LAYER);
    removeSourceIfExists(map, TRACK_SOURCE);
    removeSourceIfExists(map, TRACK_CORRIDOR_SOURCE);
    removeSourceIfExists(map, ARROW_SOURCE);
  }

  // HMR / starý styl: buňky musí mít barevné dBZ, ne šedou výplň
  if (map.getLayer(CELL_FILL)) {
    map.setPaintProperty(CELL_FILL, "fill-color", dbzFillColor);
    map.setPaintProperty(CELL_FILL, "fill-outline-color", "rgba(0,0,0,0)");
    map.setPaintProperty(CELL_FILL, "fill-opacity", dbzFillOpacity);
    map.setLayoutProperty(CELL_FILL, "fill-sort-key", [
      "coalesce",
      ["get", "dbz"],
      ["get", "order"],
      0,
    ]);
  }
  if (map.getLayer(RADAR_FILL)) {
    map.setPaintProperty(RADAR_FILL, "fill-color", dbzFillColor);
    map.setPaintProperty(RADAR_FILL, "fill-outline-color", "rgba(0,0,0,0)");
    map.setPaintProperty(RADAR_FILL, "fill-opacity", 1);
    map.setLayoutProperty(RADAR_FILL, "fill-sort-key", [
      "coalesce",
      ["get", "dbz"],
      0,
    ]);
  }
  if (map.getLayer(CELL_LINE)) {
    map.setPaintProperty(CELL_LINE, "line-color", cellLineColor);
    map.setPaintProperty(CELL_LINE, "line-width", cellLineWidth);
    map.setPaintProperty(CELL_LINE, "line-blur", 0.35);
    map.setPaintProperty(CELL_LINE, "line-opacity", 0.72);
  }
  if (map.getLayer(RADAR_LINE)) {
    map.setLayoutProperty(RADAR_LINE, "visibility", "none");
  }
  if (map.getLayer(RADAR_PEAK)) {
    map.setPaintProperty(RADAR_PEAK, "circle-radius", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "dbz"], 50],
      50,
      2.6,
      58,
      3.4,
      65,
      5,
      70,
      6,
    ]);
    map.setPaintProperty(RADAR_PEAK, "circle-color", [
      "step",
      ["coalesce", ["get", "dbz"], 50],
      "rgba(255, 248, 250, 0.65)",
      65,
      "rgba(255, 220, 255, 0.85)",
    ]);
    map.setPaintProperty(RADAR_PEAK, "circle-stroke-width", [
      "step",
      ["coalesce", ["get", "dbz"], 50],
      1.5,
      65,
      2.2,
    ]);
    map.setPaintProperty(RADAR_PEAK, "circle-stroke-color", [
      "step",
      ["coalesce", ["get", "dbz"], 50],
      "rgba(210, 45, 70, 0.85)",
      65,
      "rgba(200, 60, 230, 0.95)",
    ]);
    map.setPaintProperty(RADAR_PEAK, "circle-opacity", 0.9);
    map.setPaintProperty(RADAR_PEAK, "circle-blur", 0.08);
  }

  if (map.getLayer(ACT_CORE)) {
    map.setPaintProperty(ACT_CORE, "circle-radius", [
      "coalesce",
      ["get", "coreR"],
      ["interpolate", ["linear"], ["get", "dbz"], 30, 3.5, 50, 6, 60, 8],
      5,
    ]);
  }
  if (map.getLayer(ACT_HALO)) {
    map.setPaintProperty(ACT_HALO, "circle-radius", [
      "+",
      8,
      ["*", 0.9, ["coalesce", ["get", "coreR"], 5]],
    ]);
  }
  for (const id of [ARROW_LAYER, FORM_ARROW_LAYER]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "icon-anchor", "bottom");
      map.setLayoutProperty(id, "icon-rotation-alignment", "map");
      map.setLayoutProperty(id, "icon-size", id === ARROW_LAYER ? 0.26 : 0.28);
      map.setPaintProperty(id, "icon-opacity", 0.55);
      map.setPaintProperty(id, "icon-halo-width", 0.6);
    }
  }
  if (map.getLayer(TRACK_LINE)) {
    map.setPaintProperty(TRACK_LINE, "line-opacity", 0.4);
  }

  const arrowData = createArrowImageData();
  if (arrowData && !map.hasImage("storm-arrow")) {
    try {
      map.addImage("storm-arrow", arrowData, { sdf: true });
    } catch {
      // souběžný style reload — ikona už existuje
    }
  }

  emphasizeCountryBorders(map);

  if (!map.getSource(FORM_GRID_SOURCE)) {
    map.addSource(FORM_GRID_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(FORM_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(FORM_LINK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(FORM_CENTER_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(FORM_TRACK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(FORM_ARROW_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: FORM_GRID,
      type: "circle",
      source: FORM_GRID_SOURCE,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["get", "score"],
          20,
          2,
          35,
          3.5,
          55,
          5,
        ],
        "circle-color": [
          "match",
          ["get", "severity"],
          "strong",
          "rgba(232, 93, 75, 0.55)",
          "moderate",
          "rgba(232, 165, 75, 0.45)",
          "rgba(94, 176, 224, 0.35)",
        ],
        "circle-opacity": 0.4,
        "circle-blur": 0.35,
      },
    });
    map.addLayer({
      id: FORM_FILL,
      type: "fill",
      source: FORM_SOURCE,
      paint: {
        "fill-color": [
          "match",
          ["get", "severity"],
          "strong",
          "rgba(232, 93, 75, 0.38)",
          "moderate",
          "rgba(232, 165, 75, 0.28)",
          "rgba(94, 176, 224, 0.2)",
        ],
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["get", "score"],
          20,
          0.14,
          35,
          0.22,
          55,
          0.36,
        ],
        "fill-outline-color": [
          "match",
          ["get", "severity"],
          "strong",
          "rgba(232, 93, 75, 0.85)",
          "moderate",
          "rgba(232, 165, 75, 0.75)",
          "rgba(94, 176, 224, 0.7)",
        ],
      },
    });
    map.addLayer({
      id: FORM_LINE,
      type: "line",
      source: FORM_SOURCE,
      paint: {
        "line-color": [
          "match",
          ["get", "severity"],
          "strong",
          "rgba(255, 140, 120, 0.95)",
          "moderate",
          "rgba(255, 200, 120, 0.9)",
          "rgba(140, 200, 240, 0.85)",
        ],
        "line-width": ["match", ["get", "rank"], 3, 2.6, 2, 2, 1.5],
        "line-dasharray": [3, 1.2],
      },
    });
    map.addLayer({
      id: FORM_LINK,
      type: "line",
      source: FORM_LINK_SOURCE,
      paint: {
        "line-color": "rgba(200, 160, 255, 0.75)",
        "line-width": 1.6,
        "line-dasharray": [1.5, 1.8],
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: FORM_TRACK_LINE,
      type: "line",
      source: FORM_TRACK_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": trackColorExpr,
        "line-width": [
          "case",
          ["==", ["get", "threatens"], 1],
          2.4,
          1.8,
        ],
        "line-opacity": 0.7,
        "line-dasharray": [2.2, 1.4],
      },
    });
    map.addLayer({
      id: FORM_ARROW_LAYER,
      type: "symbol",
      source: FORM_ARROW_SOURCE,
      layout: {
        "icon-image": "storm-arrow",
        "icon-size": 0.36,
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-color": trackColorExpr,
        "icon-halo-color": "rgba(10, 14, 20, 0.9)",
        "icon-halo-width": 1.2,
      },
    });
    map.addLayer({
      id: FORM_CENTER,
      type: "circle",
      source: FORM_CENTER_SOURCE,
      paint: {
        "circle-radius": ["match", ["get", "rank"], 3, 7, 2, 5.5, 4.5],
        "circle-color": [
          "match",
          ["get", "severity"],
          "strong",
          "rgba(255, 120, 90, 0.95)",
          "moderate",
          "rgba(255, 190, 100, 0.9)",
          "rgba(120, 200, 255, 0.85)",
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(255, 255, 255, 0.85)",
        "circle-opacity": 0.92,
      },
    });
    map.addLayer({
      id: FORM_LABEL,
      type: "symbol",
      source: FORM_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11.5,
        "text-anchor": "center",
        "text-line-height": 1.2,
        "text-offset": [0, 1.2],
      },
      paint: {
        "text-color": "#ffe8d0",
        "text-halo-color": "rgba(10, 14, 20, 0.92)",
        "text-halo-width": 1.4,
      },
    });
  }

  if (!map.getSource(RADAR_RASTER_SOURCE)) {
    // Placeholder 1×1 — updateImage při načtení latest.png
    map.addSource(RADAR_RASTER_SOURCE, {
      type: "image",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      coordinates: [
        [12, 51],
        [19, 51],
        [19, 48.5],
        [12, 48.5],
      ],
    });
    map.addLayer({
      id: RADAR_RASTER,
      type: "raster",
      source: RADAR_RASTER_SOURCE,
      layout: { visibility: "none" },
      paint: {
        "raster-opacity": 0.9,
        "raster-fade-duration": 0,
      },
    });
  }

  if (!map.getSource(RADAR_SOURCE)) {
    map.addSource(RADAR_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: RADAR_FILL,
      type: "fill",
      source: RADAR_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: {
        "fill-sort-key": ["coalesce", ["get", "dbz"], 0],
      },
      paint: {
        "fill-color": dbzFillColor,
        "fill-opacity": 1,
      },
    });
    map.addLayer({
      id: RADAR_LINE,
      type: "line",
      source: RADAR_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: {
        visibility: "none",
      },
      paint: {
        "line-color": dbzOutlineColor,
        "line-width": 0.85,
        "line-blur": 0.4,
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: RADAR_PEAK,
      type: "circle",
      source: RADAR_SOURCE,
      filter: ["==", ["get", "kind"], "peak"],
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "dbz"], 50],
          50,
          2.6,
          58,
          3.4,
          65,
          5,
          70,
          6,
        ],
        "circle-color": [
          "step",
          ["coalesce", ["get", "dbz"], 50],
          "rgba(255, 248, 250, 0.65)",
          65,
          "rgba(255, 220, 255, 0.85)",
        ],
        "circle-stroke-width": [
          "step",
          ["coalesce", ["get", "dbz"], 50],
          1.5,
          65,
          2.2,
        ],
        "circle-stroke-color": [
          "step",
          ["coalesce", ["get", "dbz"], 50],
          "rgba(210, 45, 70, 0.85)",
          65,
          "rgba(200, 60, 230, 0.95)",
        ],
        "circle-opacity": 0.9,
      },
    });
  }

  if (!map.getSource(GHOST_SOURCE)) {
    map.addSource(GHOST_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    const beforeCells = map.getLayer(CELL_FILL) ? CELL_FILL : undefined;
    map.addLayer(
      {
        id: GHOST_FILL,
        type: "fill",
        source: GHOST_SOURCE,
        paint: {
          "fill-color": "rgba(180, 180, 190, 0.14)",
          "fill-outline-color": "rgba(220, 220, 230, 0.45)",
        },
      },
      beforeCells,
    );
    map.addLayer(
      {
        id: GHOST_LINE,
        type: "line",
        source: GHOST_SOURCE,
        paint: {
          "line-color": "rgba(210, 210, 220, 0.55)",
          "line-width": 1.2,
          "line-dasharray": [2, 2],
          "line-opacity": 0.75,
        },
      },
      beforeCells,
    );
  }

  if (!map.getSource(BIRTH_TRAIL_SOURCE)) {
    map.addSource(BIRTH_TRAIL_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(BIRTH_MARK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: BIRTH_TRAIL,
      type: "line",
      source: BIRTH_TRAIL_SOURCE,
      paint: {
        "line-color": "rgba(160, 200, 255, 0.75)",
        "line-width": 1.8,
        "line-dasharray": [2.2, 1.6],
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: BIRTH_MARK,
      type: "circle",
      source: BIRTH_MARK_SOURCE,
      paint: {
        "circle-radius": [
          "case",
          ["==", ["get", "newborn"], 1],
          6,
          3.5,
        ],
        "circle-color": [
          "case",
          ["==", ["get", "newborn"], 1],
          "rgba(255, 120, 160, 0.9)",
          "rgba(190, 200, 220, 0.55)",
        ],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "rgba(255, 255, 255, 0.75)",
      },
    });
    map.addLayer({
      id: BIRTH_LABEL,
      type: "symbol",
      source: BIRTH_MARK_SOURCE,
      filter: ["==", ["get", "newborn"], 1],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.15],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#e8f0ff",
        "text-halo-color": "rgba(10, 14, 20, 0.9)",
        "text-halo-width": 1.2,
      },
    });
  }

  if (!map.getSource(CELL_SOURCE)) {
    map.addSource(CELL_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // Pod trajektorií — buňka jako radarové kontury dBZ
    const beforeTrack = map.getLayer(TRACK_LINE) ? TRACK_LINE : undefined;
    map.addLayer(
      {
        id: CELL_FILL,
        type: "fill",
        source: CELL_SOURCE,
        layout: {
          "fill-sort-key": ["coalesce", ["get", "dbz"], ["get", "order"], 0],
        },
        paint: {
          "fill-color": dbzFillColor,
          "fill-opacity": dbzFillOpacity,
        },
      },
      beforeTrack,
    );
    map.addLayer(
      {
        id: CELL_LINE,
        type: "line",
        source: CELL_SOURCE,
        paint: {
          "line-color": cellLineColor,
          "line-width": cellLineWidth,
          "line-blur": 0.35,
          "line-opacity": 0.72,
        },
      },
      beforeTrack,
    );
  }

  if (!map.getSource(INTENS_SOURCE)) {
    map.addSource(INTENS_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(INTENS_MARK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource(INTENS_HALO_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    const beforeTrackIntens = map.getLayer(TRACK_LINE) ? TRACK_LINE : undefined;
    map.addLayer(
      {
        id: INTENS_FILL,
        type: "fill",
        source: INTENS_SOURCE,
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["get", "score"],
            28,
            "rgba(160, 100, 220, 0.12)",
            50,
            "rgba(180, 90, 255, 0.22)",
            70,
            "rgba(200, 80, 255, 0.32)",
          ],
          "fill-outline-color": "rgba(200, 140, 255, 0.55)",
        },
      },
      beforeTrackIntens,
    );
    map.addLayer(
      {
        id: INTENS_LINE,
        type: "line",
        source: INTENS_SOURCE,
        paint: {
          "line-color": "rgba(200, 130, 255, 0.85)",
          "line-width": 1.8,
          "line-dasharray": [2.5, 1.5],
          "line-opacity": 0.8,
        },
      },
      beforeTrackIntens,
    );
    map.addLayer({
      id: INTENS_HALO,
      type: "circle",
      source: INTENS_HALO_SOURCE,
      paint: {
        "circle-radius": 16,
        "circle-color": "rgba(190, 100, 255, 0.28)",
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(220, 160, 255, 0.9)",
        "circle-opacity": 0.9,
      },
    });
    map.addLayer({
      id: INTENS_MARK,
      type: "circle",
      source: INTENS_MARK_SOURCE,
      paint: {
        "circle-radius": 5,
        "circle-color": "rgba(200, 120, 255, 0.95)",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "rgba(255, 255, 255, 0.85)",
      },
    });
    map.addLayer({
      id: INTENS_LABEL,
      type: "symbol",
      source: INTENS_MARK_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.35],
        "text-anchor": "top",
        "text-line-height": 1.15,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#f0d8ff",
        "text-halo-color": "rgba(12, 10, 20, 0.92)",
        "text-halo-width": 1.3,
      },
    });
  }

  if (!map.getSource(LIFE_SOURCE)) {
    map.addSource(LIFE_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: LIFE_PATH,
      type: "line",
      source: LIFE_SOURCE,
      filter: ["==", ["get", "kind"], "path"],
      paint: {
        "line-color": "rgba(220, 230, 245, 0.75)",
        "line-width": 2.2,
        "line-dasharray": [1.2, 1.4],
      },
    });
    map.addLayer({
      id: LIFE_BIRTH,
      type: "circle",
      source: LIFE_SOURCE,
      filter: ["==", ["get", "kind"], "birth"],
      paint: {
        "circle-radius": 6,
        "circle-color": "rgba(255, 130, 170, 0.95)",
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(255, 255, 255, 0.9)",
      },
    });
    map.addLayer({
      id: LIFE_INTENS,
      type: "circle",
      source: LIFE_SOURCE,
      filter: ["==", ["get", "kind"], "intensify"],
      paint: {
        "circle-radius": 8,
        "circle-color": "rgba(190, 110, 255, 0.95)",
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(255, 255, 255, 0.95)",
      },
    });
    map.addLayer({
      id: LIFE_DEMISE,
      type: "circle",
      source: LIFE_SOURCE,
      filter: ["==", ["get", "kind"], "demise"],
      paint: {
        "circle-radius": [
          "match",
          ["get", "confidence"],
          "observed",
          8,
          "trending",
          7,
          6,
        ],
        "circle-color": [
          "match",
          ["get", "confidence"],
          "observed",
          "rgba(200, 160, 120, 0.95)",
          "trending",
          "rgba(190, 165, 140, 0.75)",
          "rgba(170, 160, 150, 0.45)",
        ],
        "circle-stroke-width": [
          "match",
          ["get", "confidence"],
          "climatology",
          1.2,
          2,
        ],
        "circle-stroke-color": [
          "match",
          ["get", "confidence"],
          "observed",
          "rgba(255, 255, 255, 0.92)",
          "trending",
          "rgba(255, 255, 255, 0.75)",
          "rgba(220, 210, 200, 0.55)",
        ],
        "circle-opacity": [
          "match",
          ["get", "confidence"],
          "observed",
          0.95,
          "trending",
          0.8,
          0.55,
        ],
      },
    });
    map.addLayer({
      id: LIFE_LABEL,
      type: "symbol",
      source: LIFE_SOURCE,
      filter: [
        "any",
        ["==", ["get", "kind"], "intensify"],
        ["==", ["get", "kind"], "demise"],
        ["==", ["get", "kind"], "birth"],
      ],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-line-height": 1.15,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": [
          "match",
          ["get", "kind"],
          "intensify",
          "#e8d0ff",
          "demise",
          "#f0dcc0",
          "#ffe0ec",
        ],
        "text-opacity": [
          "case",
          [
            "all",
            ["==", ["get", "kind"], "demise"],
            ["==", ["get", "confidence"], "climatology"],
          ],
          0.65,
          0.95,
        ],
        "text-halo-color": "rgba(10, 14, 20, 0.92)",
        "text-halo-width": 1.35,
      },
    });
  }

  if (!map.getSource(TRACK_CORRIDOR_SOURCE)) {
    map.addSource(TRACK_CORRIDOR_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: TRACK_CORRIDOR_FILL,
      type: "fill",
      source: TRACK_CORRIDOR_SOURCE,
      paint: {
        "fill-color": [
          "case",
          ["==", ["get", "threatens"], 1],
          "rgba(255, 150, 90, 0.11)",
          "rgba(130, 175, 220, 0.07)",
        ],
        "fill-opacity": 1,
      },
    });
  }

  if (!map.getSource(TRACK_SOURCE)) {
    map.addSource(TRACK_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: TRACK_LINE,
      type: "line",
      source: TRACK_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": trackColorExpr,
        "line-width": [
          "case",
          ["==", ["get", "threatens"], 1],
          1.6,
          ["match", ["get", "rank"], 3, 1.4, 2, 1.2, 1.0],
        ],
        "line-opacity": 0.4,
        "line-dasharray": [2, 2.2],
      },
    });
  }

  if (!map.getSource(ARROW_SOURCE)) {
    map.addSource(ARROW_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: ARROW_LAYER,
      type: "symbol",
      source: ARROW_SOURCE,
      layout: {
        "icon-image": "storm-arrow",
        "icon-size": 0.26,
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-color": trackColorExpr,
        "icon-opacity": 0.55,
        "icon-halo-color": "rgba(10, 14, 20, 0.55)",
        "icon-halo-width": 0.6,
      },
    });
  }

  if (!map.getSource(ACT_SOURCE)) {
    map.addSource(ACT_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // Jemné halo jen když míří k uživateli
    map.addLayer({
      id: ACT_HALO,
      type: "circle",
      source: ACT_SOURCE,
      filter: ["==", ["get", "threatens"], 1],
      paint: {
        "circle-radius": [
          "+",
          8,
          ["*", 0.9, ["coalesce", ["get", "coreR"], 5]],
        ],
        "circle-color": "rgba(255, 107, 61, 0.2)",
        "circle-stroke-width": 0,
      },
    });
    // Epicentrum — velikost podle predikovaného dBZ (vývoj)
    map.addLayer({
      id: ACT_CORE,
      type: "circle",
      source: ACT_SOURCE,
      paint: {
        "circle-radius": [
          "coalesce",
          ["get", "coreR"],
          ["interpolate", ["linear"], ["get", "dbz"], 30, 3.5, 50, 6, 60, 8],
          5,
        ],
        "circle-color": [
          "case",
          ["==", ["get", "threatens"], 1],
          "#ff6b3d",
          "#fff6f0",
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": [
          "case",
          ["==", ["get", "threatens"], 1],
          "#ffc4b0",
          "rgba(220, 60, 90, 0.95)",
        ],
        "circle-opacity": 0.98,
      },
    });
    map.addLayer({
      id: ACT_LABEL,
      type: "symbol",
      source: ACT_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-offset": [0, 1.35],
        "text-anchor": "top",
        "text-line-height": 1.2,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "threatens"], 1],
          "#ffc4b0",
          "#e8eef4",
        ],
        "text-halo-color": "rgba(10, 14, 20, 0.92)",
        "text-halo-width": 1.5,
      },
    });
  }
}

function createUserPinElement(placeName: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "user-pin-marker";
  wrap.title = placeName;

  const label = document.createElement("span");
  label.className = "user-pin-label";
  label.textContent = placeName;

  const head = document.createElement("div");
  head.className = "user-pin-head";

  const pulse = document.createElement("span");
  pulse.className = "user-pin-pulse";
  pulse.setAttribute("aria-hidden", "true");

  const icon = document.createElement("span");
  icon.className = "user-pin-icon";

  head.appendChild(pulse);
  head.appendChild(icon);
  wrap.appendChild(label);
  wrap.appendChild(head);

  return wrap;
}

function syncUserLocationMarker(
  map: maplibregl.Map,
  markerRef: MutableRefObject<maplibregl.Marker | null>,
  location: UserLocation | null,
  options?: { flyTo?: boolean },
) {
  if (!location) {
    markerRef.current?.remove();
    markerRef.current = null;
    return;
  }

  const lngLat: [number, number] = [location.lon, location.lat];

  if (!markerRef.current) {
    markerRef.current = new maplibregl.Marker({
      element: createUserPinElement(location.placeName),
      anchor: "bottom",
    })
      .setLngLat(lngLat)
      .addTo(map);
  } else {
    markerRef.current.setLngLat(lngLat);
    const el = markerRef.current.getElement();
    el.title = location.placeName;
    const label = el.querySelector(".user-pin-label");
    if (label) label.textContent = location.placeName;
  }

  if (options?.flyTo !== false) {
    map.flyTo({
      center: lngLat,
      zoom: 9.5,
      speed: 1.1,
      curve: 1.4,
    });
  }
}

export function MapView({
  location,
  showFormation,
  showProgress,
  showRadar,
  windMode,
  timeOffsetMinutes,
  selected,
  onSelect,
  onWindSource,
  onFormationSource,
  onThreatAlerts,
  onHistoryRadarTime,
  onFormationStats,
  onFormationPoints,
  onMapReady,
}: Props) {
  const { t, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;
  const [mapReady, setMapReady] = useState(false);
  const windOverlayRef = useRef<WindParticleOverlay | null>(null);
  const radarDataRef = useRef<FeatureCollection>({
    type: "FeatureCollection",
    features: [],
  });
  const {
    radarData,
    radarRaster,
    trackedCells,
    windLow,
    windUpper,
    windReal,
    formationZones,
    formationReal,
    formationScoredPoints,
    radarHistory,
    operaTime,
    chmiTime,
  } = useStormDataContext();
  const [historicalRadar, setHistoricalRadar] = useState<FeatureCollection | null>(
    null,
  );
  const [historicalRaster, setHistoricalRaster] =
    useState<RadarRasterMeta | null>(null);
  /** Tik pro živou advekci na „Teď“ (mezi 5min snímky). */
  const [liveClockMs, setLiveClockMs] = useState(() => Date.now());
  const forecastMinutes = Math.max(0, timeOffsetMinutes);
  const isHistoryView = timeOffsetMinutes < 0;
  const isLiveNow = timeOffsetMinutes === 0;
  const windGrid = windLow;
  /** Live / history PNG; forecast = stejný PNG posunutý po tracku. */
  const baseRaster = isHistoryView ? historicalRaster : radarRaster;
  /** OPERA snímek řídí raster; ČHMÚ jen fallback času. */
  const radarProductIso = operaTime ?? chmiTime;

  useEffect(() => {
    if (!isLiveNow) return;
    setLiveClockMs(Date.now());
    const id = window.setInterval(() => setLiveClockMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLiveNow, radarProductIso]);

  /**
   * Teď → věk snímku (pohyb každou sekundu).
   * +N → slider. Historie → 0.
   */
  const motionMinutes = motionMinutesForView({
    timeOffsetMinutes,
    productIso: radarProductIso,
    nowMs: liveClockMs,
  });

  const radarProgress = useMemo(
    () =>
      buildRadarProgressFeatures(
        trackedCells,
        windLow,
        location,
        formationScoredPoints,
        windUpper,
        locale,
      ),
    [trackedCells, windLow, windUpper, location, formationScoredPoints, locale],
  );

  const intensForecasts = useMemo(
    () => buildIntensificationForecasts(radarProgress, formationScoredPoints),
    [radarProgress, formationScoredPoints],
  );

  const evolution = useMemo(
    () => stormEvolutionAt(radarProgress, intensForecasts, motionMinutes),
    [radarProgress, intensForecasts, motionMinutes],
  );

  const activeRaster = useMemo(() => {
    if (!baseRaster) return null;
    if (isHistoryView) return baseRaster;
    let next = baseRaster;
    if (motionMinutes > 0.05) {
      const { dLon, dLat } = meanForecastDelta(radarProgress, motionMinutes);
      next = shiftRadarRaster(next, dLon, dLat);
      next = scaleRadarRaster(next, evolution.footprintScale);
    }
    return next;
  }, [
    baseRaster,
    isHistoryView,
    motionMinutes,
    radarProgress,
    evolution.footprintScale,
  ]);

  const useRasterDisplay = Boolean(activeRaster);
  const operaReady = radarData.features.length > 0 || Boolean(activeRaster);
  const rasterReadyRef = useRef(false);
  const radarRasterRef = useRef(activeRaster);
  radarRasterRef.current = activeRaster;
  const onSelectRef = useRef(onSelect);
  const onWindSourceRef = useRef(onWindSource);
  const onFormationSourceRef = useRef(onFormationSource);
  const onThreatAlertsRef = useRef(onThreatAlerts);
  const onHistoryRadarTimeRef = useRef(onHistoryRadarTime);
  const onFormationStatsRef = useRef(onFormationStats);
  const onFormationPointsRef = useRef(onFormationPoints);
  const onMapReadyRef = useRef(onMapReady);
  const windModeRef = useRef(windMode);
  const windLowRef = useRef(windLow);
  const windUpperRef = useRef(windUpper);
  const windRealRef = useRef(windReal);
  onSelectRef.current = onSelect;
  onWindSourceRef.current = onWindSource;
  onFormationSourceRef.current = onFormationSource;
  onThreatAlertsRef.current = onThreatAlerts;
  onHistoryRadarTimeRef.current = onHistoryRadarTime;
  onFormationStatsRef.current = onFormationStats;
  onFormationPointsRef.current = onFormationPoints;
  onMapReadyRef.current = onMapReady;
  windModeRef.current = windMode;
  windLowRef.current = windLow;
  windUpperRef.current = windUpper;
  windRealRef.current = windReal;

  useEffect(() => {
    if (!radarHistory || timeOffsetMinutes >= 0) {
      setHistoricalRadar(null);
      setHistoricalRaster(null);
      onHistoryRadarTimeRef.current?.(null);
      return;
    }
    const frame = frameForOffset(radarHistory, timeOffsetMinutes);
    if (!frame) {
      setHistoricalRadar(null);
      setHistoricalRaster(null);
      onHistoryRadarTimeRef.current?.(null);
      return;
    }
    onHistoryRadarTimeRef.current?.(frame.time);
    let cancelled = false;
    // Bez cache-bust — boot preload naplní cache, scrub je okamžitý.
    void Promise.all([
      loadRadarHistoryFrame(frame),
      loadRadarHistoryRaster(frame),
    ]).then(([fc, raster]) => {
      if (cancelled) return;
      setHistoricalRadar(fc);
      if (raster) setHistoricalRaster(raster);
    });
    return () => {
      cancelled = true;
    };
  }, [radarHistory, timeOffsetMinutes]);

  const displayRadarData = useMemo(() => {
    const raw =
      isHistoryView && historicalRadar ? historicalRadar : radarData;
    const focused = filterRadarForCzFocus(raw);
    // Raster: kontury schovej — nech jen peaky pro hit-test
    if (useRasterDisplay) {
      return {
        type: "FeatureCollection" as const,
        features: focused.features.filter(
          (f) => f.properties?.kind === "peak" || f.geometry?.type === "Point",
        ),
      };
    }
    return focused;
  }, [isHistoryView, historicalRadar, radarData, useRasterDisplay]);

  useEffect(() => {
    onWindSourceRef.current?.(windReal);
    onFormationSourceRef.current?.(formationReal);
    if (windLow && windUpper) {
      windOverlayRef.current?.setWindGrids(windLow, windUpper, windReal);
    }
  }, [windLow, windUpper, windReal, formationReal]);

  useEffect(() => {
    radarDataRef.current = displayRadarData;
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      ensureStormLayers(map);
      (map.getSource(RADAR_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
        radarDataRef.current,
      );
      void (async () => {
        if (activeRaster && useRasterDisplay) {
          const ok = await syncRadarRasterImage(map, activeRaster);
          rasterReadyRef.current = ok;
          if (ok && showRadar) {
            setLayerVisibility(map, [RADAR_RASTER], true);
            if (map.getLayer(RADAR_RASTER)) {
              map.setPaintProperty(
                RADAR_RASTER,
                "raster-opacity",
                evolution.rasterOpacity,
              );
            }
          }
        } else {
          rasterReadyRef.current = false;
          setLayerVisibility(map, [RADAR_RASTER], false);
        }
      })();
    };
    return whenStyleReady(map, apply);
  }, [
    displayRadarData,
    activeRaster,
    useRasterDisplay,
    showRadar,
    evolution.rasterOpacity,
  ]);

  const radarProgressEnriched = useMemo(
    () =>
      radarProgress.map((f) => ({
        ...f,
        intensification: intensForecasts.get(f.id),
      })),
    [radarProgress, intensForecasts],
  );
  const formationLinks = useMemo(
    () => linkFormationToRadarCells(formationZones, radarProgressEnriched, windGrid),
    [formationZones, radarProgressEnriched, windGrid],
  );
  const linkedFormationZones = useMemo(
    () => applyFormationLinks(formationZones, formationLinks),
    [formationZones, formationLinks],
  );
  const formationFeatures = useMemo(
    () => buildFormationFeatures(linkedFormationZones, windLow, location, windUpper),
    [linkedFormationZones, windLow, windUpper, location],
  );
  const activeFeatures = useMemo(
    () => buildActiveFeatures(demoActiveStorms, location),
    [location],
  );
  const threatBanners = useMemo(
    () =>
      pickThreatBanners(
        radarProgressEnriched,
        formationFeatures,
        location?.placeName ?? null,
      ),
    [radarProgressEnriched, formationFeatures, location],
  );
  const useRadarProgress = radarProgressEnriched.length > 0;

  useEffect(() => {
    onThreatAlertsRef.current?.(threatBanners);
  }, [threatBanners]);

  useEffect(() => {
    onFormationStatsRef.current?.({
      count: formationFeatures.length,
      linkCount: formationLinks.length,
    });
  }, [formationFeatures.length, formationLinks.length]);

  useEffect(() => {
    onFormationPointsRef.current?.(formationScoredPoints);
  }, [formationScoredPoints]);

  const formationRef = useRef(formationFeatures);
  const activeRef = useRef(activeFeatures);
  const radarRef = useRef(radarProgressEnriched);
  const forecastRef = useRef(motionMinutes);
  formationRef.current = formationFeatures;
  activeRef.current = activeFeatures;
  radarRef.current = radarProgressEnriched;
  forecastRef.current = motionMinutes;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: CZ_CENTER,
      zoom: 6.6,
      maxBounds: [
        [6.2, 45.9],
        [23.2, 53.0],
      ],
      attributionControl: { compact: true },
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    map.fitBounds(CZ_BOUNDS, { padding: 48, duration: 0 });

    windOverlayRef.current = new WindParticleOverlay(map);
    if (windLowRef.current && windUpperRef.current) {
      windOverlayRef.current.setWindGrids(
        windLowRef.current,
        windUpperRef.current,
        windRealRef.current,
      );
    }
    windOverlayRef.current.setMode(windModeRef.current);

    map.on("load", () => {
      setMapReady(true);
      ensureStormLayers(map);
      (map.getSource(RADAR_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        radarDataRef.current,
      );
      (map.getSource(CELL_SOURCE) as maplibregl.GeoJSONSource).setData(
        useRadarProgress
          ? radarCellsGeoJSONAt(radarRef.current, forecastRef.current)
          : activeCellGeoJSON(activeRef.current, forecastRef.current),
      );
      (map.getSource(ACT_SOURCE) as maplibregl.GeoJSONSource).setData(
        useRadarProgress
          ? radarPointsGeoJSONAt(radarRef.current, forecastRef.current)
          : activePointsGeoJSON(activeRef.current, forecastRef.current),
      );
      (map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource).setData(
        useRadarProgress
          ? radarTracksGeoJSONAt(radarRef.current, forecastRef.current)
          : activeTracksGeoJSON(activeRef.current, forecastRef.current),
      );
      (map.getSource(TRACK_CORRIDOR_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        useRadarProgress
          ? radarTrackCorridorsGeoJSONAt(radarRef.current, forecastRef.current)
          : { type: "FeatureCollection", features: [] },
      );
      (map.getSource(ARROW_SOURCE) as maplibregl.GeoJSONSource).setData(
        useRadarProgress
          ? radarArrowsGeoJSONAt(radarRef.current, forecastRef.current)
          : activeArrowsGeoJSON(activeRef.current, forecastRef.current),
      );

      if (locationRef.current) {
        syncUserLocationMarker(map, markerRef, locationRef.current, {
          flyTo: false,
        });
      }

      void (async () => {
        // Nevolat onMapReady, dokud není PNG v mapě — jinak červený error-quad.
        let notified = false;
        const notifyReady = () => {
          if (notified) return;
          notified = true;
          onMapReadyRef.current?.();
        };
        const meta = radarRasterRef.current;
        if (meta) {
          const ok = await syncRadarRasterImage(map, meta);
          rasterReadyRef.current = ok;
          if (ok) setLayerVisibility(map, [RADAR_RASTER], true);
        } else {
          rasterReadyRef.current = false;
        }
        map.once("idle", notifyReady);
        window.setTimeout(notifyReady, 600);
      })();
    });

    const selectLockUntilRef = { current: 0 };
    const selectStorm = (storm: SelectedStorm) => {
      selectLockUntilRef.current = performance.now() + 900;
      if (storm.kind === "radar") {
        const sid = String(storm.feature.id);
        const live =
          radarRef.current.find((f) => String(f.id) === sid) ?? storm.feature;
        onSelectRef.current({ kind: "radar", feature: live });
        return;
      }
      onSelectRef.current(storm);
    };

    map.on("click", (e) => {
      const clickLat = e.lngLat.lat;
      const clickLon = e.lngLat.lng;
      const locked = performance.now() < selectLockUntilRef.current;

      const pickRadarById = (id: string | number | undefined) => {
        if (id == null || id === "") return undefined;
        const sid = String(id);
        return radarRef.current.find((f) => String(f.id) === sid);
      };

      const pickNearestRadar = (maxKm: number) => {
        const cells = radarRef.current;
        const mins = forecastRef.current;
        if (!cells.length) return null;
        let best = cells[0];
        let bestPeak = peakAtForecast(best, mins);
        let bestD = distanceKm(clickLat, clickLon, bestPeak[1], bestPeak[0]);
        for (let i = 1; i < cells.length; i++) {
          const c = cells[i];
          const peak = peakAtForecast(c, mins);
          const d = distanceKm(clickLat, clickLon, peak[1], peak[0]);
          if (d < bestD) {
            best = c;
            bestPeak = peak;
            bestD = d;
          }
        }
        return bestD <= maxKm ? best : null;
      };

      const resolveHit = (hit: maplibregl.MapGeoJSONFeature) => {
        const layerId = hit.layer.id;
        const rawId = (hit.properties?.id ?? hit.properties?.cellId) as
          | string
          | number
          | undefined;

        if (layerId === FORM_FILL || layerId === FORM_CENTER) {
          const feature = formationRef.current.find(
            (f) => String(f.zone.id) === String(rawId),
          );
          if (feature) return { kind: "formation" as const, feature };
        }

        const byId = pickRadarById(rawId);
        if (byId) return { kind: "radar" as const, feature: byId };

        const active = activeRef.current.find(
          (f) => String(f.storm.id) === String(rawId),
        );
        if (active) return { kind: "active" as const, feature: active };

        return null;
      };

      const clickableLayerIds = [
        CELL_FILL,
        CELL_LINE,
        ACT_CORE,
        ACT_HALO,
        ACT_LABEL,
        BIRTH_MARK,
        INTENS_FILL,
        INTENS_LINE,
        INTENS_MARK,
        INTENS_HALO,
        TRACK_LINE,
        ARROW_LAYER,
        FORM_FILL,
        FORM_CENTER,
        RADAR_FILL,
        RADAR_LINE,
        RADAR_PEAK,
      ].filter((id) => map.getLayer(id));

      const hits = map.queryRenderedFeatures(e.point, {
        layers: clickableLayerIds,
      });

      for (const hit of hits) {
        const layerId = hit.layer.id;
        const resolved = resolveHit(hit);
        if (resolved) {
          selectStorm(resolved);
          return;
        }

        if (
          layerId === RADAR_FILL ||
          layerId === RADAR_LINE ||
          layerId === RADAR_PEAK
        ) {
          const linked = pickNearestRadar(22);
          if (linked) {
            selectStorm({ kind: "radar", feature: linked });
            return;
          }
        }
      }

      const nearCell = pickNearestRadar(forecastRef.current > 0 ? 28 : 22);
      if (nearCell) {
        selectStorm({ kind: "radar", feature: nearCell });
        return;
      }

      if (locked) return;
      onSelectRef.current(null);
    });

    for (const layer of [
      FORM_FILL,
      FORM_CENTER,
      CELL_FILL,
      CELL_LINE,
      ACT_CORE,
      BIRTH_MARK,
      TRACK_LINE,
      ARROW_LAYER,
      RADAR_FILL,
    ]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    mapRef.current = map;

    return () => {
      setMapReady(false);
      windOverlayRef.current?.destroy();
      windOverlayRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    windOverlayRef.current?.setMode(windMode);
  }, [windMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      ensureStormLayers(map);
      (map.getSource(FORM_GRID_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationGridGeoJSON(formationScoredPoints),
      );
      (map.getSource(FORM_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationZonesGeoJSON(formationFeatures, locale),
      );
      (map.getSource(FORM_LINK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationLinksGeoJSON(formationLinks),
      );
      (map.getSource(FORM_CENTER_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationCentersGeoJSON(formationFeatures),
      );
      (map.getSource(FORM_TRACK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationTracksGeoJSON(formationFeatures),
      );
      (map.getSource(FORM_ARROW_SOURCE) as maplibregl.GeoJSONSource)?.setData(
        formationArrowsGeoJSON(formationFeatures),
      );
      setLayerVisibility(
        map,
        [
          FORM_GRID,
          FORM_FILL,
          FORM_LINE,
          FORM_LINK,
          FORM_TRACK_LINE,
          FORM_ARROW_LAYER,
          FORM_CENTER,
          FORM_LABEL,
        ],
        showFormation,
      );
    };

    return whenStyleReady(map, apply);
  }, [
    formationFeatures,
    formationScoredPoints,
    formationLinks,
    showFormation,
    locale,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      ensureStormLayers(map);
      const selectedRadarId =
        selected?.kind === "radar" ? selected.feature.id : null;
      const detailCells = selectedRadarId
        ? radarProgressEnriched.filter((f) => f.id === selectedRadarId)
        : [];
      const detailIntens = selectedRadarId
        ? new Map(
            [...intensForecasts.entries()].filter(
              ([id]) => id === selectedRadarId,
            ),
          )
        : new Map();

      if (useRadarProgress) {
        (map.getSource(GHOST_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarCellsGhostGeoJSONAt(detailCells, motionMinutes),
        );
        (map.getSource(BIRTH_TRAIL_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          birthTrailGeoJSON(detailCells),
        );
        (map.getSource(BIRTH_MARK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          birthMarkersGeoJSON(detailCells, locale),
        );
        (map.getSource(CELL_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarCellsGeoJSONAt(
            radarProgressEnriched,
            motionMinutes,
            intensForecasts,
          ),
        );
        (map.getSource(ACT_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarPointsGeoJSONAt(
            radarProgressEnriched,
            motionMinutes,
            intensForecasts,
            locale,
          ),
        );
        (map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarTracksGeoJSONAt(radarProgressEnriched, motionMinutes),
        );
        (map.getSource(TRACK_CORRIDOR_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarTrackCorridorsGeoJSONAt(radarProgressEnriched, motionMinutes),
        );
        (map.getSource(ARROW_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          radarArrowsGeoJSONAt(radarProgressEnriched, motionMinutes),
        );
        (map.getSource(INTENS_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          intensificationCorridorsGeoJSON(detailIntens),
        );
        (map.getSource(INTENS_MARK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          intensificationMarkersGeoJSON(detailIntens),
        );
        (map.getSource(INTENS_HALO_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          intensificationActiveHaloGeoJSON(
            detailCells,
            detailIntens,
            motionMinutes,
          ),
        );
      } else {
        (map.getSource(GHOST_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(BIRTH_TRAIL_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(BIRTH_MARK_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(INTENS_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(INTENS_MARK_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(INTENS_HALO_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(CELL_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          activeCellGeoJSON(activeFeatures, motionMinutes),
        );
        (map.getSource(ACT_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          activePointsGeoJSON(activeFeatures, motionMinutes, locale),
        );
        (map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          activeTracksGeoJSON(activeFeatures, motionMinutes),
        );
        (map.getSource(TRACK_CORRIDOR_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        (map.getSource(ARROW_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          activeArrowsGeoJSON(activeFeatures, motionMinutes),
        );
      }
      const showProgressNow = showProgress && !isHistoryView;
      // Tracky / šipky / peaky v +min — déšť zůstává PNG (posunutý), ne buňkový fill.
      // Tracky / peaky: Progress, nebo automaticky při slideru +min (ne při živé advekci samotné).
      const showForecastOverlay =
        forecastMinutes > 0 && !isHistoryView && useRadarProgress;
      const showCellsNow =
        (showProgressNow || showForecastOverlay) && useRadarProgress;
      const hasOpera =
        useRasterDisplay ||
        (operaReady && radarDataRef.current.features.length > 0);
      const liveRadarOn = showRadar && hasOpera;
      // Posun PNG ve stejném ticku jako peaky (nečekat na async sync effect).
      const rasterMeta = radarRasterRef.current;
      if (rasterMeta && useRasterDisplay) {
        if (applyRadarRasterCoordinates(map, rasterMeta)) {
          rasterReadyRef.current = true;
        }
      }
      const showRaster =
        liveRadarOn && useRasterDisplay && rasterReadyRef.current;
      const showContourFill = liveRadarOn && !useRasterDisplay;
      // Detail (zrod / zesílení / ghost) jen po výběru buňky — mapa zůstane čitelná.
      const showCellDetail =
        showProgressNow && useRadarProgress && selectedRadarId != null;
      // Buňkový fill jen když není raster (fallback) — jinak duplicita pod PNG.
      const showCellFill = showCellsNow && !showRaster;

      setLayerVisibility(
        map,
        [ACT_HALO, ACT_CORE],
        showCellsNow,
      );
      setLayerVisibility(map, [ACT_LABEL], showCellDetail);
      setLayerVisibility(
        map,
        [GHOST_FILL, GHOST_LINE],
        showCellDetail && !showForecastOverlay,
      );
      setLayerVisibility(
        map,
        [BIRTH_TRAIL, BIRTH_MARK, BIRTH_LABEL],
        showCellDetail,
      );
      // Stopa + šipka: Progress, nebo automaticky v +min
      setLayerVisibility(
        map,
        [TRACK_CORRIDOR_FILL, TRACK_LINE, ARROW_LAYER],
        showCellsNow,
      );
      setLayerVisibility(
        map,
        [INTENS_FILL, INTENS_LINE, INTENS_MARK, INTENS_LABEL, INTENS_HALO],
        showCellDetail,
      );
      setLayerVisibility(map, [RADAR_RASTER], showRaster);
      if (showRaster && map.getLayer(RADAR_RASTER)) {
        map.setPaintProperty(
          RADAR_RASTER,
          "raster-opacity",
          evolution.rasterOpacity,
        );
      }
      setLayerVisibility(map, [RADAR_FILL], showContourFill);
      // Peak z GeoJSON jen když není progress tečka (jinak dvojitá mimo jádro)
      setLayerVisibility(
        map,
        [RADAR_PEAK],
        liveRadarOn && !showCellsNow,
      );
      setLayerVisibility(map, [RADAR_LINE], false);
      if (map.getLayer(RADAR_FILL)) {
        map.setPaintProperty(RADAR_FILL, "fill-opacity", 1);
      }
      setLayerVisibility(map, [CELL_FILL, CELL_LINE], showCellFill);
      if (map.getLayer(CELL_FILL)) {
        map.setPaintProperty(
          CELL_FILL,
          "fill-opacity",
          showForecastOverlay ? 0.82 : dbzFillOpacity,
        );
      }
    };

    return whenStyleReady(map, apply);
  }, [
    activeFeatures,
    radarProgressEnriched,
    intensForecasts,
    useRadarProgress,
    showProgress,
    showRadar,
    operaReady,
    motionMinutes,
    isHistoryView,
    locale,
    selected,
    useRasterDisplay,
    evolution.rasterOpacity,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      ensureStormLayers(map);
      const lifeLayers = [
        LIFE_PATH,
        LIFE_BIRTH,
        LIFE_INTENS,
        LIFE_DEMISE,
        LIFE_LABEL,
      ];

      if (selected?.kind === "radar") {
        const live =
          radarProgressEnriched.find((f) => f.id === selected.feature.id) ??
          selected.feature;
        const life = buildStormLifecycle(
          live,
          live.intensification,
          formationScoredPoints,
        );
        (map.getSource(LIFE_SOURCE) as maplibregl.GeoJSONSource)?.setData(
          lifecycleMapGeoJSON(live, life),
        );
        setLayerVisibility(map, lifeLayers, showProgress);
      } else {
        (map.getSource(LIFE_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [],
        });
        setLayerVisibility(map, lifeLayers, false);
      }
    };

    return whenStyleReady(map, apply);
  }, [
    selected,
    radarProgressEnriched,
    formationScoredPoints,
    showProgress,
  ]);

  useEffect(() => {
    if (selected?.kind !== "radar") return;
    const live = radarProgressEnriched.find(
      (f) => f.id === selected.feature.id,
    );
    if (!live || live === selected.feature) return;
    onSelectRef.current({ kind: "radar", feature: live });
  }, [radarProgressEnriched, selected]);

  const selectedKey =
    selected == null
      ? null
      : selected.kind === "radar"
        ? `r:${selected.feature.id}`
        : selected.kind === "formation"
          ? `f:${selected.feature.zone.id}`
          : `a:${selected.feature.storm.id}`;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected || !selectedKey) return;

    let center: [number, number] | null = null;
    let zoom = map.getZoom();

    if (selected.kind === "radar") {
      center = selected.feature.peak;
      zoom = Math.max(zoom, 8.2);
    } else if (selected.kind === "formation") {
      center = [selected.feature.zone.lon, selected.feature.zone.lat];
      zoom = Math.max(zoom, 7.8);
    } else if (selected.kind === "active") {
      center = [selected.feature.storm.lon, selected.feature.storm.lat];
      zoom = Math.max(zoom, 8.0);
    }

    if (!center) return;
    // Jemný posun — ne agresivní flyTo (rozbíjel výběr)
    map.easeTo({
      center,
      zoom,
      duration: 450,
      essential: true,
    });
  }, [selectedKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    syncUserLocationMarker(map, markerRef, location);
  }, [location, mapReady]);

  return (
    <div
      ref={containerRef}
      className="map-canvas"
      aria-label={t("map.aria")}
    />
  );
}
