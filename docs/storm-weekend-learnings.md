# Poznatky z bouřkového víkendu (červenec 2026)

Terénní ověření u lokality uživatele (oblast Vsetín / Nový Hrozenkov). Základ pro kalibraci Kralleru.

## Co fungovalo

- **Pozice jádra vs okraje** sedí s realitou: jádro nad námi = vydatný krátký déšť; jádro minulo = jen slabý déšť.
- Až byla buňka **ustálená**, radarová stopa byla přesná (Ústí → Hovězí / Alenkov → Hrozenkov).

## Co nefungovalo / chybí

| Poznatek | Důsledek pro produkt |
|----------|----------------------|
| Oranžové jádro neřekne sílu (48 vs 58 dBZ) | Lidská síla + **mm/h** + zásah jádro/okraj u adresy **předem** |
| Fialové „zesílení“ → často zánik | Text „může zesílit“, vyšší práh, vypnout při klesajícím dBZ |
| Jádro skáče v buňce, ne přímka | Koridor nejistoty; šipka = systém; peak ≠ jistá dráha |
| Vznik mimo zobrazené zóny (AT → JČ → Brno → VS) | Čerstvější env, víc než ~8 kruhů, formation nesmí zaostávat za radarem |
| Růst: pohyb jádra ≠ čistý vítr | Propagace / výtok / terén; vítr až u vyzrálé buňky |

## Cíl „být nejlepší“

1. Rychlejší data (vítr + formation + radar v jednom taktu)
2. Přesnější tracking (koridor, ne chaotický peak)
3. Predikce na minuty dopředu (síla u tebe, možné zesílení, možný vznik)
4. Kalibrace z `public/data/learning` po sběru (~2+ dny bouřek)

## Jde předpovědět vznik / zesílení dřív, než je pozdě?

**Částečně ano — ale ne z radaru samotného.**

- Radar vidí až **echo**. Předtím potřebujeme **prostředí** (CAPE, vlhkost, shear) + ideálně **ochlazování vrcholu** / satelitní proxy, obnovované stejně často jako radar.
- Teď máme zárodky (formation grid, fialové zóny), ale: málo zón na mapě, často stará data, zesílení přehnaně jisté.
- Cesta: čerstvý env → pravděpodobnostní vznik/zesílení → radar potvrdí a zpřesní.

## Proces

- Push celého balíku až když řekneme „hotovo“ — ne po každé drobnosti.
- **Kalibraci konstant děláme až po** vyřešení: stejný takt vzniku/zesílení s radarem, síla u adresy, poctivá fialová, tracking koridor. Learning zatím může sbírat na pozadí.

## Pořadí prací

1. Vznik + env (zesílení) ve **stejném taktu jako radar** — DONE
2. Síla u sledované adresy (jádro/okraj, mm/h) — DONE (watch „Čekej: zásah jádra/okraj · mm/h“)
3. Poctivější fialové zóny — DONE („může zesílit“, vyšší prahy, suppress při slábnutí)
4. Vznik méně slepý v UI — DONE (až 14 zón, grid tečky od score 22)
5. Koridor jádra / tracking — DONE (pás kolem stopy)
6. **Teprve potom** kalibrace z learning store
