import { describe, expect, it } from "vitest";
import {
  minutesSince,
  radarFreshness,
  RADAR_STALE_AFTER_MINUTES,
} from "./radarFreshness";

const NOW = Date.parse("2026-10-09T08:00:00Z");

describe("radar freshness", () => {
  it("treats missing or invalid timestamps as unavailable", () => {
    expect(radarFreshness(null, true, NOW)).toBe("unavailable");
    expect(radarFreshness("not-a-date", true, NOW)).toBe("unavailable");
    expect(radarFreshness("2026-10-09T07:59:00Z", false, NOW)).toBe(
      "unavailable",
    );
    expect(minutesSince("not-a-date", NOW)).toBeNull();
  });

  it("distinguishes fresh radar from a stale frame at the warning threshold", () => {
    expect(radarFreshness("2026-10-09T07:51:00Z", true, NOW)).toBe("current");
    expect(
      radarFreshness(
        new Date(NOW - RADAR_STALE_AFTER_MINUTES * 60_000).toISOString(),
        true,
        NOW,
      ),
    ).toBe("stale");
  });
});
