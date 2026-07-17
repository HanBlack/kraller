import { t } from "../i18n";
import type { UserLocation } from "../types";

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  address?: {
    village?: string;
    town?: string;
    city?: string;
    municipality?: string;
    suburb?: string;
    hamlet?: string;
    county?: string;
  };
};

function shortPlaceName(hit: NominatimResult): string {
  const a = hit.address;
  return (
    a?.village ||
    a?.town ||
    a?.city ||
    a?.municipality ||
    a?.hamlet ||
    a?.suburb ||
    hit.name ||
    hit.display_name.split(",")[0]?.trim() ||
    t("location.myLocation")
  );
}

function toUserLocation(hit: NominatimResult): UserLocation {
  return {
    label: hit.display_name,
    placeName: shortPlaceName(hit),
    lat: Number(hit.lat),
    lon: Number(hit.lon),
  };
}

async function nominatimSearch(
  query: string,
  limit: number,
): Promise<NominatimResult[]> {
  const q = query.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "1",
    limit: String(limit),
    countrycodes: "cz",
  });

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    throw new Error("Geokódování selhalo");
  }

  return (await res.json()) as NominatimResult[];
}

/** Geokódování adresy / obce v ČR přes Nominatim (OpenStreetMap). */
export async function geocodeCzechAddress(
  query: string,
): Promise<UserLocation | null> {
  const data = await nominatimSearch(query, 1);
  const hit = data[0];
  if (!hit) return null;
  return toUserLocation(hit);
}

/** Návrhy obcí / adres pro autocomplete. */
export async function suggestCzechAddresses(
  query: string,
  limit = 5,
): Promise<UserLocation[]> {
  if (query.trim().length < 2) return [];
  const data = await nominatimSearch(query, limit);
  const seen = new Set<string>();
  const out: UserLocation[] = [];
  for (const hit of data) {
    const loc = toUserLocation(hit);
    const key = `${loc.placeName}|${loc.lat.toFixed(3)}|${loc.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}
