/** Meta pro MapLibre image source — spojitý OPERA raster. */
export type RadarRasterMeta = {
  url: string;
  /** TL, TR, BR, BL [lon, lat] */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  time?: string;
  minDbz?: number;
};
