import { describe, expect, it } from "vitest";
import {
  LIVE_ADVECT_CAP_MIN,
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
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 0,
        productIso: "2026-07-21T11:00:00Z",
        nowMs: t0,
      }),
    ).toBe(LIVE_ADVECT_CAP_MIN);
  });

  it("+N je vždy ≥ Teď (věk + offset)", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 5,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(15, 5);
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 5,
        productIso: "2026-07-21T11:57:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(8, 5);
  });

  it("slider budoucnost bere offset, historie 0", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 15,
        productIso: "2026-07-21T11:55:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(20, 5);
    expect(
      motionMinutesForView({
        timeOffsetMinutes: -10,
        productIso: "2026-07-21T11:55:00Z",
        nowMs: t0,
      }),
    ).toBe(0);
  });
});
