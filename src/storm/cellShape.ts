import type { Polygon } from "geojson";
import { destinationPoint } from "../lib/geo";
import type { ActiveStormDemo } from "./demo";

/** Jedna intenzitní zóna buňky (jako radarový kontur dBZ). */
export type CellBand = {
  /** Spodní práh dBZ této zóny. */
  dbz: number;
  /** Klíč pro barvu / pořadí. */
  band: "echo" | "moderate" | "heavy" | "core";
  majorKm: number;
  minorKm: number;
  /** Posun středu zóny ve směru pohybu (km) — jádro často napovědu. */
  forwardOffsetKm: number;
};

export type StormCellShape = {
  bands: CellBand[];
  /** Epicentrum = nejsilnější odraz [lon, lat]. */
  epicenter: [number, number];
};

/**
 * Elipsa ve směru pohybu bouře (major = po směru, minor = napříč).
 */
export function ellipsePolygon(
  lat: number,
  lon: number,
  majorKm: number,
  minorKm: number,
  headingDeg: number,
  steps = 56,
): Polygon {
  const h = (headingDeg * Math.PI) / 180;
  const sinH = Math.sin(h);
  const cosH = Math.cos(h);
  const coords: [number, number][] = [];

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const along = majorKm * Math.cos(t);
    const across = minorKm * Math.sin(t);
    const eastKm = along * sinH + across * cosH;
    const northKm = along * cosH - across * sinH;
    const dist = Math.hypot(eastKm, northKm);
    if (dist < 1e-6) {
      coords.push([lon, lat]);
      continue;
    }
    const bearing = ((Math.atan2(eastKm, northKm) * 180) / Math.PI + 360) % 360;
    coords.push(destinationPoint(lat, lon, bearing, dist));
  }

  return { type: "Polygon", coordinates: [coords] };
}

/** Velikost buňky z max dBZ — silnější = větší echo + menší tvrdé jádro. */
function sizeScale(maxDbz: number): number {
  return Math.max(0.65, Math.min(1.35, (maxDbz - 35) / 28));
}

/**
 * Demo „radarový“ tvar buňky:
 * vnější srážkové echo → střední → silné → jádro + epicentrum napovědu.
 */
export function buildStormCellShape(storm: ActiveStormDemo): StormCellShape {
  const s = sizeScale(storm.maxDbz);
  const shear =
    storm.environment?.shear0to6Ms ??
    Math.abs(storm.windUpper.speedKmh - storm.windLow.speedKmh) / 4;
  const elongate = 1.15 + Math.min(0.55, shear / 28);
  const heading = storm.headingDeg;

  const bands: CellBand[] = [];

  // Vnější echo (~35 dBZ) — vždy
  bands.push({
    dbz: 35,
    band: "echo",
    majorKm: 14 * s * elongate,
    minorKm: 9 * s,
    forwardOffsetKm: -1.2 * s,
  });

  if (storm.maxDbz >= 42) {
    bands.push({
      dbz: 45,
      band: "moderate",
      majorKm: 9 * s * elongate,
      minorKm: 5.5 * s,
      forwardOffsetKm: 0.4 * s,
    });
  }

  if (storm.maxDbz >= 50) {
    bands.push({
      dbz: 55,
      band: "heavy",
      majorKm: 5 * s * elongate,
      minorKm: 3.2 * s,
      forwardOffsetKm: 1.6 * s,
    });
  }

  if (storm.maxDbz >= 55) {
    bands.push({
      dbz: Math.min(65, Math.round(storm.maxDbz)),
      band: "core",
      majorKm: 2.4 * s,
      minorKm: 1.7 * s,
      forwardOffsetKm: 2.4 * s,
    });
  } else {
    // Slabší bouře — malé „jádro“ u maxima
    bands.push({
      dbz: storm.maxDbz,
      band: "core",
      majorKm: 2.8 * s,
      minorKm: 2.1 * s,
      forwardOffsetKm: 1.2 * s,
    });
  }

  const core = bands[bands.length - 1];
  const epicenter = destinationPoint(
    storm.lat,
    storm.lon,
    heading,
    core.forwardOffsetKm,
  );

  return { bands, epicenter };
}

export function bandCenter(
  stormLat: number,
  stormLon: number,
  headingDeg: number,
  forwardOffsetKm: number,
): { lat: number; lon: number } {
  const [lon, lat] = destinationPoint(
    stormLat,
    stormLon,
    headingDeg,
    forwardOffsetKm,
  );
  return { lat, lon };
}
