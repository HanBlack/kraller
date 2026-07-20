import { describe, expect, it } from "vitest";
import {
  clusterFormationZones,
  formationHeatGeoJSON,
} from "./formationData";
import { formationGridGeoJSON } from "./formationVisual";
import type { ScoredFormationPoint } from "./formationData";
import { scoreFormation } from "./scoreFormation";
import type { EnvironmentSignals } from "./types";

function pt(
  lat: number,
  lon: number,
  cape: number,
): ScoredFormationPoint {
  const environment: EnvironmentSignals = {
    capeJkg: cape,
    capeNowJkg: cape * 0.7,
    dewpointC: 14,
    shear0to6Ms: 14,
    srh01: 80,
    cloudTopCoolingCPer15min: -1,
    liftedIndexC: -1,
    steerHeadingDeg: 30,
    steerSpeedKmh: 35,
  };
  return {
    lat,
    lon,
    environment,
    assessment: scoreFormation(environment),
  };
}

describe("formation visibility — méně slepý vznik", () => {
  const grid = [
    pt(48.2, 15.5, 500), // AT
    pt(48.5, 15.8, 450),
    pt(49.0, 14.5, 400), // JČ
    pt(49.2, 16.6, 380), // Brno
    pt(49.3, 18.0, 350), // VS
    pt(50.0, 14.4, 120), // slabší
    pt(50.5, 15.0, 90),
  ];

  it("grid tečky berou i střední skóre (≥22)", () => {
    const fc = formationGridGeoJSON(grid, 22);
    expect(fc.features.length).toBeGreaterThanOrEqual(5);
  });

  it("vyšší práh 36 skrývá slabší body", () => {
    const loose = formationGridGeoJSON(grid, 22);
    const tight = formationGridGeoJSON(grid, 36);
    expect(tight.features.length).toBeLessThanOrEqual(loose.features.length);
  });

  it("heat geojson filtruje nízké skóre", () => {
    const heat = formationHeatGeoJSON(grid, null);
    expect(heat.features.length).toBeGreaterThan(0);
    for (const f of heat.features) {
      expect(Number(f.properties?.score)).toBeGreaterThanOrEqual(22);
    }
  });

  it("zóny Vznik jen v ČR — AT body bez kruhu/popisku", () => {
    const zones = clusterFormationZones(grid, null);
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) {
      expect(z.lat).toBeGreaterThan(48.4);
      expect(z.name).not.toMatch(/Rakousko|Vídn|Polsko/i);
    }
  });

  it("heat tečky daleko mimo ČR neukazuje", () => {
    const heat = formationHeatGeoJSON(grid, null);
    for (const f of heat.features) {
      const coords =
        f.geometry.type === "Point"
          ? (f.geometry.coordinates as [number, number])
          : [0, 0];
      const lat = coords[1];
      // AT 48.2 by neměl projít (margin 40 km)
      expect(lat).toBeGreaterThan(48.35);
    }
  });
});
