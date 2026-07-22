import {
  sampleWind,
  stormSteeringMotion,
  type WindGrid,
} from "../lib/windField";
import type { EnvironmentSignals } from "./types";
import { t, type Locale, getLocale } from "../i18n";

/** Vítr prostředí u jádra + pohyb buňky — ne Doppler uvnitř bouřky. */
export type StormWindAtCell = {
  lowSpeedKmh: number | null;
  steerSpeedKmh: number;
  cellSpeedKmh: number;
  shear0to6Ms: number | null;
};

export function stormWindAtCell(
  peak: [number, number],
  cellSpeedKmh: number,
  windLow: WindGrid | null,
  windUpper: WindGrid | null,
  env?: EnvironmentSignals | null,
): StormWindAtCell {
  const [lon, lat] = peak;
  const low = windLow ? sampleWind(windLow, lon, lat) : null;
  const steer = stormSteeringMotion(windLow, windUpper, lon, lat);
  return {
    lowSpeedKmh:
      low && low.speed >= 0.4 ? Math.round(low.speed * 3.6) : null,
    steerSpeedKmh: Math.round(steer.speedKmh),
    cellSpeedKmh: Math.round(cellSpeedKmh),
    shear0to6Ms:
      env?.shear0to6Ms != null && Number.isFinite(env.shear0to6Ms)
        ? Math.round(env.shear0to6Ms * 10) / 10
        : null,
  };
}

/** Víceřádkový blok do detailu buňky. */
export function formatStormWindDetail(
  w: StormWindAtCell,
  locale: Locale = getLocale(),
): string[] {
  const lines: string[] = [];
  if (w.lowSpeedKmh != null) {
    lines.push(
      t("storm.windLowAtCell", { speed: w.lowSpeedKmh }, locale),
    );
  }
  lines.push(
    t("storm.windSteerAtCell", { speed: w.steerSpeedKmh }, locale),
  );
  lines.push(
    t("storm.windCellMotion", { speed: w.cellSpeedKmh }, locale),
  );
  if (w.shear0to6Ms != null && w.shear0to6Ms >= 8) {
    lines.push(
      t("storm.windShearAtCell", { shear: w.shear0to6Ms }, locale),
    );
  }
  return lines;
}

/** Krátký řádek na mapu (jen strong / hrozba). */
export function formatStormWindMapLine(
  w: StormWindAtCell,
  locale: Locale = getLocale(),
): string {
  const ambient = w.lowSpeedKmh ?? w.steerSpeedKmh;
  return t(
    "storm.windMapLine",
    { ambient, cell: w.cellSpeedKmh },
    locale,
  );
}
