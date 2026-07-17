export type UserLocation = {
  label: string;
  placeName: string;
  lat: number;
  lon: number;
};

/** Tornado se do výstupu dostane jen při vyšší šanci. */
export type StormAlert = {
  severity: "weak" | "moderate" | "strong";
  etaMinutes: number;
  fromPlace: string;
  toPlace: string;
  /** Aktuální síla echa (dBZ), pokud je z radaru. */
  maxDbz?: number;
  /** Vzdálenost k lokaci (km). */
  distanceKm?: number;
  hailCmMax?: number;
  rainMmPerHour?: [number, number];
  /** null / undefined = do zprávy se vůbec nedá */
  tornadoChancePct?: number | null;
};
