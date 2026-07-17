import type { EnvironmentSignals } from "./types";

/** Zóna potenciálního vzniku (ještě není cell). */
export type FormationZone = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Poloměr zóny na mapě (km). */
  radiusKm: number;
  environment: EnvironmentSignals;
  placeName?: string;
  linkedCellId?: string | null;
  linkedCellKm?: number | null;
};

/** Atmosférický vítr (kam fouká). */
export type WindLevel = {
  /** Azimut kam fouká (0 = sever, 90 = východ). */
  headingDeg: number;
  speedKmh: number;
};

/** Bouře už na radaru — vzdálenost/ETA se dopočítá vůči uživateli. */
export type ActiveStormDemo = {
  id: string;
  lat: number;
  lon: number;
  maxDbz: number;
  echoTopKm: number;
  speedKmh: number;
  headingDeg: number;
  fromPlace: string;
  /** Spodní vítr (~přízemní / 850 hPa). */
  windLow: WindLevel;
  /** Horní vítr (~500 hPa). */
  windUpper: WindLevel;
  environment?: EnvironmentSignals;
};

/** Demo: zóny vzniku — prázdné; používají se jen reálná data z grid.json. */
export const demoFormationZones: FormationZone[] = [];

/** Demo: bouře v progresu — vypnuto; používáme jen reálné OPERA buňky. */
export const demoActiveStorms: ActiveStormDemo[] = [];
