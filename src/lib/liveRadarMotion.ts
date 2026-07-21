/** Max. minut živé advekce od času snímku (dál už jen hrubý odhad). */
export const LIVE_ADVECT_CAP_MIN = 12;

/** Věk radarového produktu v minutách (clamp ≥ 0). */
export function radarProductAgeMinutes(
  productIso: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!productIso) return 0;
  const t = Date.parse(productIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / 60_000);
}

/**
 * Minuty pro posun / vývoj od času snímku:
 * - historie: 0 (reálný snímek)
 * - Teď: věk snímku (extrapolace na wall-clock teď)
 * - +N: věk + N (monotónní — nikdy zpět oproti Teď)
 */
export function motionMinutesForView(opts: {
  timeOffsetMinutes: number;
  productIso: string | null | undefined;
  nowMs?: number;
  capMin?: number;
}): number {
  const { timeOffsetMinutes, productIso } = opts;
  if (timeOffsetMinutes < 0) return 0;

  const age = radarProductAgeMinutes(productIso, opts.nowMs ?? Date.now());
  const cap = opts.capMin ?? LIVE_ADVECT_CAP_MIN;
  const liveAge = Math.min(cap, age);

  if (timeOffsetMinutes > 0) return liveAge + timeOffsetMinutes;
  return liveAge;
}
