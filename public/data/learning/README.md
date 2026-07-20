# Learning store — kalibrační dataset (schema v2+)

Každý běh **Live radar** (~5 min) appenduje learning. Hodinový workflow dělá zálohu + `propose_calibration`.

| Soubor | Obsah |
|--------|--------|
| `events-YYYY-MM.jsonl` | run, birth, track_sample, demise, formation_zone/hit |
| `samples-YYYY-MM.jsonl` | track / formation / birth_features / intensity / **intensify** / demise |
| `state.json` | živé tracky + pending formation + intensity + **purple** |

## Co se sbírá (pro ladění za ~2 dny)

### Směr a rychlost
- radar / wind / observed heading+speed
- `windAlignDeg`, `segmentJitterDeg`, `motionSource`
- ověření T+15/T+30: `errKm`, `alongErrKm`, `crossErrKm`, `headingErrDeg`, `speedErrKmh`
- **ČHMÚ FCT**: `fctAgree`, `fctAngleDiffDeg` (vs stopa)

### Síla / déšť / kroupy
- `maxDbz`, `growthDbz`, `surfaceDbz` (PseudoCAPPI), `echoTopKm`
- `hailCmProxy` (+ `freezingLevelM` z env)
- intensity samples: predikce dBZ → realita

### Upřímná fialová
- `purpleCandidate` na track_sample
- sample `type=intensify`: `hitIntensify` / `outcome` po T+15/30

### Zrod / zánik / vznik
- birth prahy, demise reason + lifeMin (+ hail/purple flags)
- formation hit/miss + CAPE/shear/**CIN**/FZL

### Reprodukovatelnost
- každý `run` nese snapshot `constants` (včetně hail / FCT / intensify)

## Po ~2 dnech bouřek

```bash
npm run data:learning-summary
npm run data:propose-calibration
```

→ `public/data/calibration/proposal.json`

Návrhy mimo jiné:
- `MAX_WIND_ALIGN_DEG`, birth, `MIN_ZONE_SCORE`, speed bias
- `FCT_AGREE_MAX_DEG` → `scripts/chmi_radar.py`
- `intensification.alertScoreMin` → `src/storm/config.ts`
- `active.hail.minAboveFreezingKm` → `src/storm/config.ts`

`readyForApply` až je dost track + formation (+ intensify) samples. **Ruční review** před propsáním — žádný auto-apply.

## Retence

- Archive peaků ~6 h (ověření T+15/30)
- Learning JSONL **neřeže** — měsíční soubory
