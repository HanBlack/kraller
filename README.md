# Kraller — bouřky v ČR

Interaktivní mapa (**Kraller**) s reálným radarem OPERA, trackováním buněk, větrem (Open-Meteo) a potenciálem vzniku bouřek.

## Architektura (bez databáze)

Aplikace je **čistý statický frontend** — žádná DB, žádný backend za běhu.

```
┌─────────────────┐     fetch JSON/GeoJSON      ┌──────────────────────┐
│  Prohlížeč      │ ──────────────────────────► │  Statické soubory    │
│  (React/Vite)   │   /data/opera/*.geojson     │  na kraller.eu        │
│                 │   /data/wind/*.json         │  (dist/ po buildu)   │
│                 │   /data/formation/*.json    └──────────┬───────────┘
└─────────────────┘                                        │
                                              generuje každých 5 min
                                                           │
                                                ┌──────────▼───────────┐
                                                │  Python skripty      │
                                                │  (GitHub Actions     │
                                                │   nebo cron na VPS)  │
                                                └──────────────────────┘
```

**Prohlížeč data nestahuje z OPERA/Open-Meteo přímo** — radar potřebuje Python (HDF5, scipy). Proto:

1. Skripty stáhnou a zpracují data → `public/data/`
2. `npm run build` zkopíruje data do `dist/data/`
3. Hosting na **kraller.eu** servíruje `dist/` jako statické soubory
4. Frontend každých **5 minut** znovu načte JSON (cache-bust)

## Lokální vývoj

```bash
npm install
pip install -r requirements.txt

# Jednorázově nebo před testem reálných dat:
npm run data:update

npm run dev
```

## Nasazení na kraller.eu (jen DNS u českého hostingu)

Hosting běží na **GitHub Pages** (zdarma). U českého hostingu nastavíš **jen DNS** — žádný FTP, žádné nahrávání souborů.

### 1. GitHub repo

1. Vytvoř repo na GitHubu (např. `kraller`)
2. Nahraj projekt a pushni na větev `main`
3. **Settings → Pages → Build and deployment → Source:** `GitHub Actions`
4. **Settings → Pages → Custom domain:** `kraller.eu` (zaškrtni HTTPS po ověření DNS)

### 2. DNS u českého hostingu (jen A + AAAA)

Smaž staré A/AAAA záznamy pro `@` / `kraller.eu`, které míří na webhosting.

**A záznamy** (4×, host `@` nebo prázdný):

| Typ | Host | Hodnota |
|-----|------|---------|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

**AAAA záznamy** (4×):

| Typ | Host | Hodnota |
|-----|------|---------|
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

Volitelně **www** → CNAME na `TVOJE-USERNAME.github.io`

DNS propagace: obvykle 15 min – 24 h.

### 3. Automatická aktualizace na stránce

Workflow **Publish site** (`publish-site.yml`) běží při pushi i **každých 5 min**:
1. Stáhne OPERA + vítr + vznik (`npm run data:update`)
2. Sestaví `dist/`
3. Nasadí na GitHub Pages → **kraller.eu**

Prohlížeč pak každých 5 min znovu načte JSON (cache-bust). Lokální `data:watch` je jen pro vývoj.

```bash
npm run build
# obsah dist/ — jen pro test, produkce jde přes GitHub Actions
```

### Varianta B — podsložka (nepotřebuješ pro kraller.eu)

`https://kraller.eu/app/` → build s base path:

```bash
VITE_BASE_PATH=/app/ npm run build
```

### Varianta C — cron na VPS (jen pokud máš server)

```cron
*/5 * * * * cd /var/www/radar && npm run data:update && cp -r public/data dist/data/
```

## Skripty

| Příkaz | Popis |
|--------|-------|
| `npm run data:update` | OPERA + vítr + vznik + verify + kalibrace |
| `npm run data:calibrate` | Backtest stop/ETA/vznik → `calibration/last_report.json` |
| `npm run data:verify` | Kontrola dat + guardy + skill report |
| `npm run dev` | Vývoj na localhost:5173 |
| `npm run build` | Produkční build do `dist/` |

## Data

| Soubor | Zdroj | Interval |
|--------|-------|----------|
| `data/opera/latest.geojson` | EUMETNET OPERA | ~5 min |
| `data/opera/cells.geojson` | OPERA + tracking | ~5 min |
| `data/wind/*.json` | Open-Meteo | ~15 min |
| `data/formation/grid.json` | Open-Meteo | ~15 min |
| `data/opera/archive/` | Rolling peaky (~3 h) pro kalibraci | po OPERA |
| `data/calibration/last_report.json` | Backtest skill (stopy/ETA/vznik) | po calibrate |
| `data/meta.json` | čas poslední aktualizace | po každém `data:update` |

## Licence dat

- OPERA radar: CC BY 4.0 (EUMETNET)
- Open-Meteo: CC BY 4.0
