import { describe, expect, it } from "vitest";
import {
  LIVE_ADVECT_CAP_MIN,
  liveExtrapolationMinutes,
  motionMinutesForView,
  radarProductAgeMinutes,
} from "./liveRadarMotion";

describe("liveRadarMotion", () => {
  const t0 = Date.parse("2026-07-21T12:00:00Z");

  it("age from product time", () => {
    expect(
      radarProductAgeMinutes("2026-07-21T11:55:00Z", t0),
    ).toBeCloseTo(5, 5);
  });

  it("Teď = clampovaný věk snímku", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 0,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(10, 5);
  });

  it("±5 min kroky slideru = ±5 min posunu (liveAge=10)", () => {
    const iso = "2026-07-21T11:50:00Z";
    const m5 = motionMinutesForView({
      timeOffsetMinutes: -5,
      productIso: iso,
      nowMs: t0,
    });
    const m0 = motionMinutesForView({
      timeOffsetMinutes: 0,
      productIso: iso,
      nowMs: t0,
    });
    const p5 = motionMinutesForView({
      timeOffsetMinutes: 5,
      productIso: iso,
      nowMs: t0,
    });
    expect(m0 - m5).toBeCloseTo(5, 5);
    expect(p5 - m0).toBeCloseTo(5, 5);
  });

  it("historie nejde pod nulu", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: -15,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBe(0);
  });

  it("liveExtrapolationMinutes = věk snímku (UI)", () => {
    expect(
      liveExtrapolationMinutes({
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(10, 5);
    expect(
      liveExtrapolationMinutes({
        productIso: "2026-07-21T11:00:00Z",
        nowMs: t0,
      }),
    ).toBe(LIVE_ADVECT_CAP_MIN);
  });
});
