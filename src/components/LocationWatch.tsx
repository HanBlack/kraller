import { useI18n } from "../i18n";
import type { ThreatBannerItem } from "../storm/userThreats";
import {
  formatThreatBannerMessage,
  formatThreatExpect,
} from "../storm/userThreats";
import type { UserLocation } from "../types";

type Props = {
  location: UserLocation;
  threats: ThreatBannerItem[];
  onSelectThreat?: (item: ThreatBannerItem) => void;
};

/** Stav sledované lokace — klid vs. blížící se bouřka. */
export function LocationWatch({
  location,
  threats,
  onSelectThreat,
}: Props) {
  const { t, locale } = useI18n();
  const primary = threats[0] ?? null;

  if (!primary) {
    return (
      <section className="panel location-watch calm">
        <p className="location-watch-title">
          {t("watch.title", { place: location.placeName })}
        </p>
        <p className="location-watch-body">{t("watch.calm")}</p>
      </section>
    );
  }

  const expect = formatThreatExpect(primary, locale);

  return (
    <section className={`panel location-watch threat ${primary.alert.severity}`}>
      <p className="location-watch-title">
        {t("watch.threatTitle", { place: location.placeName })}
      </p>
      <p className="location-watch-body">
        {formatThreatBannerMessage(primary, locale)}
      </p>
      {expect && <p className="location-watch-expect">{expect}</p>}
      {onSelectThreat && (
        <button
          type="button"
          className="location-watch-action"
          onClick={() => onSelectThreat(primary)}
        >
          {t("watch.detail")}
        </button>
      )}
    </section>
  );
}
