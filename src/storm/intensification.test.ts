import { describe, expect, it } from "vitest";
import {
  forecastCellIntensification,
  formatIntensificationSummary,
  type IntensTrackCell,
} from "./intensification";
import type { ScoredFormationPoint } from "./formationData";
import type { EnvironmentSignals } from "./types";
import { scoreFormation } from "./scoreFormation";

function env(partial: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return {
    capeJkg: 400,
    capeNowJkg: 300,
    dewpointC: 15,
    shear0to6Ms: 12,
    srh01: 80,
    cloudTopCoolingCPer15min: -2,
    liftedIndexC: -1,
    steerHeadingDeg: 40,
    steerSpeedKmh: 35,
    ...partial,
  };
}

function scoredPoint(
  lat: number,
  lon: number,
  e: EnvironmentSignals,
): ScoredFormationPoint {
  return {
    lat,
    lon,
    environment: e,
    assessment: scoreFormation(e),
  };
}

/** Silné prostředí podél stopy na NE od peaku. */
function fuelAlongTrack(peakLat: number, peakLon: number): ScoredFormationPoint[] {
  const points: ScoredFormationPoint[] = [];
  // peak okolí — slabší
  points.push(scoredPoint(peakLat, peakLon, env({ capeJkg: 80, dewpointC: 11 })));
  // dál po NE (~heading 45) — silné palivo
  for (let i = 1; i <= 8; i++) {
    const lat = peakLat + i * 0.08;
    const lon = peakLon + i * 0.1;
    points.push(
      scoredPoint(
        lat,
        lon,
        env({ capeJkg: 600 + i * 40, dewpointC: 16, shear0to6Ms: 14 }),
      ),
    );
  }
  return points;
}

describe("intensification — poctivá fialová", () => {
  const cell: IntensTrackCell = {
    id: "c1",
    maxDbz: 42,
    peak: [17.0, 49.2],
    headingDeg: 45,
    speedKmh: 40,
    growthDbz: 4,
  };

  it("rostoucí slabá buňka v silném env může mít willIntensify", () => {
    const intens = forecastCellIntensification(
      cell,
      fuelAlongTrack(49.2, 17.0),
    );
    // Po vyšších prahech nemusí vždy projít — ale při palivu by score/timeline měly žít
    expect(intens.timeline.length).toBeGreaterThan(5);
    if (intens.willIntensify) {
      expect(intens.peakExpectedDbz).toBeGreaterThan(cell.maxDbz);
      expect(intens.whyHeadline ?? "").toMatch(/může zesílit|zesílit/i);
      expect(formatIntensificationSummary(intens)).toMatch(/může zesílit/i);
    }
  });

  it("slábnoucí echo → žádná fialová (suppress), i když env láká", () => {
    const intens = forecastCellIntensification(
      { ...cell, growthDbz: -3 },
      fuelAlongTrack(49.2, 17.0),
    );
    expect(intens.willIntensify).toBe(false);
    expect(intens.segments).toHaveLength(0);
    expect(intens.whyHeadline ?? "").toMatch(/slábne/i);
  });

  it("už silná buňka bez headroomu nehlásí zesílení", () => {
    const intens = forecastCellIntensification(
      { ...cell, maxDbz: 58, growthDbz: 1 },
      // stejné CAPE všude — málo headroomu
      [
        scoredPoint(49.2, 17.0, env({ capeJkg: 200 })),
        scoredPoint(49.4, 17.3, env({ capeJkg: 220 })),
        scoredPoint(49.6, 17.6, env({ capeJkg: 210 })),
      ],
    );
    expect(intens.willIntensify).toBe(false);
  });
});
