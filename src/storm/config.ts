/**
 * Konfigurace modelu bouřek.
 *
 * Dvě větve (nesmí se míchat do jednoho skóre):
 * 1) FORMATION  — „může tady vzniknout?“ (prostředí / model před echo)
 * 2) ACTIVE     — „už jede a kam?“ (radar + motion + hazard)
 */

export const stormConfig = {
  /** Horizont varování vůči uživateli (minuty). */
  alertHorizonMin: 60,

  /** Tornádo do textu jen nad tímto % (jinak úplně zmizí). */
  tornadoShowThresholdPct: 25,

  /**
   * VZNIK (formation) — prostředí.
   * Bez radaru: CAPE, rosný bod, shear, proxy růstu nestability (ne satelit).
   */
  formation: {
    cape: {
      /**
       * J/kg — prahy pro střední Evropu (přeháňky / slabé bouřky).
       * Open-Meteo CAPE u nás často 20–400; US-style 1500+ tu skoro není.
       */
      weak: 40,
      moderate: 250,
      strong: 700,
      extreme: 1800,
    },
    dewpointC: {
      /** °C — vlhkost u země (klíčová pro přeháňky). */
      weak: 10,
      moderate: 13,
      strong: 16,
    },
    /** 0–6 km shear (m/s) — oddělí „jen déšť“ od supercely. */
    shear0to6Ms: {
      multicell: 6,
      organized: 12,
      supercell: 18,
    },
    /** SRH 0–1 km (m²/s²) — tornado setup. */
    srh01: {
      elevated: 80,
      high: 140,
      extreme: 200,
    },
    /** Satelit: pokles teploty vrcholu mraku (°C / 15 min). */
    cloudTopCoolingCPer15min: {
      growing: 2,
      rapid: 6,
    },
    /** Váhy 0–1, součet nemusí být 1 (normalizuje se). */
    weights: {
      cape: 0.3,
      dewpoint: 0.28,
      shear: 0.22,
      satelliteGrowth: 0.2,
    },
    /** Od kdy hlásit „možný vznik“ (0–100). */
    alertScoreMin: 38,
    /** Tornádo / supercela ve Vzniku jen při dostatečném CAPE. */
    tornadoMinCapeJkg: 500,
    /** Vyšší práh než u Progress — u Vzniku nechceme falešné poplachy. */
    tornadoShowThresholdPct: 50,
  },

  /**
   * BOUŘE V PROGRESU (active) — radar + pohyb.
   */
  active: {
    /** Detekce cell (dBZ). */
    reflectivityDbz: {
      cell: 35,
      moderate: 45,
      strong: 55,
      severe: 60,
    },
    /** Odhad výšky echa z dBZ (proxy, ne radarový ET produkt). */
    echoTopKm: {
      moderate: 8,
      strong: 10,
      severe: 12,
    },
    /** Odhad rizika krup z dBZ + proxy výšky (jen u silného echa). */
    hail: {
      likelyEchoTopKm: 10,
      likelyDbz: 55,
      /** Min. výška echa nad nulovou izotermou (km), když známe FZL. */
      minAboveFreezingKm: 1.5,
      cmFromEchoTop: [
        { minKm: 10, cm: 1 },
        { minKm: 12, cm: 2 },
        { minKm: 14, cm: 4 },
        { minKm: 16, cm: 5 },
      ] as const,
    },
    /** Marshall–Palmer-ish odhad mm/h z dBZ (zjednodušeně). */
    rain: {
      dbzToMmH: [
        { dbz: 35, mmH: 5 },
        { dbz: 45, mmH: 15 },
        { dbz: 50, mmH: 25 },
        { dbz: 55, mmH: 40 },
        { dbz: 60, mmH: 60 },
      ] as const,
    },
    /** Extrapolace pohybu. */
    motion: {
      /** Minuty dopředu, které počítáme. */
      forecastMinutes: [15, 30, 45, 60] as const,
      /** Šířka koridoru nejistoty roste s časem (° / hodina — placeholder). */
      corridorWidenDegPerHour: 0.15,
    },
    /** Hazard skóre — váhy. */
    weights: {
      reflectivity: 0.4,
      echoTop: 0.25,
      motionTowardUser: 0.25,
      environmentBoost: 0.1,
    },
    /** Od kdy pushnout varování vůči uživateli. */
    alertScoreMin: 42,
    /** ETA: hlásit jen když zásah do X minut. */
    etaAlertMaxMin: 75,
  },

  /**
   * ZESÍLENÍ — už viditelná buňka + silnější prostředí před ní.
   * Porovná aktuální dBZ s potenciálem prostředí podél stopy.
   */
  intensification: {
    /** Krok vzorkování stopy (minuty). */
    sampleStepMin: 5,
    /** Minimální skóre prostředí (0–100) pro „palivo“. */
    minEnvScore: 34,
    /** Minimální headroom dBZ (potenciál − aktuál). */
    minHeadroomDbz: 5,
    /** Od kdy kreslit segment koridoru. */
    segmentScoreMin: 32,
    /** Od kdy hlásit zesílení u buňky (vyšší = méně falešných). */
    alertScoreMin: 40,
    /** Růst dBZ po vstupu do zóny (~dBZ za 15 min). */
    growthDbzPer15Min: 7,
    /** Pokles dBZ v nepřátelském prostředí (~dBZ za 15 min). */
    decayDbzPer15Min: 5,
    /** Poloměr vizuálního koridoru (km). */
    corridorHalfWidthKm: 11,
    /** Při klesajícím / plochém echu fialovou nezobrazovat. */
    suppressIfGrowthDbzBelow: -0.5,
  },

  /**
   * Supercela / tornado — jen když ACTIVE + silné prostředí.
   * Tornádo se do UI dostane jen přes tornadoShowThresholdPct.
   */
  severe: {
    supercellScoreMin: 65,
    tornadoScoreMin: 70,
  },
} as const;

export type StormConfig = typeof stormConfig;
