import { t, type Locale } from "../i18n";
import { stormConfig } from "../storm/config";
import type { StormAlert } from "../types";

function strengthLabel(
  severity: StormAlert["severity"],
  locale?: Locale,
): string {
  if (severity === "strong") return t("alert.strongStorm", undefined, locale);
  if (severity === "moderate") return t("alert.storm", undefined, locale);
  return t("alert.weakStorm", undefined, locale);
}

function hitLabel(
  hitType: NonNullable<StormAlert["hitType"]>,
  locale?: Locale,
): string {
  if (hitType === "core") return t("alert.hitCore", undefined, locale);
  if (hitType === "fringe") return t("alert.hitFringe", undefined, locale);
  if (hitType === "edge") return t("alert.hitEdge", undefined, locale);
  return t("alert.hitMiss", undefined, locale);
}

/** Přibližný čas zásahu (lokální hodiny) — zaokrouhlený. */
export function etaClockLabel(etaMinutes: number, now = new Date()): string {
  const rounded = Math.round(etaMinutes / 5) * 5;
  const at = new Date(now.getTime() + rounded * 60_000);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Varování před příchodem bouřky k adrese.
 */
export function formatStormAlert(
  alert: StormAlert,
  locale?: Locale,
): string {
  const strength = strengthLabel(alert.severity, locale);
  const showDbz = alert.atUserDbz ?? alert.maxDbz;
  const dbz =
    showDbz != null ? ` (~${Math.round(showDbz)} dBZ)` : "";
  const clock = etaClockLabel(alert.etaMinutes);
  return t(
    "alert.approaching",
    {
      strength,
      dbz,
      place: alert.toPlace,
      eta: alert.etaMinutes,
      clock,
    },
    locale,
  );
}

/** Co čekat: zásah jádra/okraje · déšť / kroupy — před příchodem. */
export function formatStormAlertDetail(
  alert: StormAlert,
  locale?: Locale,
): string | null {
  const parts: string[] = [];

  if (alert.hitType) {
    parts.push(hitLabel(alert.hitType, locale));
  }

  if (alert.hailCmMax != null && alert.hailCmMax >= 1 && (alert.maxDbz ?? 0) >= 55) {
    if (alert.hitType === "core" || alert.hitType === "fringe") {
      parts.push(t("alert.hailRisk", undefined, locale));
    }
  }

  if (alert.rainMmPerHour) {
    const [lo, hi] = alert.rainMmPerHour;
    parts.push(t("alert.rain", { lo, hi }, locale));
  }

  const tornado = alert.tornadoChancePct;
  if (tornado != null && tornado >= stormConfig.tornadoShowThresholdPct) {
    parts.push(t("alert.organized", undefined, locale));
  }

  if (parts.length <= (alert.hitType ? 1 : 0) && alert.maxDbz != null) {
    const z = alert.atUserDbz ?? alert.maxDbz;
    if (z >= 50) {
      parts.push(t("alert.heavyRain", undefined, locale));
    } else if (z >= 40) {
      parts.push(t("alert.rainWind", undefined, locale));
    } else {
      parts.push(t("alert.shower", undefined, locale));
    }
  }

  if (parts.length === 0) return null;
  return `${t("alert.expect", undefined, locale)} ${parts.join(" · ")}`;
}
