import { useEffect, useRef, useState, type FormEvent } from "react";

import { LanguageToggle } from "./LanguageToggle";

import { useI18n } from "../i18n";

import {

  geocodeCzechAddress,

  suggestCzechAddresses,

} from "../lib/geocode";

import type { UserLocation } from "../types";



type Props = {
  location: UserLocation | null;
  onLocated: (loc: UserLocation) => void;
  /** Skryje nadpis a úvodní text — méně místa v postranním panelu. */
  compact?: boolean;
};

export function AddressPanel({ location, onLocated, compact = false }: Props) {

  const { t } = useI18n();

  const [query, setQuery] = useState("");

  const [loading, setLoading] = useState(false);

  const [geoLoading, setGeoLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<UserLocation[]>([]);

  const [openSuggest, setOpenSuggest] = useState(false);

  const debounceRef = useRef<number | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);



  useEffect(() => {

    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    const q = query.trim();

    if (q.length < 2) {

      setSuggestions([]);

      return;

    }

    debounceRef.current = window.setTimeout(() => {

      void (async () => {

        try {

          const hits = await suggestCzechAddresses(q, 5);

          setSuggestions(hits);

          setOpenSuggest(true);

        } catch {

          setSuggestions([]);

        }

      })();

    }, 280);

    return () => {

      if (debounceRef.current) window.clearTimeout(debounceRef.current);

    };

  }, [query]);



  useEffect(() => {

    const onDoc = (e: MouseEvent) => {

      if (!wrapRef.current?.contains(e.target as Node)) {

        setOpenSuggest(false);

      }

    };

    document.addEventListener("mousedown", onDoc);

    return () => document.removeEventListener("mousedown", onDoc);

  }, []);



  async function locateQuery(q: string) {

    setLoading(true);

    setError(null);

    setOpenSuggest(false);

    try {

      const result = await geocodeCzechAddress(q);

      if (!result) {

        setError(t("address.notFound"));

        return;

      }

      setQuery(result.placeName);

      onLocated(result);

    } catch {

      setError(t("address.searchFailed"));

    } finally {

      setLoading(false);

    }

  }



  async function onSubmit(e: FormEvent) {

    e.preventDefault();

    if (!query.trim()) return;

    await locateQuery(query);

  }



  function pickSuggestion(loc: UserLocation) {

    setQuery(loc.placeName);

    setSuggestions([]);

    setOpenSuggest(false);

    setError(null);

    onLocated(loc);

  }



  async function useMyPosition() {

    if (!navigator.geolocation) {

      setError(t("address.geoUnsupported"));

      return;

    }

    setGeoLoading(true);

    setError(null);

    try {

      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {

        navigator.geolocation.getCurrentPosition(resolve, reject, {

          enableHighAccuracy: true,

          timeout: 12_000,

        });

      });

      const { latitude: lat, longitude: lon } = pos.coords;

      const loc: UserLocation = {

        label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,

        placeName: t("location.myLocation"),

        lat,

        lon,

      };

      setQuery(loc.placeName);

      onLocated(loc);

    } catch {

      setError(t("address.geoFailed"));

    } finally {

      setGeoLoading(false);

    }

  }



  return (

    <section className={`panel address-panel${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <h1>Kraller</h1>
          <LanguageToggle compact />
        </div>
      )}

      {!compact && <p className="lead">{t("address.lead")}</p>}



      <form onSubmit={onSubmit} className="address-form">

        <label htmlFor="address">{t("address.label")}</label>

        <div className="address-search" ref={wrapRef}>

          <div className="row">

            <input

              id="address"

              value={query}

              onChange={(e) => setQuery(e.target.value)}

              onFocus={() => suggestions.length > 0 && setOpenSuggest(true)}

              autoComplete="off"

              disabled={loading || geoLoading}

            />

            <button type="submit" disabled={loading || geoLoading || !query.trim()}>

              {loading ? t("address.searching") : t("address.search")}

            </button>

          </div>

          {openSuggest && suggestions.length > 0 && (

            <ul className="address-suggest" role="listbox">

              {suggestions.map((s) => (

                <li key={`${s.lat}-${s.lon}-${s.label}`}>

                  <button

                    type="button"

                    onClick={() => pickSuggestion(s)}

                  >

                    <span className="suggest-name">{s.placeName}</span>

                    <span className="suggest-label">{s.label}</span>

                  </button>

                </li>

              ))}

            </ul>

          )}

        </div>

        <button

          type="button"

          className="geo-btn"

          onClick={() => void useMyPosition()}

          disabled={loading || geoLoading}

        >

          {geoLoading ? t("address.geoLoading") : t("address.geo")}

        </button>

      </form>



      {error && <p className="status error">{error}</p>}

      {location && !error && (

        <p className="status ok">

          {t("address.watching")} <strong>{location.placeName}</strong>

          <span className="coords">

            {location.lat.toFixed(4)}°, {location.lon.toFixed(4)}°

          </span>

        </p>

      )}

    </section>

  );

}

