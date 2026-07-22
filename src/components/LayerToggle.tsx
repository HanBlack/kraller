import { useI18n } from "../i18n";
import type { WindLayerMode } from "../lib/windField";
import {
  FORECAST_MAX_OFFSET,
  formatRadarTime,
  formatTimeOffsetLabel,
  HISTORY_MIN_OFFSET,
  TIME_STEP_MINUTES,
} from "../lib/radarHistory";

type Props = {
  showFormation: boolean;
  showProgress: boolean;
  showRadar: boolean;
  windMode: WindLayerMode;
  timeOffsetMinutes: number;
  historyRadarTime?: string | null;
  onToggleFormation: () => void;
  onToggleProgress: () => void;
  onToggleRadar: () => void;
  onWindMode: (mode: WindLayerMode) => void;
  onTimeOffsetMinutes: (minutes: number) => void;
};

export function LayerToggle({
  showFormation,
  showProgress,
  showRadar,
  windMode,
  timeOffsetMinutes,
  historyRadarTime,
  onToggleFormation,
  onToggleProgress,
  onToggleRadar,
  onWindMode,
  onTimeOffsetMinutes,
}: Props) {
  const { t, locale } = useI18n();
  const radarStamp =
    timeOffsetMinutes < 0 && historyRadarTime
      ? formatRadarTime(historyRadarTime)
      : null;

  return (
    <div className="layer-toggle-stack">
      <div className="layer-toggle" role="group" aria-label={t("layers.group")}>
        <button
          type="button"
          className={showRadar ? "layer-btn active radar" : "layer-btn"}
          onClick={onToggleRadar}
          aria-pressed={showRadar}
          title={t("layers.radarTitle")}
        >
          {t("layers.radar")}
        </button>
        <button
          type="button"
          className={showFormation ? "layer-btn active formation" : "layer-btn"}
          onClick={onToggleFormation}
          aria-pressed={showFormation}
          title={t("layers.formationTitle")}
        >
          {t("layers.formation")}
        </button>
        <button
          type="button"
          className={showProgress ? "layer-btn active progress" : "layer-btn"}
          onClick={onToggleProgress}
          aria-pressed={showProgress}
          title={t("layers.progressTitle")}
        >
          {t("layers.progress")}
        </button>
      </div>
      <p className="layer-hint">{t("layers.hint")}</p>

      <div className="layer-toggle wind-toggle" role="group" aria-label={t("layers.wind")}>
        <span className="wind-toggle-label">{t("layers.wind")}</span>
        <div className="wind-toggle-scroll">
          <button
            type="button"
            className={windMode === "off" ? "layer-btn active" : "layer-btn"}
            onClick={() => onWindMode("off")}
            aria-pressed={windMode === "off"}
          >
            {t("layers.windOff")}
          </button>
          <button
            type="button"
            className={
              windMode === "steer" ? "layer-btn active wind-upper" : "layer-btn"
            }
            onClick={() => onWindMode("steer")}
            aria-pressed={windMode === "steer"}
            title={t("layers.windSteerTitle")}
          >
            {t("layers.windSteer")}
          </button>
          <button
            type="button"
            className={windMode === "low" ? "layer-btn active wind-low" : "layer-btn"}
            onClick={() => onWindMode("low")}
            aria-pressed={windMode === "low"}
            title={t("layers.wind850Title")}
          >
            850
          </button>
          <button
            type="button"
            className={
              windMode === "upper" ? "layer-btn active wind-upper" : "layer-btn"
            }
            onClick={() => onWindMode("upper")}
            aria-pressed={windMode === "upper"}
            title={t("layers.wind500Title")}
          >
            500
          </button>
        </div>
      </div>

      <div className="panel time-slider-panel" aria-label={t("layers.timePanel")}>
        <div className="time-slider-head">
          <span className="time-slider-label">{t("layers.time")}</span>
          <strong className="time-slider-value">
            {formatTimeOffsetLabel(timeOffsetMinutes, locale)}
          </strong>
        </div>
        {radarStamp && (
          <p className="time-slider-sub">
            {t("layers.radarUtc", { stamp: radarStamp })}
          </p>
        )}
        {timeOffsetMinutes < 0 && !radarStamp && (
          <p className="time-slider-sub">{t("layers.historyHint")}</p>
        )}
        {timeOffsetMinutes === 0 && (
          <p className="time-slider-sub">{t("layers.nowLive")}</p>
        )}
        <input
          type="range"
          min={HISTORY_MIN_OFFSET}
          max={FORECAST_MAX_OFFSET}
          step={TIME_STEP_MINUTES}
          value={timeOffsetMinutes}
          onInput={(e) => onTimeOffsetMinutes(Number(e.currentTarget.value))}
          onChange={(e) => onTimeOffsetMinutes(Number(e.target.value))}
          className="time-slider"
          aria-label={t("layers.timeShift")}
        />
        <div className="time-slider-scale" aria-hidden>
          <span>
            {HISTORY_MIN_OFFSET} {t("layers.min")}
          </span>
          <span>{t("layers.now")}</span>
        </div>
      </div>
    </div>
  );
}
