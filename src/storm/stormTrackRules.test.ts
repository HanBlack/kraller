import { describe, expect, it } from "vitest";
import {
  classifyBirth,
  MAX_TRUSTED_TRACK_KMH,
  maxMatchDistanceKm,
  recentRadarMotion,
  resolveCellMotion,
  TRUE_BIRTH_MAX_DBZ,
} from "./stormTrackRules";
import type { WindGrid } from "../lib/windField";

function gridConstant(u: number, v: number): WindGrid {
  const cols = 4;
  const rows = 4;
  const n = cols * rows;
  return {
    west: 14,
    south: 49,
    east: 17,
    north: 51,
    cols,
    rows,
    u: Float32Array.from({ length: n }, () => u),
    v: Float32Array.from({ length: n }, () => v),
  };
}

describe("classifyBirth — prevence falešného zrodu (Hradec case)", () => {
  it("silná první detekce (~44–50 dBZ) NENÍ zrod", () => {
    const c = classifyBirth({
      birthDbz: 44.5,
      ageMinutes: 10,
      growthDbz: 3.5,
      maxDbz: 48,
      pipelineNewborn: true,
    });
    expect(c.trueBirth).toBe(false);
    expect(c.isNewborn).toBe(false);
    expect(c.reason).toMatch(/birthDbz/);
  });

  it("slabé nové echo JE zrod", () => {
    const c = classifyBirth({
      birthDbz: 32,
      ageMinutes: 5,
      growthDbz: 6,
      maxDbz: 38,
      pipelineNewborn: true,
    });
    expect(c.trueBirth).toBe(true);
    expect(c.isNewborn).toBe(true);
    expect(c.phase).toBe("birth");
  });

  it("věk na stropu historie ≠ zrod", () => {
    const c = classifyBirth({
      birthDbz: 34,
      ageMinutes: 25,
      growthDbz: 10,
      maxDbz: 44,
    });
    expect(c.trueBirth).toBe(false);
  });
});

describe("resolveCellMotion — divoké stopy", () => {
  const windNE = gridConstant(5, 8); // ~NNE/NE

  it("zahodí track > 70 km/h", () => {
    const m = resolveCellMotion(
      {
        peak: [16, 50.4],
        trackHeadingDeg: 110,
        trackSpeedKmh: 99,
        history: [],
      },
      windNE,
      windNE,
    );
    expect(m.source).toBe("wind-fallback");
    expect(m.reason).toMatch(/> 70/);
  });

  it("recent historie 25 km/h NE sedí s větrem", () => {
    const m = resolveCellMotion(
      {
        peak: [16.04, 50.45],
        history: [
          { peak: [15.99, 50.42], minutesFromBirth: 0 },
          { peak: [16.01, 50.43], minutesFromBirth: 5 },
          { peak: [16.04, 50.45], minutesFromBirth: 10 },
        ],
      },
      windNE,
      windNE,
    );
    expect(m.source).toBe("radar-track");
    expect(m.speedKmh).toBeLessThanOrEqual(MAX_TRUSTED_TRACK_KMH);
    expect(m.speedKmh).toBeGreaterThan(5);
  });

  it("konflikt rychlého radaru s větrem → steering", () => {
    const m = resolveCellMotion(
      {
        peak: [16, 50.4],
        trackHeadingDeg: 200,
        trackSpeedKmh: 55,
        history: [
          { peak: [16.0, 50.5], minutesFromBirth: 0 },
          { peak: [16.05, 50.35], minutesFromBirth: 10 },
        ],
      },
      windNE,
      windNE,
    );
    // historie jde zhruba na jih — konflikt s NE větrem
    expect(m.source).toBe("wind-fallback");
  });

  it("constants jsou konzistentní", () => {
    expect(TRUE_BIRTH_MAX_DBZ).toBe(38);
    expect(maxMatchDistanceKm(5)).toBeLessThanOrEqual(12);
    expect(maxMatchDistanceKm(5)).toBeGreaterThan(5);
  });
});

describe("recentRadarMotion", () => {
  it("vrátí null při nereálné rychlosti", () => {
    const m = recentRadarMotion([
      { peak: [15, 50], minutesFromBirth: 0 },
      { peak: [16, 50], minutesFromBirth: 5 }, // ~111 km za 5 min
    ]);
    expect(m).toBeNull();
  });
});
