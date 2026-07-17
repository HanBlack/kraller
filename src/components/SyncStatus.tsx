import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useStormDataContext } from "../providers/StormDataProvider";

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

/** Kompaktní čas poslední synchronizace dat — viditelný i při sbaleném panelu. */
export function SyncStatus() {
  const { t, dateLocale } = useI18n();
  const { lastUpdated, operaTime, loading } = useStormDataContext();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!lastUpdated && !loading) return null;

  const age = lastUpdated ? ageMinutes(lastUpdated, now) : null;
  const radarAge = operaTime ? ageMinutes(operaTime, now) : null;
  const stale = age != null && age >= 10;
  const warn = !stale && age != null && age >= 6;
  const radarStale = radarAge != null && radarAge >= 10;
  const radarWarn = !radarStale && radarAge != null && radarAge >= 6;

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

  const title = lastUpdated
    ? t("sync.titleDetail", { time: formatFull(lastUpdated, dateLocale) })
    : t("sync.updating");

  return (
    <div
      className={`sync-status${
        stale || radarStale ? " is-stale" : warn || radarWarn ? " is-warn" : ""
      }${loading ? " is-loading" : ""}`}
      role="status"
      aria-live="polite"
      title={title}
    >
      <span className="sync-status-main">
        {loading ? (
          <span className="sync-status-dot" aria-hidden />
        ) : null}
        {t("sync.updated", { when })}
      </span>
      {operaTime && (
        <span className="sync-status-radar">
          {t("sync.radar", { time: formatClock(operaTime, dateLocale) })}
          {radarAge != null && radarAge > 0
            ? t("sync.radarAge", { min: radarAge })
            : ""}
        </span>
      )}
      {stale && <span className="sync-status-hint">{t("sync.stale")}</span>}
    </div>
  );
}
