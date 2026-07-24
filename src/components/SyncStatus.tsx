import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { DataSourceStatus } from "../lib/loadStormData";
import { useStormDataContext } from "../providers/StormDataProvider";

/** Prahy pro UI — formation ~6–15 min, wind ~6–10, sat ~20–25. */
const ENV_WARN_MIN = 18;
const ENV_STALE_MIN = 28;
const SAT_WARN_MIN = 30;
const SAT_STALE_MIN = 50;

function ageMinutes(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000));
}

function formatClock(iso: string, dateLocale: string): string {
  try {
    return new Intl.DateTimeFormat(dateLocale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const ATTR_LABEL: Record<string, string> = {
  chmi: "ČHMÚ",
  dwd: "DWD",
  shmu: "SHMÚ",
  imgw: "IMGW",
  mch: "MeteoSwiss",
  opera: "OPERA",
};

function formatAttribution(ids: string[]): string {
  return ids.map((id) => ATTR_LABEL[id] ?? id.toUpperCase()).join("+");
}

function formatFull(iso: string, dateLocale: string): string {
  try {
    return new Intl.DateTimeFormat(dateLocale, {
      hour: "2-digit",
      minute: "2-digit",
      day: "numeric",
      month: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function sourceAge(
  sources: { wind?: DataSourceStatus; formation?: DataSourceStatus } | null,
  key: "wind" | "formation",
  nowMs: number,
): number | null {
  const iso = sources?.[key]?.updatedAt ?? undefined;
  if (!iso) return null;
  return ageMinutes(iso, nowMs);
}

/** Kompaktní čas poslední synchronizace dat — viditelný i při sbaleném panelu. */
export function SyncStatus() {
  const { t, dateLocale } = useI18n();
  const {
    lastUpdated,
    operaTime,
    chmiTime,
    radarTime,
    radarAttribution,
    dataSources,
    loading,
    satelliteCooling,
  } = useStormDataContext();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!lastUpdated && !loading) return null;

  const age = lastUpdated ? ageMinutes(lastUpdated, now) : null;
  const radarIso = radarTime ?? operaTime ?? chmiTime;
  const radarAge = radarIso ? ageMinutes(radarIso, now) : null;
  const windAge = sourceAge(dataSources, "wind", now);
  const formAge = sourceAge(dataSources, "formation", now);
  const satIso = satelliteCooling?.validAt ?? null;
  const satAge = satIso ? ageMinutes(satIso, now) : null;
  const satOk = satelliteCooling?.status === "ok";
  const satSource =
    satOk && (satelliteCooling?.points?.length ?? 0) > 0
      ? "satellite"
      : "model";

  const stale = age != null && age >= 10;
  const warn = !stale && age != null && age >= 6;
  const radarStale = radarAge != null && radarAge >= 10;
  const radarWarn = !radarStale && radarAge != null && radarAge >= 6;
  const envStale =
    (windAge != null && windAge >= ENV_STALE_MIN) ||
    (formAge != null && formAge >= ENV_STALE_MIN) ||
    (satAge != null && satAge >= SAT_STALE_MIN);
  const envWarn =
    !envStale &&
    ((windAge != null && windAge >= ENV_WARN_MIN) ||
      (formAge != null && formAge >= ENV_WARN_MIN) ||
      (satAge != null && satAge >= SAT_WARN_MIN));

  const when =
    loading && !lastUpdated
      ? t("sync.updating")
      : loading
        ? t("sync.refreshing")
        : age == null
          ? t("sync.updating")
          : age <= 1
            ? t("sync.justNow")
            : t("sync.agoMin", { min: age });

  const titleParts = [
    lastUpdated
      ? t("sync.titleDetail", { time: formatFull(lastUpdated, dateLocale) })
      : t("sync.updating"),
  ];
  if (windAge != null) titleParts.push(t("sync.windAgeTitle", { min: windAge }));
  if (formAge != null) titleParts.push(t("sync.formAgeTitle", { min: formAge }));
  if (satAge != null) {
    titleParts.push(
      satSource === "satellite"
        ? t("sync.satAgeTitle", { min: satAge })
        : t("sync.satModelTitle"),
    );
  }

  return (
    <div
      className={`sync-status${
        stale || radarStale || envStale
          ? " is-stale"
          : warn || radarWarn || envWarn
            ? " is-warn"
            : ""
      }${loading ? " is-loading" : ""}`}
      role="status"
      aria-live="polite"
      title={titleParts.join(" · ")}
    >
      <span className="sync-status-main">
        {loading ? <span className="sync-status-dot" aria-hidden /> : null}
        {t("sync.updated", { when })}
      </span>
      {radarIso && (
        <span className="sync-status-radar">
          {t("sync.radar", { time: formatClock(radarIso, dateLocale) })}
          {radarAge != null && radarAge > 0
            ? t("sync.radarAge", { min: radarAge })
            : ""}
        </span>
      )}
      {radarAttribution.length > 0 && (
        <span className="sync-status-attr" title={radarAttribution.join(", ")}>
          {t("sync.radarSources", {
            sources: formatAttribution(radarAttribution),
          })}
        </span>
      )}
      {(windAge != null || formAge != null || satAge != null) && (
        <span
          className={`sync-status-env${envStale ? " is-stale" : envWarn ? " is-warn" : ""}`}
        >
          {formAge != null && t("sync.formationAge", { min: formAge })}
          {formAge != null && (windAge != null || satAge != null) ? " · " : ""}
          {windAge != null && t("sync.windAge", { min: windAge })}
          {(formAge != null || windAge != null) && satAge != null ? " · " : ""}
          {satAge != null &&
            (satSource === "satellite"
              ? t("sync.satAge", { min: satAge })
              : t("sync.satModel"))}
        </span>
      )}
      {(stale || radarStale || envStale) && (
        <span className="sync-status-hint">
          {radarStale && !stale && !envStale
            ? t("sync.radarStale")
            : envStale && !stale
              ? t("sync.envStale")
              : t("sync.stale")}
        </span>
      )}
    </div>
  );
}
