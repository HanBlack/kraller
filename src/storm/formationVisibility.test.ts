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
    pt(48.2, 15.5, 500), // AT u hranice — má projít (vznik AT→CZ)
    pt(47.5, 15.5, 520), // hluboko AT bez cesty do CZ — ne
    pt(48.5, 15.8, 450),
    pt(49.0, 14.5, 400), // JČ
    pt(49.2, 16.6, 380), // Brno
    pt(49.3, 18.0, 350), // VS
    pt(50.0, 14.4, 120), // slabší
    pt(50.5, 15.0, 90),
  ];

  /** Hluboko AT, ale steering přímo na sever do JČ. */
  function atSteeringIntoCz(): ScoredFormationPoint {
    const environment: EnvironmentSignals = {
      capeJkg: 520,
      capeNowJkg: 400,
      dewpointC: 15,
      shear0to6Ms: 14,
      srh01: 80,
      cloudTopCoolingCPer15min: -2,
      liftedIndexC: -2,
      steerHeadingDeg: 5,
      steerSpeedKmh: 48,
    };
    return {
      lat: 47.55,
      lon: 15.4,
      environment,
      assessment: scoreFormation(environment),
    };
  }

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
      expect(Number(f.properties?.score)).toBeGreaterThanOrEqual(20);
    }
  });

  it("zóny Vznik: ČR + širší pás; hluboko AT bez cesty do CZ ne", () => {
    const zones = clusterFormationZones(grid, null);
    expect(zones.length).toBeGreaterThan(0);
    const lats = zones.map((z) => z.lat);
    expect(Math.min(...lats)).toBeGreaterThanOrEqual(47.9);
    expect(lats.every((lat) => lat > 47.7)).toBe(true);
  });

  it("AT setup se steeringem do CZ projde i mimo margin pás", () => {
    const zones = clusterFormationZones([...grid, atSteeringIntoCz()], null);
    expect(zones.some((z) => z.lat < 47.8)).toBe(true);
  });

  it("heat tečky: pás u hranice ano, hluboko AT bez cesty ne", () => {
    const heat = formationHeatGeoJSON(grid, null);
    const lats = heat.features.map((f) => {
      const coords =
        f.geometry.type === "Point"
          ? (f.geometry.coordinates as [number, number])
          : [0, 0];
      return coords[1];
    });
    expect(lats.every((lat) => lat > 47.7)).toBe(true);
    expect(lats.some((lat) => lat < 48.4)).toBe(true);
  });
});
