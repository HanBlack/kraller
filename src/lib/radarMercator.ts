import type { RadarRasterMeta } from "./radarRaster";

const R = 6378137;

export function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = ((lon * Math.PI) / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + ((lat * Math.PI) / 180) / 2)) * R;
  return [x, y];
}

export function mercToLonLat(mx: number, my: number): [number, number] {
  const lon = (mx / R) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

export function mercatorBounds(coords: RadarRasterMeta["coordinates"]) {
  const mercs = coords.map(([lon, lat]) => lonLatToMerc(lon, lat));
  return {
    mxLeft: Math.min(...mercs.map((m) => m[0])),
    mxRight: Math.max(...mercs.map((m) => m[0])),
    myBot: Math.min(...mercs.map((m) => m[1])),
    myTop: Math.max(...mercs.map((m) => m[1])),
  };
}

/** MapLibre image source — lineární UV v Web Mercator, ne v lat/lon. */
export function lonLatToMercatorPixel(
  lon: number,
  lat: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): [number, number] {
  const { mxLeft, mxRight, myBot, myTop } = mercatorBounds(coords);
  const [mx, my] = lonLatToMerc(lon, lat);
  const u = (mx - mxLeft) / Math.max(1e-9, mxRight - mxLeft);
  const v = (myTop - my) / Math.max(1e-9, myTop - myBot);
  return [u * width, v * height];
}

export function mercatorPixelToLonLat(
  px: number,
  py: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): [number, number] {
  const { mxLeft, mxRight, myBot, myTop } = mercatorBounds(coords);
  const u = px / Math.max(1, width);
  const v = py / Math.max(1, height);
  const mx = mxLeft + u * (mxRight - mxLeft);
  const my = myTop - v * (myTop - myBot);
  return mercToLonLat(mx, my);
}

/** Posun o Δlon/Δlat stejně jako advekce PNG (mercator px, ne lineární lat). */
export function shiftLonLatViaMercatorPixels(
  lon: number,
  lat: number,
  dLon: number,
  dLat: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): [number, number] {
  const [px, py] = lonLatToMercatorPixel(lon, lat, coords, width, height);
  const [px2, py2] = lonLatToMercatorPixel(
    lon + dLon,
    lat + dLat,
    coords,
    width,
    height,
  );
  return mercatorPixelToLonLat(px + (px2 - px), py + (py2 - py), coords, width, height);
}
