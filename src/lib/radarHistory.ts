import type { FeatureCollection } from "geojson";
import { t, type Locale } from "../i18n";
import { fetchData, fetchDataJson } from "./dataUrls";
import { smoothPolygonFeatures } from "./geoSmooth";

export type RadarHistoryFrame = {
  index: number;
  offsetMinutes: number;
  time: string;
  path: string;
};

export type RadarHistoryManifest = {
  frameMinutes: number;
  frames: RadarHistoryFrame[];
};

export const HISTORY_MIN_OFFSET = -25;
export const FORECAST_MAX_OFFSET = 30;
export const TIME_STEP_MINUTES = 5;

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Cache snímků historie — naplní se při bootu, slider pak nic nedotahuje. */
const frameCache = new Map<string, FeatureCollection>();

function frameCacheKey(frame: RadarHistoryFrame, cacheBust?: number): string {
  return `${frame.path}::${cacheBust ?? "live"}`;
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
): Promise<FeatureCollection> {
  const key = frameCacheKey(frame, cacheBust);
  const cached = frameCache.get(key);
  if (cached) return cached;

  try {
    const res = await fetchData(frame.path, cacheBust);
    if (!res) return EMPTY_FC;
    const fc = smoothPolygonFeatures(
      (await res.json()) as FeatureCollection,
      1,
    );
    frameCache.set(key, fc);
    return fc;
  } catch {
    return EMPTY_FC;
  }
}

/** Přednačte všechny historické snímky při startu stránky. */
export async function preloadRadarHistoryFrames(
  manifest: RadarHistoryManifest | null,
  cacheBust?: number,
): Promise<void> {
  if (!manifest?.frames.length) return;
  frameCache.clear();
  await Promise.all(
    manifest.frames.map((frame) => loadRadarHistoryFrame(frame, cacheBust)),
  );
}

export function formatTimeOffsetLabel(
  offsetMinutes: number,
  locale?: Locale,
): string {
  if (offsetMinutes === 0) return t("time.now", undefined, locale);
  if (offsetMinutes > 0) {
    return t("time.offsetFuture", { min: offsetMinutes }, locale);
  }
  return t("time.offsetPast", { min: offsetMinutes }, locale);
}

export function formatRadarTime(timeStr: string): string | null {
  if (timeStr.length < 12) return null;
  const mo = timeStr.slice(4, 6);
  const d = timeStr.slice(6, 8);
  const h = timeStr.slice(8, 10);
  const mi = timeStr.slice(10, 12);
  return `${d}.${mo}. ${h}:${mi}`;
}
