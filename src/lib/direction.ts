import { t, type Locale } from "../i18n";

const HEADING_KEYS = [
  "direction.n",
  "direction.ne",
  "direction.e",
  "direction.se",
  "direction.s",
  "direction.sw",
  "direction.w",
  "direction.nw",
] as const;

/** Azimuth → short compass label. */
export function headingLabel(deg: number, locale?: Locale): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return t(HEADING_KEYS[i], undefined, locale);
}

/** @deprecated use headingLabel */
export function headingToCzech(deg: number): string {
  return headingLabel(deg, "cs");
}

/** e.g. “moving north” / “jde na sever”. */
export function headingPhrase(deg: number, locale?: Locale): string {
  return t("direction.phrase", { dir: headingLabel(deg, locale) }, locale);
}

export function headingShort(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[i];
}
