import { t, type Locale } from "../i18n";
import type { StormAlert } from "../types";
import type { FormationAssessment } from "../storm/types";

export type Severity = StormAlert["severity"] | FormationAssessment["severity"];

export function severityLabel(severity: Severity, locale?: Locale): string {
  return t(`severity.${severity}`, undefined, locale);
}

export function formationSeverityLabel(
  severity: FormationAssessment["severity"],
  locale?: Locale,
): string {
  const key =
    severity === "weak"
      ? "severity.formWeak"
      : severity === "moderate"
        ? "severity.formModerate"
        : "severity.formStrong";
  return t(key, undefined, locale);
}

/** @deprecated use severityLabel */
export const severityLabelCs: Record<Severity, string> = {
  weak: "Slabá",
  moderate: "Střední",
  strong: "Silná",
};

/** Pořadí síly pro velikost na mapě. */
export function severityRank(severity: Severity): number {
  if (severity === "strong") return 3;
  if (severity === "moderate") return 2;
  return 1;
}
