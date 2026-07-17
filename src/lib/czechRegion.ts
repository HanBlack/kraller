import { t, type Locale } from "../i18n";
import { destinationPoint } from "./geo";

/**
 * Hrubý bbox ČR (+ volitelný okraj). Ne polygon — stačí pro pojmenování a filtr zón.
 * Jižní okraj ~48.55 (Břeclavsko); Vídeň (~48.2) je záměrně mimo.
 */
export function isInCzechiaApprox(
  lat: number,
  lon: number,
  marginKm = 0,
): boolean {
  const dLat = marginKm / 111;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = marginKm / Math.max(40, 111 * Math.abs(cos));
  return (
    lat >= 48.55 - dLat &&
    lat <= 51.1 + dLat &&
    lon >= 12.05 - dLon &&
    lon <= 18.9 + dLon
  );
}

function abroadRegionKey(lat: number, lon: number): string {
  if (lat < 48.55 && lon >= 14.6 && lon <= 17.4) {
    if (lat >= 48.0 && lon >= 15.8 && lon <= 16.8) return "region.vienna";
    return "region.lowerAustria";
  }
  if (lat < 48.55 && lon >= 12.8 && lon < 14.6) return "region.upperAustria";
  if (lat < 48.3 && lon >= 15.5 && lon <= 17.2) return "region.austria";

  if (lon > 18.9 || (lon > 17.6 && lat < 49.6 && !isInCzechiaApprox(lat, lon))) {
    if (lat >= 48.5 && lat <= 49.4 && lon <= 19.5) return "region.westernSlovakia";
    return "region.slovakia";
  }

  if (lon < 12.05 || (lon < 12.9 && lat < 50.2)) {
    if (lat >= 48.8 && lat <= 50.2) return "region.bavaria";
    if (lat >= 50.2) return "region.saxony";
    return "region.germany";
  }

  if (lat > 51.05 || (lat > 50.4 && lon > 16.5 && lon < 19.2 && lat > 50.55)) {
    return "region.poland";
  }

  if (lat < 48.0 && lon >= 16.0) return "region.hungary";

  return "region.outside";
}

function czechRegionKey(lat: number, lon: number): string {
  if (!isInCzechiaApprox(lat, lon, 8)) {
    return abroadRegionKey(lat, lon);
  }

  if (lat >= 49.25 && lat <= 49.78 && lon >= 17.9 && lon <= 19.15) {
    return "region.beskydy";
  }
  if (lat >= 49.9 && lat <= 50.35 && lon >= 16.85 && lon <= 17.7) {
    return "region.jeseniky";
  }
  if (lat >= 50.45 && lon >= 14.9 && lon <= 15.6) return "region.krkonose";
  if (lat >= 50.35 && lon >= 12.9 && lon <= 13.8) return "region.krusne";
  if (lat >= 50.55 && lon >= 14.8 && lon <= 15.4) return "region.jizerske";
  if (lat >= 50.15 && lat <= 50.55 && lon >= 15.9 && lon <= 16.7) {
    return "region.orlicke";
  }
  if (lat >= 49.0 && lat <= 49.45 && lon >= 12.9 && lon <= 13.7) {
    return "region.sumava";
  }
  if (lat >= 49.55 && lat <= 49.95 && lon >= 12.5 && lon <= 13.3) {
    return "region.ceskyles";
  }
  if (lat >= 49.7 && lat <= 50.15 && lon >= 18.0 && lon <= 18.7) {
    return "region.ostravsko";
  }
  if (lat >= 49.1 && lat <= 49.45 && lon >= 17.3 && lon <= 18.2) {
    return "region.valassko";
  }
  if (lat >= 48.55 && lat <= 49.35 && lon >= 16.3 && lon <= 17.2) {
    return "region.southMoravia";
  }
  if (lat >= 48.55 && lat <= 49.2 && lon >= 14.0 && lon <= 15.3) {
    return "region.southBohemia";
  }
  if (lat >= 49.2 && lat <= 49.7 && lon >= 15.3 && lon <= 16.3) {
    return "region.vysocina";
  }
  if (lat >= 49.9 && lat <= 50.35 && lon >= 14.9 && lon <= 16.0) {
    return "region.eastBohemia";
  }
  if (lat >= 50.0 && lon <= 14.5) return "region.northBohemia";
  if (lat >= 49.6 && lon <= 14.2) return "region.westBohemia";
  if (lon >= 17.2 && lat >= 48.9) return "region.eastMoravia";
  if (lat <= 49.15 && lon >= 15.5) return "region.southMoravia";
  if (lat <= 49.15) return "region.southBohemia";
  if (lat >= 50.2) return "region.northEastBohemia";
  return "region.centralBohemia";
}

/**
 * Název oblasti pro mapové popisky (zóny Vznik, buňky).
 */
export function czechRegionLabel(
  lat: number,
  lon: number,
  locale?: Locale,
): string {
  return t(czechRegionKey(lat, lon), undefined, locale);
}

/**
 * Má zóna vzniku smysl pro ČR?
 * Ano, pokud je v/u ČR, nebo steering za horizont ji posune do ČR.
 */
export function pathReachesCzechia(
  lat: number,
  lon: number,
  headingDeg: number,
  speedKmh: number,
  horizonMin = 90,
  stepMin = 12,
): boolean {
  if (isInCzechiaApprox(lat, lon, 25)) return true;
  const spd = Math.max(5, speedKmh);
  const steps = Math.max(1, Math.ceil(horizonMin / stepMin));
  for (let i = 1; i <= steps; i++) {
    const km = (spd * i * stepMin) / 60;
    const [nlon, nlat] = destinationPoint(lat, lon, headingDeg, km);
    if (isInCzechiaApprox(nlat, nlon, 18)) return true;
  }
  return false;
}
