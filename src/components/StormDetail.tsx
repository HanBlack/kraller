import { useEffect, useState } from "react";

import { BirthTimeline } from "./BirthTimeline";

import {

  formatStormAlert,

  formatStormAlertDetail,

} from "../lib/formatAlert";

import { headingLabel } from "../lib/direction";

import { formationSeverityLabel, severityLabel } from "../lib/severity";

import { useI18n } from "../i18n";

import {

  alertFromActive,

  formatFormationMessage,

  formatFormationSummary,

} from "../storm/buildAlert";

import { showSupercellEnvBadge } from "../storm/scoreActive";

import type { ActiveStormAssessment } from "../storm/types";

import type { ScoredFormationPoint } from "../storm/formationData";

import { formationEnvironmentSummary } from "../storm/formationCopy";

import {

  formatInitiationWindow,

  stormTypeLabel,

} from "../storm/formationForecast";

import {

  buildStormLifecycle,

  type LifecycleStepId,

} from "../storm/lifecycle";

import type { ActiveFeature, FormationFeature } from "../storm/mapFeatures";

import type { RadarProgressFeature } from "../storm/radarCells";

import type { UserLocation } from "../types";



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
}: {
  severity: "weak" | "moderate" | "strong";
  formation?: boolean;
}) {
  const { locale } = useI18n();
  const label = formation
    ? formationSeverityLabel(severity, locale)
    : severityLabel(severity, locale);
  return <span className={`severity-badge ${severity}`}>{label}</span>;
}

/** Upřímné riziko — ne „kroupy padají“ / „vidíme rotaci“. */
function HazardBadges({
  assessment,
}: {
  assessment: ActiveStormAssessment | null | undefined;
}) {
  const { t } = useI18n();
  if (!assessment) return null;

  const hail =
    assessment.hailCmMax != null &&
    assessment.hailCmMax >= 1 &&
    assessment.maxDbz >= 55;
  const supercell = showSupercellEnvBadge(assessment);
  if (!hail && !supercell) return null;

  return (
    <div className="hazard-badges" role="group" aria-label={t("alert.expect")}>
      {hail ? (
        <span className="hazard-badge hail">
          {t("alert.hailRiskCm", { cm: assessment.hailCmMax! })}
        </span>
      ) : null}
      {supercell ? (
        <span className="hazard-badge supercell">
          {t("alert.supercellEnv")}
        </span>
      ) : null}
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

  let life;

  try {

    life = buildStormLifecycle(

      feature,

      feature.intensification,

      formationPoints,

    );

  } catch {

    life = null;

  }



  const factors = feature.birthEnv?.whyFactors ?? [];

  const cellKey = feature.id;

  const toYou =

    location && feature.assessment

      ? alertFromActive(feature.assessment, location.placeName)

      : null;

  const toYouDetail = toYou ? formatStormAlertDetail(toYou, locale) : null;



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

      <HazardBadges assessment={feature.assessment} />

      {toYou && feature.threatens === 1 && (

        <div className={`to-you-card ${toYou.severity}`}>

          <p className="to-you-title">

            {t("storm.toYou", { place: location?.placeName ?? "" })}

          </p>

          <p className="to-you-body">{formatStormAlert(toYou, locale)}</p>

          {toYouDetail && <p className="to-you-expect">{toYouDetail}</p>}

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
                          step.badge === "z radaru"
                            ? "observed"
                            : step.badge === "trend"
                              ? "trending"
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

                      <div className="lifecycle-why">

                        <p className="lifecycle-why-title">

                          {feature.phase === "growing"

                            ? t("storm.whyGrowing")

                            : t("storm.whyNow")}

                        </p>

                        <ul className="lifecycle-why-list">

                          {step.reasons.map((r) => (

                            <li key={r}>{r}</li>

                          ))}

                        </ul>

                      </div>

                    )}



                  {step.id === "path" &&

                    step.reasons &&

                    step.reasons.length > 0 && (

                      <div className="lifecycle-why">

                        <p className="lifecycle-why-title">{t("storm.whyStrength")}</p>

                        <ul className="lifecycle-why-list">

                          {step.reasons.map((r) => (

                            <li key={r}>{r}</li>

                          ))}

                        </ul>

                      </div>

                    )}



                  {step.id === "factors" && factors.length > 0 && (

                    <ul className="birth-factor-list compact">

                      {factors.map((f) => (

                        <li

                          key={`${f.key}-${f.label}`}

                          className={`birth-factor birth-factor-${f.key}`}

                        >

                          <span className="birth-factor-label">{f.label}</span>

                          <span className="birth-factor-detail">{f.detail}</span>

                        </li>

                      ))}

                    </ul>

                  )}



                  {step.id !== "factors" &&

                    step.id !== "birth" &&

                    step.id !== "path" &&

                    step.reasons &&

                    step.reasons.length > 0 && (

                      <div className="lifecycle-why">

                        <p className="lifecycle-why-title">{t("storm.whyHappens")}</p>

                        <ul className="lifecycle-why-list">

                          {step.reasons.map((r) => (

                            <li key={r}>{r}</li>

                          ))}

                        </ul>

                      </div>

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

    return (

      <section className="panel storm-detail">

        <div className="storm-detail-head">

          <h2>

            {t("formation.panelTitle", { place: zonePlace })}{" "}

            <SeverityBadge severity={feature.assessment.severity} formation />

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

        <p className="storm-meta">{formatFormationSummary(forecast, locale)}</p>

        <p className="alert-message">

          {formatFormationMessage(

            feature.assessment,

            feature.zone,

            forecast,

            location?.placeName,

            locale,

          )}

        </p>

        <ul className="formation-forecast-list">

          <li>

            <strong>{t("formation.detailWhen")}</strong>{" "}

            {t("formation.initWindow", {

              when: formatInitiationWindow(forecast),

            })}

          </li>

          <li>

            <strong>{t("formation.detailStrength")}</strong>{" "}

            {stormTypeLabel(forecast.stormType, locale)} (~{forecast.expectedMaxDbz}{" "}

            dBZ)

          </li>

          <li>

            <strong>{t("formation.detailWhere")}</strong>{" "}

            {t("formation.afterBirthDir", {

              dir: headingLabel(forecast.headingDeg, locale),

            })}{" "}

            · ~{forecast.speedKmh} km/h

          </li>

          {forecast.threatensUser && forecast.arrivalEtaMin != null && location && (

            <li className="formation-threat-line">

              <strong>{t("formation.detailToYou")}</strong>{" "}

              {t("formation.arrivalEta", { eta: forecast.arrivalEtaMin })}

            </li>

          )}

        </ul>

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

  const alertDetail = alert ? formatStormAlertDetail(alert, locale) : null;



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

      <HazardBadges assessment={feature.assessment} />

      {alertDetail ? (
        <p className="to-you-expect">{alertDetail}</p>
      ) : null}

    </section>

  );

}

