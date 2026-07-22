/**
 * Timeline mapy:
 * - minulost / Teď: motion = 0 → PNG a peaky přesně z dat (archiv / latest)
 * - kladný offset: jen scrub stopy / ETA (ne predikce vzhledu radaru)
 * Věk snímku (liveAge) sem nepatří — jen do UI přes liveExtrapolationMinutes.
 */
export function motionMinutesForView(opts: {
  timeOffsetMinutes: number;
  productIso?: string | null | undefined;
  nowMs?: number;
  capMin?: number;
}): number {
  void opts.productIso;
  void opts.nowMs;
  void opts.capMin;
  return Math.max(0, opts.timeOffsetMinutes);
}

/** Max. minut živé advekce — legacy; UI věk snímku. */
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

/** Věk snímku — jen pro UI („data stará o X min“), ne pro posun PNG. */
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
