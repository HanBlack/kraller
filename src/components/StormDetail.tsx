import { useEffect, useState } from "react";

import { BirthTimeline } from "./BirthTimeline";

import {
  formatStormAlert,
  formatStormAlertDetail,
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

  formatFormationMessage,

} from "../storm/buildAlert";

import { estimateHailCm, showSupercellEnvBadge } from "../storm/scoreActive";

import type { ActiveStormAssessment } from "../storm/types";

import type { ScoredFormationPoint } from "../storm/formationData";

import { formationCoolingSignal, formationEnvironmentSummary } from "../storm/formationCopy";

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

import { nearestFormationPoint } from "../storm/birthEnv";
import { explainSatelliteStatus } from "../storm/satelliteCooling";
import {
  formatCloudHeightKm,
  resolveCloudHeight,
  type CloudHeightReading,
} from "../storm/stormCloudHeight";
import {
  buildStormStrengthFacts,
  type StormStrengthFacts,
} from "../storm/stormStrengthFacts";
import {
  formatStormWindDetail,
  stormWindAtCell,
} from "../storm/stormWindAtCell";



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
  dualpolHailLikely,
  dualpolLabel,
  maxDbz,
  echoTopKm,
  freezingLevelM,
  shearMs,
}: {
  assessment: ActiveStormAssessment | null | undefined;
  dualpolHailLikely?: boolean;
  dualpolLabel?: string;
  maxDbz?: number | null;
  echoTopKm?: number | null;
  freezingLevelM?: number | null;
  shearMs?: number | null;
}) {
  const { t } = useI18n();

  const dbz = maxDbz ?? assessment?.maxDbz ?? null;
  const hailCm =
    assessment?.hailCmMax ??
    (dbz != null && echoTopKm != null
      ? estimateHailCm(echoTopKm, dbz, freezingLevelM)
      : null);
  const hailFromScore =
    hailCm != null && hailCm >= 1 && dbz != null && dbz >= 55;
  const hail = hailFromScore || Boolean(dualpolHailLikely);
  const updraft = dualpolLabel === "strong_updraft";
  const supercell = assessment ? showSupercellEnvBadge(assessment) : false;
  const gustRisk =
    !hail &&
    dbz != null &&
    dbz >= 55 &&
    ((shearMs != null && shearMs >= 12) || dbz >= 58);

  if (!hail && !supercell && !updraft && !gustRisk) return null;

  return (
    <div className="hazard-badges" role="group" aria-label={t("alert.expect")}>
      {hail ? (
        <span className="hazard-badge hail">
          {hailFromScore && hailCm != null
            ? t("alert.hailRiskCm", { cm: hailCm })
            : t("alert.hailRisk")}
        </span>
      ) : null}
      {gustRisk ? (
        <span className="hazard-badge supercell">{t("alert.gustRisk")}</span>
      ) : null}
      {updraft && !hail ? (
        <span className="hazard-badge supercell">
          {t("alert.strongUpdraft")}
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

function CloudHeightBlock({ height }: { height: CloudHeightReading | null }) {
  const { t } = useI18n();
  if (!height) return null;
  const source =
    height.source === "satellite"
      ? t("storm.cloudTopSourceSat")
      : t("storm.cloudTopSourceRadar");
  return (
    <div className="storm-cloud-height">
      <p className="storm-cloud-height-label">{t("storm.cloudTopTitle")}</p>
      <p className="storm-cloud-height-value">
        {formatCloudHeightKm(height.km)}
        <span className="storm-cloud-height-source">{source}</span>
      </p>
    </div>
  );
}

function dualpolLine(
  facts: StormStrengthFacts,
  t: (key: string) => string,
): string | null {
  if (facts.dualpolHailLikely || facts.dualpolLabel === "possible_hail") {
    return t("storm.strengthDualpolHail");
  }
  if (facts.dualpolLabel === "strong_updraft") {
    return t("storm.strengthDualpolUpdraft");
  }
  // U silné/střední buňky neříkat „slabé/mělké“ — rozpor s peak dBZ / barvou radaru.
  if (
    facts.dualpolLabel === "weakening_or_shallow" &&
    facts.severity !== "strong" &&
    facts.severity !== "moderate"
  ) {
    return t("storm.strengthDualpolWeak");
  }
  return null;
}

function StormStrengthPanel({ facts }: { facts: StormStrengthFacts }) {
  const { t, locale } = useI18n();
  const lines: string[] = [];

  if (facts.severity != null && facts.maxDbz != null) {
    lines.push(formatCoreStrengthLabel(facts.maxDbz, facts.severity, locale));
  }
  if (facts.lightningActivity) {
    const la = facts.lightningActivity;
    if (la.level === "none") {
      lines.push(t("storm.strengthLightningNone"));
    } else if (la.level === "occasional") {
      lines.push(
        t("storm.strengthLightningOccasional", { rate: la.ratePerMin }),
      );
    } else if (la.level === "frequent") {
      lines.push(
        t("storm.strengthLightningFrequent", { rate: la.ratePerMin }),
      );
    } else {
      lines.push(
        t("storm.strengthLightningVeryFrequent", { rate: la.ratePerMin }),
      );
    }
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
  if (facts.cloudHeight) {
    lines.push(
      t("storm.strengthHeight", {
        height: formatCloudHeightKm(facts.cloudHeight.km),
      }),
    );
  }
  if (facts.cloudTopTempC != null) {
    lines.push(t("storm.strengthCtt", { temp: facts.cloudTopTempC }));
  }
  if (facts.ageMinutes != null && facts.ageMinutes > 0) {
    lines.push(t("storm.strengthAge", { min: facts.ageMinutes }));
  }
  if (facts.growthDbz != null && facts.growthDbz >= 3) {
    lines.push(t("storm.strengthGrowthUp"));
  } else if (facts.growthDbz != null && facts.growthDbz <= -2) {
    lines.push(t("storm.strengthGrowthDown"));
  }
  const dual = dualpolLine(facts, t);
  if (dual) lines.push(dual);

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
  const { operaTime, chmiTime, windLow, windUpper, satelliteCooling } =
    useStormDataContext();
  const motionMinutes = motionMinutesForView({
    timeOffsetMinutes: forecastMinutes,
    productIso: operaTime ?? chmiTime,
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



  const factors = (feature.birthEnv?.whyFactors ?? []).filter(
    (f) => f.key !== "cooling" && f.key !== "other",
  );

  const cellKey = feature.id;

  const toYou =

    location && feature.assessment

      ? alertFromActive(feature.assessment, location.placeName)

      : null;

  const toYouDetail = toYou ? formatStormAlertDetail(toYou, locale) : null;

  const windAt =
    feature.windAtCell ??
    stormWindAtCell(
      feature.peak,
      feature.speedKmh,
      windLow,
      windUpper,
      nearestFormationPoint(feature.peak[1], feature.peak[0], formationPoints ?? [])
        ?.environment ?? null,
    );
  const windLines = formatStormWindDetail(windAt, locale);
  const satStatus = explainSatelliteStatus(
    satelliteCooling,
    feature.peak[1],
    feature.peak[0],
  );
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

        {windLines.length > 0 && (
          <div className="storm-wind-at-cell">
            <p className="storm-wind-title">{t("storm.windNearTitle")}</p>
            <ul className="storm-wind-list">
              {windLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        <div
          className={`storm-wind-at-cell storm-sat-at-cell${
            satelliteCooling?.status === "ok" ? " is-sat-live" : ""
          }`}
        >
          <p className="storm-wind-title">{satStatus.title}</p>
          <p className="lifecycle-step-body">{satStatus.detail}</p>
        </div>

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

      <HazardBadges
        assessment={feature.assessment}
        dualpolHailLikely={feature.dualpolHailLikely}
        dualpolLabel={feature.dualpolLabel}
        maxDbz={feature.maxDbz}
        echoTopKm={feature.echoTopKm}
        freezingLevelM={feature.birthEnv?.environment?.freezingLevelM}
        shearMs={
          feature.birthEnv?.shearMs ??
          feature.birthEnv?.environment?.shear0to6Ms ??
          null
        }
      />

      <StormStrengthPanel facts={strengthFacts} />

      {windLines.length > 0 && (
        <div className="storm-wind-at-cell">
          <p className="storm-wind-title">{t("storm.windNearTitle")}</p>
          <ul className="storm-wind-list">
            {windLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        className={`storm-wind-at-cell storm-sat-at-cell${
          satelliteCooling?.status === "ok" ? " is-sat-live" : ""
        }`}
      >
        <p className="storm-wind-title">{satStatus.title}</p>
        <p className="lifecycle-step-body">{satStatus.detail}</p>
      </div>

      {toYou && feature.threatens === 1 && (

        <div className={`to-you-card ${toYou.severity}`}>

          <p className="to-you-title">

            {t("storm.toYou", { place: location?.placeName ?? "" })}

          </p>

          <p className="to-you-hero">{formatStormAlertHero(toYou, locale)}</p>

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
        intensifyEtaMin={life.intensifyEtaMin}
        demiseEtaMin={life.demiseEtaMin}
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
    const cooling = formationCoolingSignal(feature.zone.environment, locale);
    const cloudHeight = resolveCloudHeight({
      cloudTopHeightM: feature.zone.environment?.cloudTopHeightM,
    });

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

        <p className="alert-message">
          {formatFormationMessage(
            feature.assessment,
            feature.zone,
            forecast,
            location?.placeName,
            locale,
          )}
        </p>

        <CloudHeightBlock height={cloudHeight} />

        <div
          className={`formation-signal${
            cooling.kind === "satellite" ? " is-sat" : ""
          }${cooling.growing ? " is-growing" : ""}`}
        >
          <span className="formation-signal-label">{cooling.label}</span>
          <p className="formation-signal-text">{cooling.text}</p>
        </div>

        <ul className="formation-forecast-list">
          <li>
            <strong>{t("formation.detailWhen")}</strong>{" "}
            {t("formation.initWindow", {
              when: formatInitiationWindow(forecast),
            })}
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

