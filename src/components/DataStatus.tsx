import { useEffect, useState } from "react";

import { useI18n } from "../i18n";

import type { DataSourceStatus } from "../lib/loadStormData";



type Props = {

  lastUpdated: string | null;

  operaTime?: string | null;

  loading: boolean;

  sources?: {

    opera?: DataSourceStatus | null;

    wind?: DataSourceStatus | null;

    formation?: DataSourceStatus | null;

  } | null;

  windReal?: boolean;

  formationReal?: boolean;

};



function formatTime(iso: string, dateLocale: string): string {

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



function ageMinutes(iso: string, nowMs: number): number {

  return Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000));

}



function freshnessClass(ageMin: number): "ok" | "warn" | "stale" {

  if (ageMin >= 20) return "stale";

  if (ageMin >= 10) return "warn";

  return "ok";

}



function sourceChip(

  label: string,

  status: DataSourceStatus | null | undefined,

  fileOk: boolean,

  nowMs: number,

  t: (key: string, params?: Record<string, string | number>) => string,

): { text: string; tone: "ok" | "warn" | "bad" } {

  if (status?.ok === false) {

    const age =

      status.updatedAt != null ? ageMinutes(status.updatedAt, nowMs) : null;

    return {

      text:

        age != null

          ? t("data.staleSource", { label, min: age })

          : t("data.failed", { label }),

      tone: "bad",

    };

  }

  if (!fileOk && status?.ok !== true) {

    return { text: t("data.missingSource", { label }), tone: "bad" };

  }

  if (status?.updatedAt) {

    const age = ageMinutes(status.updatedAt, nowMs);

    if (age >= 20) return { text: t("data.ageSource", { label, min: age }), tone: "warn" };

    return { text: t("data.ok", { label }), tone: "ok" };

  }

  return { text: t("data.ok", { label }), tone: fileOk ? "ok" : "bad" };

}



export function DataStatus({

  lastUpdated,

  operaTime,

  loading,

  sources,

  windReal = false,

  formationReal = false,

}: Props) {

  const { t, dateLocale } = useI18n();

  const [now, setNow] = useState(() => Date.now());



  useEffect(() => {

    const id = window.setInterval(() => setNow(Date.now()), 30_000);

    return () => window.clearInterval(id);

  }, []);



  if (loading && !lastUpdated) {

    return (

      <p className="data-status" aria-live="polite">

        {t("data.loading")}

      </p>

    );

  }



  if (!lastUpdated) {

    return (

      <p className="data-status stale" aria-live="polite">

        {t("data.missing", { cmd: t("data.cmd") })}

      </p>

    );

  }



  const age = ageMinutes(lastUpdated, now);

  const freshest = operaTime ?? lastUpdated;

  const radarAge = ageMinutes(freshest, now);

  let level = freshnessClass(Math.min(age, radarAge));



  const chips = [

    sourceChip(t("data.radar"), sources?.opera, true, now, t),

    sourceChip(t("data.wind"), sources?.wind, windReal, now, t),

    sourceChip(t("data.formation"), sources?.formation, formationReal, now, t),

  ];

  if (chips.some((c) => c.tone === "bad")) {

    level = level === "ok" ? "warn" : level;

  }



  return (

    <div className={`data-status ${level}`} aria-live="polite">

      <p>

        {t("data.dataAt")}{" "}

        <time dateTime={lastUpdated}>{formatTime(lastUpdated, dateLocale)}</time>

        {loading

          ? t("data.refreshing")

          : age <= 1

            ? t("data.justNow")

            : t("data.agoMin", { min: age })}

      </p>

      <p className="data-status-sources">

        {chips.map((c) => (

          <span key={c.text} className={`data-chip ${c.tone}`}>

            {c.text}

          </span>

        ))}

      </p>

      {operaTime && (

        <p className="data-status-sub">

          {t("data.operaFrame")}{" "}

          <time dateTime={operaTime}>{formatTime(operaTime, dateLocale)}</time>

          {radarAge > 0 ? t("data.frameAge", { min: radarAge }) : ""}

        </p>

      )}

      {level === "stale" && (
        <p className="data-status-alert">
          {t("data.stale", { cmd: t("data.cmd") })}
        </p>
      )}

      {level === "warn" && (
        <p className="data-status-alert">
          {t("data.warn", { cmd: t("data.cmd") })}
        </p>
      )}

      {(level === "warn" || level === "stale") && (
        <p className="data-status-sub">{t("data.staleHint")}</p>
      )}

    </div>

  );

}

