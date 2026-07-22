import { describe, expect, it } from "vitest";
import {
  formatStormWindDetail,
  formatStormWindMapLine,
  stormWindAtCell,
} from "./stormWindAtCell";
import type { WindGrid } from "../lib/windField";

function grid(uMs: number, vMs: number): WindGrid {
  const cols = 4;
  const rows = 4;
  const n = cols * rows;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  u.fill(uMs);
  v.fill(vMs);
  return {
    west: 10,
    south: 48,
    east: 20,
    north: 52,
    cols,
    rows,
    u,
    v,
  };
}

describe("stormWindAtCell", () => {
  it("vrátí 850 + řízení + pohyb jádra", () => {
    const low = grid(10, 0); // ~36 km/h východ
    const upper = grid(20, 0);
    const w = stormWindAtCell([15, 50], 42, low, upper, {
      capeJkg: 400,
      dewpointC: 14,
      shear0to6Ms: 12,
      srh01: 80,
      cloudTopCoolingCPer15min: -1,
    });
    expect(w.lowSpeedKmh).toBeGreaterThan(30);
    expect(w.steerSpeedKmh).toBeGreaterThan(30);
    expect(w.cellSpeedKmh).toBe(42);
    expect(w.shear0to6Ms).toBe(12);
  });

  it("formátuje poctivé labely (ne Doppler)", () => {
    const lines = formatStormWindDetail({
      lowSpeedKmh: 35,
      steerSpeedKmh: 48,
      cellSpeedKmh: 40,
      shear0to6Ms: 14,
    });
    expect(lines.some((l) => /35/.test(l))).toBe(true);
    expect(lines.join(" ").toLowerCase()).not.toMatch(/doppler/);
    const map = formatStormWindMapLine({
      lowSpeedKmh: 35,
      steerSpeedKmh: 48,
      cellSpeedKmh: 40,
      shear0to6Ms: null,
    });
    expect(map).toMatch(/35/);
    expect(map).toMatch(/40/);
  });
});
