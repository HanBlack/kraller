import { useEffect, useState } from "react";

import { BirthTimeline } from "./BirthTimeline";

import {
  formatStormAlert,
  formatStormAlertHero,
} from "../lib/formatAlert";

import { headingLabel } from "../lib/direction";

import { formationSeverityLabel, severityLabel } from "../lib/severity";
import { formatCoreStrengthLabel } from "../lib/stormStrength";

import { useI18n } from "../i18n";
import { motionMinutesForView } from "../lib/liveRadarMotion";
import { useStormDataContext } from "../providers/StormDataProvider";
import { meanForecastDelta } from "../storm/radarCells";

import {

  alertFromActive,

} from "../storm/buildAlert";

import type { ScoredFormationPoint } from "../storm/formationData";

import {
  formatFormationHeadline,
  formationCoolingSignal,
  formationEnvironmentSummary,
} from "../storm/formationCopy";

import {

  formatInitiationWindow,

  formationShowsForecast,

  stormTypeLabel,

} from "../storm/formationForecast";

import {

  buildStormLifecycle,

  type LifecycleStepId,

} from "../storm/lifecycle";

import type { ActiveFeature, FormationFeature } from "../storm/mapFeatures";

import type { RadarProgressFeature } from "../storm/radarCells";

import type { UserLocation } from "../types";

import {
  buildStormStrengthFacts,
  type StormStrengthFacts,
} from "../storm/stormStrengthFacts";



export type SelectedStorm =

  | { kind: "formation"; feature: FormationFeature }

  | { kind: "active"; feature: ActiveFeature }

  | { kind: "radar"; feature: RadarProgressFeature };



type Props = {

  selected: SelectedStorm | null;

  location: UserLocation | null;

  forecastMinutes?: number;

  formationPoints?: ScoredFormationPoint[];

  onClose: () => void;

};



function SeverityBadge({
  severity,
  formation = false,
  score,
}: {
  severity: "weak" | "moderate" | "strong";
  formation?: boolean;
  /** Formation score — pod prahem badge „bez rizika“. */
  score?: number;
}) {
  const { locale } = useI18n();
  const label = formation
    ? formationSeverityLabel(severity, locale, score)
    : severityLabel(severity, locale);
  const tone =
    formation && score != null && !formationShowsForecast(score)
      ? "weak"
      : severity;
  return <span className={`severity-badge ${tone}`}>{label}</span>;
}

