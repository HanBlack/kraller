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
 * - Teď: 0 (přesně co radar ukazuje — bez extrapolace wall-clock)
 * - +N: N minut od snímku (monotónní od Teď)
 */
export function motionMinutesForView(opts: {
  timeOffsetMinutes: number;
  productIso?: string | null | undefined;
  nowMs?: number;
  capMin?: number;
}): number {
  const { timeOffsetMinutes } = opts;
  if (timeOffsetMinutes < 0) return 0;
  if (timeOffsetMinutes > 0) return timeOffsetMinutes;
  return 0;
}

/** Věk snímku — jen pro UI („starý o X min“), ne pro posun jader. */
export function liveExtrapolationMinutes(opts: {
  productIso: string | null | undefined;
  nowMs?: number;
  capMin?: number;
}): number {
  const cap = opts.capMin ?? LIVE_ADVECT_CAP_MIN;
  return Math.min(
    cap,
    radarProductAgeMinutes(opts.productIso, opts.nowMs ?? Date.now()),
  );
}
