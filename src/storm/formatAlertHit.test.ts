import { describe, expect, it } from "vitest";
import {
  formatStormAlert,
  formatStormAlertDetail,
  formatStormAlertHero,
} from "../lib/formatAlert";
import { alertFromActive } from "./buildAlert";
import { scoreActiveStorm } from "./scoreActive";
import type { RadarCellSignals } from "./types";
import type { StormAlert } from "../types";

function cell(p: Partial<RadarCellSignals>): RadarCellSignals {
  return {
    id: "x",
    lat: 49.3,
    lon: 18.0,
    maxDbz: 58,
    echoTopKm: 11,
    speedKmh: 40,
    headingDeg: 50,
    distanceToUserKm: 25,
    approachAngleDeg: 3,
    fromPlace: "Ústí",
    ...p,
  };
}

describe("formatStormAlert — síla u adresy před příchodem", () => {
  it("detail obsahuje zásah jádra a mm/h", () => {
    const scored = scoreActiveStorm(cell({ approachAngleDeg: 2 }));
    const alert = alertFromActive(scored, "Nový Hrozenkov");
    expect(alert).not.toBeNull();
    expect(alert!.hitType).toBe("core");
    const detail = formatStormAlertDetail(alert!, "cs");
    expect(detail).toMatch(/zásah jádra/i);
    expect(detail).toMatch(/mm\/h/i);
  });

  it("silné echo: detail má riziko krup s cm", () => {
    const scored = scoreActiveStorm(
      cell({ maxDbz: 58, echoTopKm: 12, approachAngleDeg: 2 }),
    );
    expect(scored.hailCmMax).not.toBeNull();
    const alert = alertFromActive(scored, "Hrozenkov");
    const detail = formatStormAlertDetail(alert!, "cs");
    expect(detail).toMatch(/kroupy/i);
    expect(detail).toMatch(/cm/);
  });

  it("okraj: text říká že jádro mine + slabší déšť", () => {
    const scored = scoreActiveStorm(
      cell({ distanceToUserKm: 35, approachAngleDeg: 18 }),
    );
    const alert = alertFromActive(scored, "Hovězí");
    expect(alert).not.toBeNull();
    expect(alert!.hitType).toBe("fringe");
    const detail = formatStormAlertDetail(alert!, "cs");
    expect(detail).toMatch(/okraj|mine/i);
  });

  it("hlavní věta má sílu a ETA", () => {
    const alert: StormAlert = {
      severity: "strong",
      etaMinutes: 25,
      fromPlace: "Brno",
      toPlace: "Hrozenkov",
      maxDbz: 56,
      atUserDbz: 56,
      hitType: "core",
      rainMmPerHour: [28, 46],
    };
    const msg = formatStormAlert(alert, "cs");
    expect(msg).toMatch(/Silná bouřka/);
    expect(msg).toMatch(/25/);
    expect(msg).toMatch(/Hrozenkov/);
  });

  it("hero: síla · zásah · mm/h před příchodem", () => {
    const alert: StormAlert = {
      severity: "strong",
      etaMinutes: 25,
      fromPlace: "Brno",
      toPlace: "Hrozenkov",
      maxDbz: 56,
      atUserDbz: 56,
      hitType: "core",
      rainMmPerHour: [28, 46],
    };
    const hero = formatStormAlertHero(alert, "cs");
    expect(hero).toMatch(/Silná bouřka/);
    expect(hero).toMatch(/zásah jádra/i);
    expect(hero).toMatch(/28–46 mm\/h|28-46 mm\/h/);
  });

  it("EN hit labels existují", () => {
    const alert: StormAlert = {
      severity: "moderate",
      etaMinutes: 40,
      fromPlace: "A",
      toPlace: "B",
      hitType: "fringe",
      atUserDbz: 45,
      maxDbz: 55,
      rainMmPerHour: [10, 17],
    };
    const detail = formatStormAlertDetail(alert, "en");
    expect(detail).toMatch(/fringe|miss/i);
  });
});