function StormStrengthPanel({ facts }: { facts: StormStrengthFacts }) {
  const { t, locale } = useI18n();
  const lines: string[] = [];

  if (facts.severity != null && facts.maxDbz != null) {
    lines.push(formatCoreStrengthLabel(facts.maxDbz, facts.severity, locale));
  }
  if (facts.dbzTrend) {
    const d = facts.dbzTrend.deltaDbz;
    if (d >= 1.5) {
      lines.push(t("storm.strengthTrendUp", { min: facts.dbzTrend.windowMin }));
    } else if (d <= -1.5) {
      lines.push(
        t("storm.strengthTrendDown", { min: facts.dbzTrend.windowMin }),
      );
    } else {
      lines.push(
        t("storm.strengthTrendFlat", { min: facts.dbzTrend.windowMin }),
      );
    }
  }
  if (facts.ageMinutes != null && facts.ageMinutes > 0) {
    lines.push(t("storm.strengthAge", { min: facts.ageMinutes }));
  }
  if (facts.growthDbz != null && facts.growthDbz >= 3) {
    lines.push(t("storm.strengthGrowthUp"));
  } else if (facts.growthDbz != null && facts.growthDbz <= -2) {
    lines.push(t("storm.strengthGrowthDown"));
  }
  if (lines.length === 0) return null;

  return (
    <div className="storm-strength-panel">
      <p className="storm-strength-title">{t("storm.strengthTitle")}</p>
      <ul className="storm-strength-list">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function RadarLifecycleDetail({

  feature,

  formationPoints,

  forecastMinutes,

  location,

  onClose,

}: {

  feature: RadarProgressFeature;

  formationPoints: ScoredFormationPoint[];

  forecastMinutes: number;

  location: UserLocation | null;

  onClose: () => void;

}) {

  const { t, locale } = useI18n();
  const { operaTime, chmiTime, radarTime, satelliteCooling } =
    useStormDataContext();
  const motionMinutes = motionMinutesForView({
    timeOffsetMinutes: forecastMinutes,
    productIso: radarTime ?? operaTime ?? chmiTime,
  });

  let life;

  try {
    life = buildStormLifecycle(
      feature,
      feature.intensification,
      formationPoints,
      {
        forecastMinutes: motionMinutes,
        systemDelta: meanForecastDelta([feature], motionMinutes),
      },
      satelliteCooling,
    );
  } catch {
    life = null;
  }



  const cellKey = feature.id;

  const toYou =

    location && feature.assessment

      ? alertFromActive(feature.assessment, location.placeName)

      : null;

  const strengthFacts = buildStormStrengthFacts({
    maxDbz: feature.maxDbz,
    severity: feature.severity,
    echoTopKm: feature.echoTopKm,
    ageMinutes: feature.ageMinutes,
    growthDbz: feature.growthDbz,
    history: feature.history,
    satAtPeak: feature.satAtPeak,
    satLive: satelliteCooling?.status === "ok",
    dualpolLabel: feature.dualpolLabel,
    dualpolHailLikely: feature.dualpolHailLikely,
    envCloudTopHeightM: feature.birthEnv?.environment?.cloudTopHeightM,
  });



  const [openIds, setOpenIds] = useState<Set<LifecycleStepId>>(() => new Set());

  useEffect(() => {
    setOpenIds(new Set());
  }, [cellKey]);



  const toggle = (id: LifecycleStepId) => {

    setOpenIds((prev) => {

      const next = new Set(prev);

      if (next.has(id)) next.delete(id);

      else next.add(id);

      return next;

    });

  };



  if (!life) {

    return (

      <section className="panel storm-detail">

        <div className="storm-detail-head">

          <h2>{t("storm.cell", { label: feature.placeLabel || feature.id })}</h2>

          <button

            type="button"

            className="close-btn"

            onClick={onClose}

            aria-label={t("close")}

          >

            ×

          </button>

        </div>

        <p className="alert-message">

          {t("storm.dbzDir", {

            dbz: feature.maxDbz.toFixed(0),

            dir: headingLabel(feature.headingDeg, locale),

          })}

        </p>

        <StormStrengthPanel facts={strengthFacts} />

      </section>

    );

  }



  return (

    <section className="panel storm-detail lifecycle-panel">

      <div className="storm-detail-head">

        <h2>

          {life.title} <SeverityBadge severity={feature.severity} />

        </h2>

        <button

          type="button"

          className="close-btn"

          onClick={onClose}

          aria-label={t("close")}

        >

          ×

        </button>

      </div>



      <p className="alert-message">{life.summary}</p>

      <StormStrengthPanel facts={strengthFacts} />

      {toYou && feature.threatens === 1 && (

        <div className={`to-you-card ${toYou.severity}`}>

          <p className="to-you-title">

            {t("storm.toYou", { place: location?.placeName ?? "" })}

          </p>

          <p className="to-you-hero">{formatStormAlertHero(toYou, locale)}</p>

          <p className="to-you-body">{formatStormAlert(toYou, locale)}</p>

        </div>

      )}



      {location && feature.assessment && feature.threatens !== 1 && (

        <p className="alert-note">

          {t("storm.notAiming", { place: location.placeName })}

        </p>

      )}



      <ol className="lifecycle-steps">

        {life.steps.map((step) => {

          const open = openIds.has(step.id);

          return (

            <li

              key={step.id}

              className={`lifecycle-step${step.active ? " active" : ""}${

                step.id === "demise" ? " demise" : ""

              }${step.id === "intensify" && step.active ? " intensify" : ""}`}

            >

              <button

                type="button"

                className="lifecycle-step-toggle"

                aria-expanded={open}

                onClick={() => toggle(step.id)}

              >

                <span className="lifecycle-step-toggle-text">
                  <span className="lifecycle-step-title">
                    {step.title}
                    {step.badge ? (
                      <span
                        className={`lifecycle-badge confidence-${
                          step.id === "demise"
                            ? (life.demiseConfidence ?? "climatology")
                            : "climatology"
                        }`}
                      >
                        {step.badge}
                      </span>
                    ) : null}
                  </span>
                  {!open && (
                    <span className="lifecycle-step-body-preview">
                      {step.body}
                    </span>
                  )}
                </span>

                <span className="lifecycle-step-chevron" aria-hidden>

                  {open ? "▾" : "▸"}

                </span>

              </button>



              {open && (

                <div className="lifecycle-step-panel">

                  <p className="lifecycle-step-body">{step.body}</p>

                  {step.meta && (

                    <p className="lifecycle-step-meta">{step.meta}</p>

                  )}



                  {step.id === "birth" &&
                    step.reasons &&
                    step.reasons.length > 0 && (
                      <ul className="lifecycle-why-list">
                        {step.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}

                  {step.id === "path" &&
                    step.reasons &&
                    step.reasons.length > 0 && (
                      <ul className="lifecycle-why-list">
                        {step.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}

                  {step.id !== "factors" &&
                    step.id !== "birth" &&
                    step.id !== "path" &&
                    step.reasons &&
                    step.reasons.length > 0 && (
                      <ul className="lifecycle-why-list">
                        {step.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}

                </div>

              )}

            </li>

          );

        })}

      </ol>



      <BirthTimeline
        history={feature.history}
        currentDbz={feature.maxDbz}
        ageMinutes={feature.ageMinutes}
        trueBirth={feature.trueBirth}
        intensifyEtaMin={life.intensifyEtaMin}
        demiseEtaMin={life.demiseEtaMin}
        demiseEtaMinLo={life.demiseEtaMinLo}
        demiseEtaMinHi={life.demiseEtaMinHi}
        demiseConfidence={life.demiseConfidence}
        willIntensify={Boolean(
          life.intensifyEtaMin != null && life.intensifyAt,
        )}
      />



      {forecastMinutes > 0 && (

        <p className="alert-note">

          {t("storm.sliderNote", { min: forecastMinutes })}

        </p>

      )}

    </section>

  );

}



export function StormDetail({

  selected,

  location,

  forecastMinutes = 0,

  formationPoints = [],

  onClose,

}: Props) {

  const { t, locale } = useI18n();

  if (!selected) return null;



  const place = location?.placeName ?? t("location.myPlace");



  if (selected.kind === "formation") {
    const { feature } = selected;
    const { forecast } = feature;
    const zonePlace = feature.zone.placeName ?? feature.zone.name;
    const showForecast = formationShowsForecast(feature.assessment.score);
    const cooling = formationCoolingSignal(feature.zone.environment, locale);
    return (
      <section className="panel storm-detail">
        <div className="storm-detail-head">
          <h2>
            {t("formation.panelTitle", { place: zonePlace })}{" "}
            <SeverityBadge
              severity={feature.assessment.severity}
              formation
              score={feature.assessment.score}
            />
          </h2>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            aria-label={t("close")}
          >
            ×
          </button>
        </div>

        <p className="alert-message">
          {formatFormationHeadline(
            feature.assessment,
            zonePlace,
            locale,
            feature.zone.environment,
          )}
        </p>

        <div
          className={`formation-signal${
            cooling.kind === "satellite" ? " is-sat" : ""
          }${cooling.growing ? " is-growing" : ""}`}
        >
          <span className="formation-signal-label">{cooling.label}</span>
          <p className="formation-signal-text">{cooling.text}</p>
        </div>

        {showForecast ? (
          <ul className="formation-forecast-list">
            <li>
              <strong>{t("formation.detailWhen")}</strong>{" "}
              {t(
                cooling.kind === "satellite" && cooling.growing
                  ? "formation.initWindowSat"
                  : "formation.initWindow",
                {
                  when: formatInitiationWindow(forecast),
                },
              )}
            </li>
            <li>
              <strong>{t("formation.detailStrength")}</strong>{" "}
              {stormTypeLabel(forecast.stormType, locale)} (~
              {forecast.expectedMaxDbz} dBZ)
            </li>
            <li>
              <strong>{t("formation.detailWhere")}</strong>{" "}
              {t("formation.afterBirthDir", {
                dir: headingLabel(forecast.headingDeg, locale),
              })}{" "}
              · ~{forecast.speedKmh} km/h
            </li>
            {forecast.threatensUser &&
              forecast.arrivalEtaMin != null &&
              location && (
                <li className="formation-threat-line">
                  <strong>{t("formation.detailToYou")}</strong>{" "}
                  {t("formation.arrivalEta", { eta: forecast.arrivalEtaMin })}
                </li>
              )}
          </ul>
        ) : (
          <p className="storm-meta formation-no-forecast">
            {t("formation.noConcreteEta")}
          </p>
        )}

        <p className="storm-meta">
          {t("formation.detailEnv")}{" "}
          {formationEnvironmentSummary(feature.zone.environment, locale)}
        </p>
        <p className="alert-note">{t("formation.note")}</p>
      </section>
    );
  }



  if (selected.kind === "radar") {

    return (

      <RadarLifecycleDetail

        feature={selected.feature}

        formationPoints={formationPoints}

        forecastMinutes={forecastMinutes}

        location={location}

        onClose={onClose}

      />

    );

  }



  const { feature } = selected;

  const alert = location ? alertFromActive(feature.assessment, place) : null;

  const dir = headingLabel(feature.storm.headingDeg, locale);



  return (

    <section className="panel storm-detail">

      <div className="storm-detail-head">

        <h2>

          {t("storm.arrival", { place: feature.storm.fromPlace })}{" "}

          <SeverityBadge severity={feature.assessment.severity} />

        </h2>

        <button

          type="button"

          className="close-btn"

          onClick={onClose}

          aria-label={t("close")}

        >

          ×

        </button>

      </div>

      <p className="alert-message">

        {alert

          ? formatStormAlert(alert, locale)

          : feature.assessment.etaMinutes != null && location

            ? t("storm.fromEta", {

                from: feature.storm.fromPlace,

                eta: feature.assessment.etaMinutes,

              })

            : location
              ? t("storm.headingNotYou", { dir })
              : t("storm.headingNeedAddress", { dir })}

      </p>

    </section>

  );

}
