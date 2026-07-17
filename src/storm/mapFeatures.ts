import type { Polygon } from "geojson";
import { angleDiffDeg, bearingDeg, destinationPoint, distanceKm } from "../lib/geo";
import {
  buildStormCellShape,
  type StormCellShape,
} from "./cellShape";
import { stormConfig } from "./config";
import type { ActiveStormDemo, FormationZone } from "./demo";
import { scoreActiveStorm, shouldAlertActive } from "./scoreActive";
import { scoreFormation, shouldAlertFormation } from "./scoreFormation";
import type { ActiveStormAssessment, FormationAssessment } from "./types";
import type { UserLocation } from "../types";
import type { FormationForecast } from "./formationForecast";
import { forecastFormation } from "./formationForecast";
import type { WindGrid } from "../lib/windField";

export type FormationFeature = {
  zone: FormationZone;
  assessment: FormationAssessment;
  alert: boolean;
  forecast: FormationForecast;
};

export type ActiveFeature = {
  storm: ActiveStormDemo;
  assessment: ActiveStormAssessment;
  alert: boolean;
  /** Konec směrové čáry (60 min extrapolace) [lon, lat]. */
  trackEnd: [number, number];
  /** Radarová struktura buňky (zóny dBZ + epicentrum). */
  cell: StormCellShape;
};

export function buildFormationFeatures(
  zones: FormationZone[],
  windLow: WindGrid | null = null,
  user: UserLocation | null = null,
  windUpper: WindGrid | null = null,
): FormationFeature[] {
  return zones.map((zone) => {
    const assessment = scoreFormation(zone.environment);
    const forecast = forecastFormation(
      zone.lat,
      zone.lon,
      zone.environment,
      assessment,
      windLow,
      user,
      windUpper,
    );
    return {
      zone,
      assessment,
      alert: shouldAlertFormation(assessment) || forecast.threatensUser,
      forecast,
    };
  });
}

export function buildActiveFeatures(
  storms: ActiveStormDemo[],
  user: UserLocation | null,
): ActiveFeature[] {
  return storms.map((storm) => {
    let distanceToUserKm = 40;
    let approachAngleDeg = 90;

    if (user) {
      distanceToUserKm = distanceKm(
        storm.lat,
        storm.lon,
        user.lat,
        user.lon,
      );
      const toUser = bearingDeg(storm.lat, storm.lon, user.lat, user.lon);
      approachAngleDeg = angleDiffDeg(storm.headingDeg, toUser);
    }

    const assessment = scoreActiveStorm(
      {
        id: storm.id,
        lat: storm.lat,
        lon: storm.lon,
        maxDbz: storm.maxDbz,
        echoTopKm: storm.echoTopKm,
        speedKmh: storm.speedKmh,
        headingDeg: storm.headingDeg,
        distanceToUserKm,
        approachAngleDeg,
        fromPlace: storm.fromPlace,
      },
      storm.environment ?? null,
    );

    const cell = buildStormCellShape(storm);
    const [epiLon, epiLat] = cell.epicenter;

    const trackKm =
      (storm.speedKmh * stormConfig.alertHorizonMin) / 60;
    // Trajektorie od epicentra (ne od geometrického středu echa)
    const trackEnd = destinationPoint(
      epiLat,
      epiLon,
      storm.headingDeg,
      trackKm,
    );

    return {
      storm,
      assessment,
      alert: user ? shouldAlertActive(assessment) : false,
      trackEnd,
      cell,
    };
  });
}

/** Přibližný kruh jako polygon (lon/lat). */
export function circlePolygon(
  lat: number,
  lon: number,
  radiusKm: number,
  steps = 48,
): Polygon {
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 360;
    coords.push(destinationPoint(lat, lon, bearing, radiusKm));
  }
  return { type: "Polygon", coordinates: [coords] };
}
