/** Pravidelná mřížka větru (u = na východ, v = na sever) v m/s. */
export type WindGrid = {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  u: Float32Array;
  v: Float32Array;
};

export type WindSample = {
  u: number;
  v: number;
  speed: number;
};

function idx(cols: number, x: number, y: number): number {
  return y * cols + x;
}

/** Bilineární vzorek z mřížky. */
export function sampleWind(
  grid: WindGrid,
  lon: number,
  lat: number,
): WindSample | null {
  if (
    lon < grid.west ||
    lon > grid.east ||
    lat < grid.south ||
    lat > grid.north
  ) {
    return null;
  }

  const x = ((lon - grid.west) / (grid.east - grid.west)) * (grid.cols - 1);
  const y = ((lat - grid.south) / (grid.north - grid.south)) * (grid.rows - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, grid.cols - 1);
  const y1 = Math.min(y0 + 1, grid.rows - 1);
  const tx = x - x0;
  const ty = y - y0;

  const u00 = grid.u[idx(grid.cols, x0, y0)];
  const u10 = grid.u[idx(grid.cols, x1, y0)];
  const u01 = grid.u[idx(grid.cols, x0, y1)];
  const u11 = grid.u[idx(grid.cols, x1, y1)];
  const v00 = grid.v[idx(grid.cols, x0, y0)];
  const v10 = grid.v[idx(grid.cols, x1, y0)];
  const v01 = grid.v[idx(grid.cols, x0, y1)];
  const v11 = grid.v[idx(grid.cols, x1, y1)];

  const u =
    u00 * (1 - tx) * (1 - ty) +
    u10 * tx * (1 - ty) +
    u01 * (1 - tx) * ty +
    u11 * tx * ty;
  const v =
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty;

  return { u, v, speed: Math.hypot(u, v) };
}

function buildGrid(
  cols: number,
  rows: number,
  fill: (lon: number, lat: number, i: number, j: number) => { u: number; v: number },
): WindGrid {
  const west = 11.4;
  const east = 19.6;
  const south = 47.8;
  const north = 51.4;
  const u = new Float32Array(cols * rows);
  const v = new Float32Array(cols * rows);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const lon = west + (i / (cols - 1)) * (east - west);
      const lat = south + (j / (rows - 1)) * (north - south);
      const w = fill(lon, lat, i, j);
      const k = idx(cols, i, j);
      u[k] = w.u;
      v[k] = w.v;
    }
  }

  return { west, south, east, north, cols, rows, u, v };
}

/** Demo: slabší SW–W proudění u země. */
export function createDemoWindLow(): WindGrid {
  return buildGrid(36, 22, (lon, lat) => {
    const nx = (lon - 15.5) / 4;
    const ny = (lat - 49.7) / 2;
    const speed = 6 + 3.5 * Math.sin(nx * 1.4) + 2 * Math.cos(ny * 2.1);
    const dirDeg = 240 + 25 * Math.sin(nx * 0.9) - 12 * ny;
    const rad = (dirDeg * Math.PI) / 180;
    return {
      u: Math.sin(rad) * speed,
      v: Math.cos(rad) * speed,
    };
  });
}

/** Demo: silnější západní proudění ve výšce. */
export function createDemoWindUpper(): WindGrid {
  return buildGrid(36, 22, (lon, lat) => {
    const nx = (lon - 15.5) / 4;
    const ny = (lat - 49.7) / 2;
    const speed = 16 + 6 * Math.sin(nx * 0.8 + 0.4) + 3 * Math.cos(ny * 1.3);
    const dirDeg = 265 + 18 * Math.sin(nx * 0.7) + 8 * Math.sin(ny * 1.5);
    const rad = (dirDeg * Math.PI) / 180;
    return {
      u: Math.sin(rad) * speed,
      v: Math.cos(rad) * speed,
    };
  });
}

/** Deep-layer steering (~jako Windy u bouřek): 35 % 850 hPa + 65 % 500 hPa. */
export function stormSteeringMotion(
  low: WindGrid | null,
  upper: WindGrid | null,
  lon: number,
  lat: number,
): { headingDeg: number; speedKmh: number } {
  const wL = low ? sampleWind(low, lon, lat) : null;
  const wU = upper ? sampleWind(upper, lon, lat) : null;

  let u = 0;
  let v = 0;
  if (wL && wL.speed >= 0.4 && wU && wU.speed >= 0.4) {
    u = 0.35 * wL.u + 0.65 * wU.u;
    v = 0.35 * wL.v + 0.65 * wU.v;
  } else if (wU && wU.speed >= 0.4) {
    u = wU.u;
    v = wU.v;
  } else if (wL && wL.speed >= 0.4) {
    u = wL.u;
    v = wL.v;
  } else {
    return { headingDeg: 270, speedKmh: 28 };
  }

  const headingDeg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  // Bouřky typicky o něco pomalejší než čistý vítr
  const speedKmh = Math.max(6, Math.min(75, Math.hypot(u, v) * 3.6 * 0.9));
  return { headingDeg, speedKmh };
}

export type WindLayerMode = "off" | "low" | "upper" | "steer";

/** Mřížka pro particles = stejný steering jako trajektorie bouřek. */
export function blendSteeringGrid(low: WindGrid, upper: WindGrid): WindGrid {
  const n = low.cols * low.rows;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = 0.35 * low.u[i] + 0.65 * upper.u[i];
    v[i] = 0.35 * low.v[i] + 0.65 * upper.v[i];
  }
  return {
    west: low.west,
    south: low.south,
    east: low.east,
    north: low.north,
    cols: low.cols,
    rows: low.rows,
    u,
    v,
  };
}

export type WindGridJson = {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  level?: string;
  source?: string;
  u: number[];
  v: number[];
};

/** Načte mřížku z JSON (Open-Meteo skript). */
export function windGridFromJson(data: WindGridJson): WindGrid {
  return {
    west: data.west,
    south: data.south,
    east: data.east,
    north: data.north,
    cols: data.cols,
    rows: data.rows,
    u: Float32Array.from(data.u),
    v: Float32Array.from(data.v),
  };
}

import { dataUrl } from "./dataUrls";

const WIND_LOW_URL = "data/wind/low.json";
const WIND_UPPER_URL = "data/wind/upper.json";

/** Reálná data z public/data/wind, jinak demo. */
export async function loadWindGrids(cacheBust?: number): Promise<{
  low: WindGrid;
  upper: WindGrid;
  real: boolean;
}> {
  try {
    const [lowRes, upperRes] = await Promise.all([
      fetch(dataUrl(WIND_LOW_URL, cacheBust), { cache: "no-store" }),
      fetch(dataUrl(WIND_UPPER_URL, cacheBust), { cache: "no-store" }),
    ]);
    if (!lowRes.ok || !upperRes.ok) throw new Error("wind fetch failed");
    const lowJson = (await lowRes.json()) as WindGridJson;
    const upperJson = (await upperRes.json()) as WindGridJson;
    if (!lowJson.u?.length || !upperJson.u?.length) throw new Error("empty wind");
    return {
      low: windGridFromJson(lowJson),
      upper: windGridFromJson(upperJson),
      real: true,
    };
  } catch {
    return {
      low: createDemoWindLow(),
      upper: createDemoWindUpper(),
      real: false,
    };
  }
}
