import type { CellHistoryPoint } from "../storm/radarCells";
import { useI18n } from "../i18n";

type Props = {
  history: CellHistoryPoint[];
  currentDbz: number;
  ageMinutes: number;
};

function bandClass(dbz: number): string {
  if (dbz >= 55) return "heavy";
  if (dbz >= 45) return "moderate";
  if (dbz >= 38) return "echo-strong";
  return "echo";
}

function sizeClass(dbz: number, index: number, total: number): string {
  const growth = index / Math.max(1, total - 1);
  if (dbz >= 50 || growth > 0.75) return "lg";
  if (dbz >= 42 || growth > 0.35) return "md";
  return "sm";
}

/**
 * Vizualní životopis buňky: prázdno → zrod → růst → teď
 */
export function BirthTimeline({ history, currentDbz, ageMinutes }: Props) {
  const { t } = useI18n();
  const points =
    history.length > 0
      ? history
      : [
          {
            time: "",
            peak: [0, 0] as [number, number],
            maxDbz: currentDbz,
            minutesFromBirth: 0,
          },
        ];

  const steps = points.length > 6 ? points.filter((_, i, a) => {
    if (i === 0 || i === a.length - 1) return true;
    const step = Math.ceil((a.length - 2) / 4);
    return i % step === 0;
  }).slice(0, 6) : points;

  return (
    <div className="birth-timeline" aria-label={t("storm.timelineTitle")}>
      <p className="birth-timeline-title">{t("storm.timelineHeading")}</p>
      <ol className="birth-timeline-track">
        <li className="birth-step empty" aria-hidden>
          <span className="birth-blob empty" />
          <span className="birth-step-label">{t("storm.before")}</span>
        </li>
        {steps.map((p, i) => {
          const isBirth = i === 0;
          const isNow = i === steps.length - 1;
          return (
            <li
              key={`${p.time}-${i}`}
              className={`birth-step ${isBirth ? "birth" : ""} ${isNow ? "now" : ""}`}
            >
              <span
                className={`birth-blob ${bandClass(p.maxDbz)} ${sizeClass(p.maxDbz, i, steps.length)}`}
              />
              <span className="birth-step-dbz">{Math.round(p.maxDbz)}</span>
              <span className="birth-step-label">
                {isBirth
                  ? t("storm.birth")
                  : isNow
                    ? ageMinutes > 0
                      ? t("storm.nowAge", { min: ageMinutes })
                      : t("time.now")
                    : `+${p.minutesFromBirth} min`}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="birth-timeline-note">
        {ageMinutes <= 10
          ? t("storm.timelineNew")
          : t("storm.timelineGrowth", {
              age: ageMinutes,
              from: Math.round(points[0]?.maxDbz ?? currentDbz),
              to: Math.round(currentDbz),
            })}
      </p>
    </div>
  );
}
