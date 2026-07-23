import type { FeatureCollection } from "geojson";
import { t, type Locale } from "../i18n";
import { fetchData, fetchDataJson } from "./dataUrls";
import { smoothPolygonFeatures } from "./geoSmooth";
import {
  preloadRadarRasterKeep,
  type RadarRasterMeta,
} from "./radarRaster";

export type RadarHistoryFrame = {
  index: number;
  offsetMinutes: number;
  time: string;
  path: string;
  /** Spojitý PNG meta (jako live latest-raster.json). */
  rasterPath?: string;
};

export type RadarHistoryManifest = {
  frameMinutes: number;
  frames: RadarHistoryFrame[];
};

export const HISTORY_MIN_OFFSET = -30;
/** Budoucnost na slideru vypnutá — žádný „radar za N min“. */
export const FORECAST_MAX_OFFSET = 0;
export const TIME_STEP_MINUTES = 5;

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Cache snímků historie — naplní se při bootu, slider pak nic nedotahuje. */
const frameCache = new Map<string, FeatureCollection>();
const rasterCache = new Map<string, RadarRasterMeta>();

function frameCacheKey(frame: RadarHistoryFrame, cacheBust?: number): string {
  // Stejný frame = stejný cache slot (bust jen u síťového fetch).
  void cacheBust;
  return frame.path;
}

function rasterCacheKey(frame: RadarHistoryFrame, cacheBust?: number): string {
  void cacheBust;
  return `${frame.rasterPath ?? frame.path}::raster`;
}

export async function loadRadarHistoryManifest(
  cacheBust?: number,
): Promise<RadarHistoryManifest | null> {
  const data = await fetchDataJson<RadarHistoryManifest>(
    "data/opera/history/manifest.json",
    cacheBust,
  );
  if (!data?.frames?.length) return null;
  return data;
}

/** Najde snímek nejbližší zadanému offsetu (záporné = minulost). */
export function frameForOffset(
  manifest: RadarHistoryManifest,
  offsetMinutes: number,
): RadarHistoryFrame | null {
  if (offsetMinutes >= 0) return null;
  let best = manifest.frames[0];
  let bestDiff = Math.abs(best.offsetMinutes - offsetMinutes);
  for (const frame of manifest.frames) {
    const diff = Math.abs(frame.offsetMinutes - offsetMinutes);
    if (diff < bestDiff) {
      best = frame;
      bestDiff = diff;
    }
  }
  return best;
}

export async function loadRadarHistoryFrame(
  frame: RadarHistoryFrame,
  cacheBust?: number,
  opts?: { smooth?: boolean },
): Promise<FeatureCollection> {
  const key = frameCacheKey(frame, cacheBust);
  const cached = frameCache.get(key);
  if (cached) return cached;

  try {
    const res = await fetchData(frame.path, cacheBust);
    if (!res) return EMPTY_FC;
    const raw = (await res.json()) as FeatureCollection;
    const fc =
      opts?.smooth === false
        ? raw
        : smoothPolygonFeatures(raw, 1);
    frameCache.set(key, fc);
    return fc;
  } catch {
    return EMPTY_FC;
  }
}

/** Načte / přednačte PNG raster pro history frame (blob URL). */
export async function loadRadarHistoryRaster(
  frame: RadarHistoryFrame,
  cacheBust?: number,
): Promise<RadarRasterMeta | null> {
  if (!frame.rasterPath) return null;
  const key = rasterCacheKey(frame, cacheBust);
  const cached = rasterCache.get(key);
  if (cached) return cached;

  const meta = await fetchDataJson<RadarRasterMeta>(
    frame.rasterPath,
    cacheBust,
  );
  if (
    !meta?.url ||
    !Array.isArray(meta.coordinates) ||
    meta.coordinates.length !== 4
  ) {
    return null;
  }

  const withUrl: RadarRasterMeta = {
    ...meta,
    url: meta.url.replace(/^\//, ""),
  };
  const ready = await preloadRadarRasterKeep(withUrl, "force-cache", cacheBust);
  if (ready) rasterCache.set(key, ready);
  return ready;
}

/** Okamžitý hit z boot preload — slider nemusí čekat na Promise. */
export function cachedHistoryFrame(
  frame: RadarHistoryFrame,
): FeatureCollection | undefined {
  return frameCache.get(frameCacheKey(frame));
}

export function cachedHistoryRaster(
  frame: RadarHistoryFrame,
): RadarRasterMeta | undefined {
  return rasterCache.get(rasterCacheKey(frame));
}

/** Přednačte PNG historie — blokující pro boot (slider pak okamžitý). */
export async function preloadRadarHistoryRasters(
  manifest: RadarHistoryManifest | null,
  cacheBust?: number,
): Promise<void> {
  if (!manifest?.frames.length) return;
  await Promise.all(
    manifest.frames.map((frame) => loadRadarHistoryRaster(frame, cacheBust)),
  );
}

/** GeoJSON historie — může běžet na pozadí po zobrazení mapy. */
export async function preloadRadarHistoryGeojson(
  manifest: RadarHistoryManifest | null,
  cacheBust?: number,
): Promise<void> {
  if (!manifest?.frames.length) return;
  await Promise.all(
    manifest.frames.map((frame) =>
      loadRadarHistoryFrame(frame, cacheBust, { smooth: false }),
    ),
  );
}

/** Přednačte všechny historické snímky při startu stránky (geojson + PNG). */
export async function preloadRadarHistoryFrames(
  manifest: RadarHistoryManifest | null,
  cacheBust?: number,
): Promise<void> {
  await preloadRadarHistoryRasters(manifest, cacheBust);
  await preloadRadarHistoryGeojson(manifest, cacheBust);
}

export function formatTimeOffsetLabel(
  offsetMinutes: number,
  locale?: Locale,
): string {
  if (offsetMinutes === 0) return t("time.now", undefined, locale);
  if (offsetMinutes > 0) {
    return t("time.offsetFuture", { min: offsetMinutes }, locale);
  }
  return t("time.offsetPast", { min: Math.abs(offsetMinutes) }, locale);
}

/** OPERA time stamp `YYYYMMDDHHmm` → `DD.MM. HH:mm`. */
export function formatRadarTime(timeStr: string): string | null {
  if (timeStr.length < 12) return null;
  const mo = timeStr.slice(4, 6);
  const d = timeStr.slice(6, 8);
  const h = timeStr.slice(8, 10);
  const mi = timeStr.slice(10, 12);
  return `${d}.${mo}. ${h}:${mi}`;
}
