# Learning store — kalibrační dataset (schema v2)

Každý běh Live radar / `data:update` appenduje do:

| Soubor | Obsah |
|--------|--------|
| `events-YYYY-MM.jsonl` | run, birth, track_sample, demise, formation_zone/hit |
| `samples-YYYY-MM.jsonl` | track / formation / birth_features / intensity / demise |
| `state.json` | živé tracky + pending formation + pending intensity |

## Co se sbírá (vše pro pozdější přesnou kalibraci)

### Směr a rychlost
- radar / wind / observed heading+speed
- `windAlignDeg`, `segmentJitterDeg`, `motionSource`
- ověření T+15/T+30: `errKm`, **`alongErrKm`**, **`crossErrKm`**, `headingErrDeg`, `speedErrKmh`
- stáří dat: `operaAgeMin`, `windAgeMin`, `formationAgeMin`

### Síla
- `maxDbz`, `growthDbz`, `dbzDelta5/15`, `dbzSlopePer15`, `areaPx`
- intensity samples: predikce dBZ → realita (`errDbz`) + env (CAPE/shear)

### Zrod
- `birthDbz`, `growthDbz`, `ageMin`, labely `trueBirth` / `isNewborn`
- `birth_features` sample + env u buňky

### Zánik
- `lifeMin`, `demiseReason` (`fade` / `exit` / `merge_or_jump`)
- trend dBZ před zmizením

### Vznik
- zóna: score, CAPE, shear, dew, LI, cooling, SRH
- hit/miss + lead time + distKm

### Reprodukovatelnost
- každý `run` event nese snapshot `constants` (aktivní prahy)

## Po ~2 dnech bouřek

```bash
npm run data:learning-summary
npm run data:propose-calibration
```

`propose-calibration` → `public/data/calibration/proposal.json`  
s návrhy: `MAX_WIND_ALIGN_DEG`, `MAX_SEGMENT_JITTER_DEG`, `TRUE_BIRTH_MAX_DBZ`, `MIN_ZONE_SCORE`, speed bias.

Pak propsat do `src/storm/stormTrackRules.ts` (+ zrcadlo v `emit_learning.ACTIVE_CONSTANTS`).

## Retence

- Archive peaků ~6 h (ověření T+15/30)
- Learning JSONL **neřeže** — měsíční soubory
