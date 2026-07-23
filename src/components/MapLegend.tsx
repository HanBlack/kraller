import { useI18n } from "../i18n";
import type { WindLayerMode } from "../lib/windField";

type Props = {
  showFormation: boolean;
  showProgress: boolean;
  showRadar: boolean;
  windMode: WindLayerMode;
  hasLocation?: boolean;
  windReal?: boolean;
  formationReal?: boolean;
  formationCount?: number;
};

export function MapLegend({
  showFormation,
  showProgress,
  showRadar,
  windMode,
  hasLocation = false,
  windReal = false,
  formationReal = false,
  formationCount = 0,
}: Props) {
  const { t } = useI18n();

  if (
    !showFormation &&
    !showProgress &&
    !showRadar &&
    windMode === "off" &&
    !hasLocation
  )
    return null;

  const windTitle =
    windMode === "low"
      ? t("legend.windTitleLow")
      : windMode === "upper"
        ? t("legend.windTitleUpper")
        : t("legend.windTitleSteer");

  return (
    <div className="map-legend">
      {hasLocation && (
        <div className="legend-block">
          <p className="legend-title">{t("legend.location")}</p>
          <ul className="legend-list">
            <li>
              <span className="swatch user-pin-swatch" /> {t("legend.locationItem")}
            </li>
          </ul>
        </div>
      )}
      {showRadar && (
        <div className="legend-block">
          <p className="legend-title">{t("legend.radarTitle")}</p>
          <ul className="legend-list">
            <li>
              <span className="swatch-dbz light" /> {t("legend.light")}
            </li>
            <li>
              <span className="swatch-dbz rain" /> {t("legend.rain")}
            </li>
            <li>
              <span className="swatch-dbz heavy" /> {t("legend.heavy")}
            </li>
            <li>
              <span className="swatch-dbz core" /> {t("legend.core")}
            </li>
            <li>
              <span className="swatch-dbz extreme" /> {t("legend.extreme")}
            </li>
          </ul>
          <p className="legend-note">{t("legend.radarGuide")}</p>
          <p className="legend-note">{t("legend.radarNote")}</p>
        </div>
      )}
      {showProgress && (
        <div className="legend-block">
          <p className="legend-title">{t("legend.trackTitle")}</p>
          <ul className="legend-list">
            <li>
              <span className="legend-arrow" aria-hidden>
                ▲
              </span>
              {t("legend.moveArrow")}
            </li>
            <li>
              <span className="swatch threat" /> {t("legend.threatens")}
            </li>
            <li>
              <span className="swatch birth" /> {t("legend.birth")}
            </li>
            <li>
              <span className="swatch intens" /> {t("legend.intensify")}
            </li>
          </ul>
        </div>
      )}
      {windMode !== "off" && (
        <div className="legend-block">
          <p className="legend-title">{windTitle}</p>
          <ul className="legend-list">
            <li>
              <span
                className={`legend-flow ${windMode === "low" ? "low" : "upper"}`}
                aria-hidden
              />
              {t("legend.windFlow")}
            </li>
          </ul>
          {windReal && <p className="legend-note">{t("legend.windNote")}</p>}
        </div>
      )}
      {showFormation && (
        <div className="legend-block">
          <p className="legend-title">{t("legend.formTitle")}</p>
          <ul className="legend-list">
            <li>
              <span className="swatch form-grid" /> {t("legend.formGrid")}
            </li>
            <li>
              <span className="swatch form-moderate" /> {t("legend.formHeat")}
            </li>
            <li>
              <span className="swatch form-moderate" /> {t("legend.formZone")}
            </li>
            <li>
              <span className="swatch form-link" /> {t("legend.formLink")}
            </li>
            <li>
              <span className="swatch form-sat" /> {t("legend.formSatCooling")}
            </li>
          </ul>
          {formationReal ? (
            <p className="legend-note">
              {formationCount > 0
                ? t("legend.formAreas", { count: formationCount })
                : t("legend.formNoRisk")}
            </p>
          ) : (
            <p className="legend-note">{t("legend.formNotLoaded")}</p>
          )}
        </div>
      )}
    </div>
  );
}
