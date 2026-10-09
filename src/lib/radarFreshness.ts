export const RADAR_STALE_AFTER_MINUTES = 10;

export type RadarFreshness = "current" | "stale" | "unavailable";

export function minutesSince(
  iso: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
}

export function radarFreshness(
  iso: string | null | undefined,
  available: boolean,
  nowMs = Date.now(),
): RadarFreshness {
  if (!available) return "unavailable";
  const age = minutesSince(iso, nowMs);
  if (age == null) return "unavailable";
  return age >= RADAR_STALE_AFTER_MINUTES ? "stale" : "current";
}
