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
  const dbz =
    alert.maxDbz != null ? ` (~${Math.round(alert.maxDbz)} dBZ)` : "";
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

/** Co čekat: déšť / kroupy / organizace — bez falešné přesnosti. */
export function formatStormAlertDetail(
  alert: StormAlert,
  locale?: Locale,
): string | null {
  const parts: string[] = [];

  if (alert.hailCmMax != null && alert.hailCmMax >= 1 && (alert.maxDbz ?? 0) >= 55) {
    parts.push(t("alert.hailRisk", undefined, locale));
  }

  if (alert.rainMmPerHour) {
    const [lo, hi] = alert.rainMmPerHour;
    parts.push(t("alert.rain", { lo, hi }, locale));
  }

  const tornado = alert.tornadoChancePct;
  if (tornado != null && tornado >= stormConfig.tornadoShowThresholdPct) {
    parts.push(t("alert.organized", undefined, locale));
  }

  if (parts.length === 0 && alert.maxDbz != null) {
    if (alert.maxDbz >= 50) {
      parts.push(t("alert.heavyRain", undefined, locale));
    } else if (alert.maxDbz >= 40) {
      parts.push(t("alert.rainWind", undefined, locale));
    } else {
      parts.push(t("alert.shower", undefined, locale));
    }
  }

  if (parts.length === 0) return null;
  return `${t("alert.expect", undefined, locale)} ${parts.join(" · ")}`;
}
