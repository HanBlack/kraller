import type { FeatureCollection } from "geojson";
import { getLocale, type Locale } from "../i18n";import { severityRank } from "../lib/severity";
import { formationMapLabelWithForecast } from "./formationForecast";
import { formationPlaceName } from "./formationCopy";
import type { FormationFeature } from "./mapFeatures";
import type { FormationCellLink } from "./formationLinks";
import type { ScoredFormationPoint } from "./formationData";
import { circlePolygon } from "./mapFeatures";

export function formationGridGeoJSON(
  points: ScoredFormationPoint[],
  minScore = 22,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points
      .filter((p) => p.assessment.score >= minScore)
      .sort((a, b) => b.assessment.score - a.assessment.score)
      .slice(0, 48)
      .map((p) => ({
        type: "Feature",
        properties: {
          score: p.assessment.score,
          severity: p.assessment.severity,
          rank: severityRank(p.assessment.severity),
        },
        geometry: {
          type: "Point",
          coordinates: [p.lon, p.lat],
        },
      })),
  };
}

export function formationLinksGeoJSON(
  links: FormationCellLink[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: links.map((l) => ({
      type: "Feature",
      properties: {
        zoneId: l.zoneId,
        cellId: l.cellId,
        km: Math.round(l.distanceKm),
        reason: l.reason,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [l.zoneLon, l.zoneLat],
          [l.cellLon, l.cellLat],
        ],
      },
    })),
  };
}

export function formationZonesGeoJSON(
  features: FormationFeature[],
  locale: Locale = getLocale(),
): FeatureCollection {  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature",
      id: f.zone.id,
      properties: {
        id: f.zone.id,
        name: f.zone.name,
        score: f.assessment.score,
        severity: f.assessment.severity,
        rank: severityRank(f.assessment.severity),
        linkedCellId: f.zone.linkedCellId ?? "",
        label: formationMapLabelWithForecast(
          formationPlaceName(f.zone),
          f.assessment,
          f.forecast,
          locale,
        ),        threatens: f.forecast.threatensUser ? 1 : 0,
        heading: f.forecast.headingDeg,
      },
      geometry: circlePolygon(f.zone.lat, f.zone.lon, f.zone.radiusKm),
    })),
  };
}

export function formationTracksGeoJSON(
  features: FormationFeature[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f.assessment.score >= 28)
      .map((f) => ({
        type: "Feature",
        properties: {
          id: f.zone.id,
          threatens: f.forecast.threatensUser ? 1 : 0,
          severity: f.assessment.severity,
        },
        geometry: {
          type: "LineString",
          coordinates: [
            [f.zone.lon, f.zone.lat],
            f.forecast.trackEnd,
          ],
        },
      })),
  };
}

export function formationArrowsGeoJSON(
  features: FormationFeature[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f.assessment.score >= 28)
      .map((f) => ({
        type: "Feature",
        properties: {
          id: f.zone.id,
          heading: f.forecast.headingDeg,
          threatens: f.forecast.threatensUser ? 1 : 0,
          severity: f.assessment.severity,
        },
        geometry: {
          type: "Point",
          // Stejný střed zóny — šipka (anchor bottom) ukazuje kam to po zrodu půjde
          coordinates: [f.zone.lon, f.zone.lat],
        },
      })),
  };
}

export function formationCentersGeoJSON(
  features: FormationFeature[],
): FeatureCollection {
  const growThr = 2; // matches stormConfig.formation.cloudTopCoolingCPer15min.growing
  return {
    type: "FeatureCollection",
    features: features.map((f) => {
      const env = f.zone.environment;
      const cooling = env?.cloudTopCoolingCPer15min ?? 0;
      const rate = -cooling;
      const satGrowing =
        env?.coolingSource === "satellite" && rate >= growThr ? 1 : 0;
      return {
        type: "Feature",
        properties: {
          id: f.zone.id,
          severity: f.assessment.severity,
          rank: severityRank(f.assessment.severity),
          score: f.assessment.score,
          satCooling: satGrowing,
        },
        geometry: {
          type: "Point",
          coordinates: [f.zone.lon, f.zone.lat],
        },
      };
    }),
  };
}
