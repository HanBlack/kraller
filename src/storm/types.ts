/** Surové vstupy prostředí (NWP). CAPE peak vs now, shear, proxy nestability. */
export type EnvironmentSignals = {
  /**
   * CAPE (J/kg) pro skóre vzniku = peak teď…+6 h (ne noční nula z 00 UTC).
   */
  capeJkg: number;
  /** CAPE v aktuální hodině UTC — diagnostika. */
  capeNowJkg?: number;
  /** Může chybět, pokud Open-Meteo nevrátí dewpoint. */
  dewpointC: number | null;
  shear0to6Ms: number;
  srh01: number;
  /** Záporné = ochlazování / rostoucí nestabilita (°C / 15 min). */
  cloudTopCoolingCPer15min: number;
  /** Odkud cooling pochází — satelit vs Open-Meteo LI proxy. */
  coolingSource?: "satellite" | "model";
  /** Satelit CTT (°C) — diagnostika. */
  cloudTopTempC?: number;
  /** Satelit CTH (m n. m.). */
  cloudTopHeightM?: number;
  /** Δ výšky vrcholu (m / 15 min). */
  cloudTopHeightDeltaMPer15min?: number;
  /** Lifted index (°C); záporné = nestabilní prostředí. */
  liftedIndexC?: number;
  /** Výška nulové izotermy (m n. m.) — Waldvogel / riziko krup. */
  freezingLevelM?: number | null;
  /**
   * Convective inhibition (J/kg). Open-Meteo často záporné;
   * větší |CIN| = silnější záklop proti vzniku.
   */
  convectiveInhibitionJkg?: number | null;
  /** Směr řízení (deep-layer 850+500) — stejné jako trajektorie buněk. */
  steerHeadingDeg?: number;
  /** Rychlost řízení (km/h). */
  steerSpeedKmh?: number;
};

/** Rosný bod pro výpočty — chybí-li v datech, použij fallback. */
export function dewpointCOr(
  env: { dewpointC?: number | null },
  fallback = -40,
): number {
  return env.dewpointC ?? fallback;
}

/** Surové vstupy radaru pro jednu cell. */
export type RadarCellSignals = {
  id: string;
  lat: number;
  lon: number;
  maxDbz: number;
  echoTopKm: number;
  /** Skutečná výška echa z ČHMÚ — jinak proxy z dBZ. */
  echoTopSource?: "CHMI";
  /** Zdroj dBZ u jádra. */
  dbzSource?: "CHMI" | "OPERA";
  /**
   * PseudoCAPPI 2 km (ČHMÚ) — lepší proxy deště u země než maxZ.
   * Jen nad CZ, když je k dispozici.
   */
  surfaceDbz?: number;
  /** Rychlost pohybu (km/h). */
  speedKmh: number;
  /** Azimut pohybu ve stupních (0 = sever, 90 = východ). */
  headingDeg: number;
  /** Vzdálenost k uživateli (km). */
  distanceToUserKm: number;
  /** Úhel mezi směrem pohybu a směrem k uživateli (0 = přímo na tebe). */
  approachAngleDeg: number;
  /** Název místa odkud „jde“ (reverse geocode / nejbližší obec). */
  fromPlace: string;
};

export type HazardScores = {
  overall: number;
  hail: number;
  rain: number;
  supercell: number;
  tornado: number;
};

/** Větev 1: potenciál vzniku. */
export type FormationAssessment = {
  kind: "formation";
  score: number;
  severity: "weak" | "moderate" | "strong";
  hazards: HazardScores;
  reasons: string[];
};

/** Větev 2: bouře už běží. */
export type ActiveStormAssessment = {
  kind: "active";
  cellId: string;
  score: number;
  severity: "weak" | "moderate" | "strong";
  etaMinutes: number | null;
  fromPlace: string;
  maxDbz: number;
  distanceToUserKm: number;
  hailCmMax: number | null;
  rainMmPerHour: [number, number] | null;
  /** Zásah u sledované adresy (jádro / okraj / mimo). */
  hitType?: "core" | "fringe" | "edge" | "miss";
  missKm?: number;
  /** Odhad dBZ u adresy (může být slabší než peak). */
  atUserDbz?: number | null;
  hazards: HazardScores;
  reasons: string[];
};

export type StormAssessment = FormationAssessment | ActiveStormAssessment;
