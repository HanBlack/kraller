import { t, type Locale } from "../i18n";
import { severityLabel, type Severity } from "./severity";
import { estimateRainMmH } from "../storm/hitAtUser";
import type { HitType } from "../storm/hitAtUser";

/** Lidská síla + mm/h pro mapové jádro (ne jen dBZ barva). */
export function formatCoreStrengthLabel(
  maxDbz: number,
  severity: Severity,
  locale?: Locale,
): string {
  const sev = severityLabel(severity, locale);
  const rain = estimateRainMmH(maxDbz);
  if (rain) {
    return `${sev} · ${t("alert.rainShort", { lo: rain[0], hi: rain[1] }, locale)}`;
  }
  if (maxDbz >= 30) {
    return `${sev} · ~${Math.round(maxDbz)} dBZ`;
  }
  return sev;
}

function hitLabel(hitType: HitType, locale?: Locale): string {
  if (hitType === "core") return t("alert.hitCore", undefined, locale);
  if (hitType === "fringe") return t("alert.hitFringe", undefined, locale);
  if (hitType === "edge") return t("alert.hitEdge", undefined, locale);
  return t("alert.hitMiss", undefined, locale);
}

/**
 * Řádek síly u sledované adresy: síla · jádro/okraj · mm/h.
 */
export function formatWatchStrengthLine(opts: {
  severity: Severity;
  hitType?: HitType | null;
  atUserDbz?: number | null;
  maxDbz?: number | null;
  rainMmPerHour?: [number, number] | null;
  locale?: Locale;
}): string {
  const parts: string[] = [
    opts.severity === "strong"
      ? t("alert.strongStorm", undefined, opts.locale)
      : opts.severity === "moderate"
        ? t("alert.storm", undefined, opts.locale)
        : t("alert.weakStorm", undefined, opts.locale),
  ];
  if (opts.hitType) {
    parts.push(hitLabel(opts.hitType, opts.locale));
  }
  const rain =
    opts.rainMmPerHour ??
    (opts.atUserDbz != null
      ? estimateRainMmH(opts.atUserDbz)
      : opts.maxDbz != null
        ? estimateRainMmH(opts.maxDbz)
        : null);
  if (rain) {
    parts.push(t("alert.rainShort", { lo: rain[0], hi: rain[1] }, opts.locale));
  } else {
    const z = opts.atUserDbz ?? opts.maxDbz;
    if (z != null) parts.push(`~${Math.round(z)} dBZ`);
  }
  return parts.join(" · ");
}
