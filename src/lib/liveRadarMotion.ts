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
 * Minuty pro posun / vývoj od času snímku — společná časová osa slideru:
 * - každý krok ±5 min = ±5 min posunu (když liveAge ≥ |offset|)
 * - Teď = liveAge, +5 = liveAge+5, −5 = max(0, liveAge−5)
 */
export function motionMinutesForView(opts: {
  timeOffsetMinutes: number;
  productIso?: string | null | undefined;
  nowMs?: number;
  capMin?: number;
}): number {
  const { timeOffsetMinutes, productIso } = opts;
  const cap = opts.capMin ?? LIVE_ADVECT_CAP_MIN;
  const liveAge = Math.min(
    cap,
    radarProductAgeMinutes(productIso, opts.nowMs ?? Date.now()),
  );
  return Math.max(0, liveAge + timeOffsetMinutes);
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
