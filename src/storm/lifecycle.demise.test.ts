import { describe, expect, it } from "vitest";
import { estimateDemise } from "./lifecycle";
import type { RadarProgressFeature } from "./radarCells";

function baseFeature(
  partial: Partial<RadarProgressFeature> &
    Pick<RadarProgressFeature, "history" | "growthDbz" | "maxDbz" | "phase">,
): RadarProgressFeature {
  return {
    id: "t1",
    peak: [18, 49.3],
    birth: [17.9, 49.25],
    trackEnd: [18.2, 49.4],
    headingDeg: 45,
    speedKmh: 40,
    threatens: 0,
    severity: "moderate",
    rank: 1,
    label: "test",
    placeLabel: "test",
    ageMinutes: 30,
    historyMinutes: 30,
    birthDbz: 40,
    isNewborn: false,
    trueBirth: true,
    motionSource: "radar-track",
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [18, 49.3],
          [18.1, 49.3],
          [18.1, 49.4],
          [18, 49.4],
          [18, 49.3],
        ],
      ],
    },
    ...partial,
  };
}

describe("estimateDemise — confidence", () => {
  it("observed when history shows clear decay", () => {
    const d = estimateDemise(
      baseFeature({
        maxDbz: 48,
        growthDbz: -3,
        phase: "mature",
        history: [
          { time: "20260720120000", peak: [17.9, 49.25], maxDbz: 55, minutesFromBirth: 0 },
          { time: "20260720121500", peak: [18.0, 49.28], maxDbz: 48, minutesFromBirth: 15 },
        ],
      }),
    );
    expect(d.confidence).toBe("observed");
    expect(d.etaMinLo).toBeLessThan(d.etaMinHi);
  });

  it("trending when growthDbz negative without long decay history", () => {
    const d = estimateDemise(
      baseFeature({
        maxDbz: 45,
        growthDbz: -3,
        phase: "moving",
        history: [
          { time: "a", peak: [18, 49.3], maxDbz: 45, minutesFromBirth: 0 },
          { time: "b", peak: [18.05, 49.32], maxDbz: 44, minutesFromBirth: 5 },
        ],
      }),
    );
    expect(d.confidence).toBe("trending");
  });

  it("climatology when stable strong cell", () => {
    const d = estimateDemise(
      baseFeature({
        maxDbz: 52,
        growthDbz: 1,
        phase: "mature",
        history: [
          { time: "a", peak: [18, 49.3], maxDbz: 50, minutesFromBirth: 0 },
          { time: "b", peak: [18.1, 49.35], maxDbz: 52, minutesFromBirth: 15 },
        ],
      }),
    );
    expect(d.confidence).toBe("climatology");
    expect(d.reasons[0]).toMatch(/nejde o fakt/i);
  });

  it("odloží zánik když vývoj predikuje růst", () => {
    const d = estimateDemise(
      baseFeature({
        maxDbz: 36,
        growthDbz: 0,
        phase: "moving",
        history: [
          { time: "a", peak: [18, 49.3], maxDbz: 35, minutesFromBirth: 0 },
          { time: "b", peak: [18.05, 49.32], maxDbz: 36, minutesFromBirth: 5 },
        ],
      }),
      null,
      [],
      { predictedDbz15: 40 },
    );
    expect(d.confidence).toBe("climatology");
    expect(d.etaMin).toBeGreaterThanOrEqual(22);
  });
});
