# Spolehlivá obnova radaru (≤ 7 min)

GitHub Actions `schedule` **sám o sobě nestačí** — běhy se vynechávají (15–30 min mezery).  
Cíl **~3–5 min** od snímku (limit zdroje ~5 min) — **Cloudflare Cron Worker** každých 2 min spustí **Live radar** (debounce ~4 min).

```
Cloudflare Cron (*/2) → Live radar (meta ≤ ~7 min; fast-path PNG dřív)
                     → Live sat když cooling.json > ~22 min
Live sat schedule (*/20)  → záloha (nespolehlivé stejně jako dřív u radaru)
Radar watchdog (*/3)      → meta > 7 min → Live radar; cooling > 25 min → Live sat
```

Záloha: workflow **Radar watchdog** (každé 3 min) — když `meta.updatedAt` na R2 > 7 min, spustí Live radar znovu.

---

## 1. GitHub token pro Worker (~3 min)

1. GitHub → **Settings** → **Developer settings** → **Fine-grained tokens** → **Generate**
2. Repository access: **Only HanBlack/kraller**
3. Permissions: **Actions → Read and write**
4. Ulož token (zobrazí se jednou)

---

## 2. Deploy Cloudflare Worker (~5 min)

Potřebuješ [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Node.js):

```bash
cd workers/radar-trigger
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
# vlož fine-grained token z kroku 1

# volitelně — ruční test GET /trigger
npx wrangler secret put TRIGGER_SECRET

npm run deploy
```

Worker má cron **`*/2 * * * *`** (UTC). Po deployi:

- Cloudflare dashboard → **Workers** → `kraller-radar-trigger` → **Triggers** → měl by být cron
- Logs: `npm run tail` nebo dashboard → **Logs**

### Ruční test

```bash
curl -H "Authorization: Bearer <TRIGGER_SECRET>" https://kraller-radar-trigger.<tvůj-subdomain>.workers.dev/trigger
```

→ v GitHub **Actions** by se měl objevit běh **Live radar**.

---

## 3. Ověření provozu

| Kontrola | Očekávání |
|----------|-----------|
| Actions → **Live radar** | nový běh když meta zestárne (cron */2 + debounce) |
| `https://pub-xxx.r2.dev/data/meta.json` | `updatedAt` do ~7 min od teď |
| kraller.eu SyncStatus | „Aktualizace · před 0–5 min“ |

---

## 4. Co dělají jednotlivé části

| Část | Úloha |
|------|--------|
| **Cloudflare Worker** | spolehlivý trigger každých 2 min (+ FRESH_MIN debounce) |
| **Live radar** (GHA) | stáhne data, nahraje R2 |
| **Radar watchdog** (GHA) | záloha — meta > 7 min → dispatch |
| **GitHub schedule** (*/10) | záloha, když Worker vypadne |
| **Stránka** | poll každých 30 s + R2 CORS |

---

## 5. Proč může být radar v UI „starší než sync“

- **Aktualizace · před X min** = kdy worker naposledy nahrál (`meta.updatedAt`)
- **Radar ČHMÚ · (Y min)** = stáří **snímku** (ČHMÚ vydává po ~5 min)

I při perfektním triggeru bývá Y **3–8 min** — to je limit zdroje, ne chyba pipeline.

---

## 6. Troubleshooting

| Problém | Řešení |
|---------|--------|
| Git backup `push rejected (fetch first)` | R2 je už nahrané — git backup je `continue-on-error` + `pull --rebase` před push |
| Actions „Canceling…“ / data >10 min stará | Sat je oddělený (`live-sat.yml`); radar job nesmí cancelovat uprostřed uploadu |

| Data „pozdě“ / fronta běhů | Debounce: skip když R2 meta < 4 min; Worker + workflow gate |
| Worker neběží | Cloudflare → Workers → Triggers; `wrangler tail` |
| Dispatch 401/403 | Token musí mít **Actions: Read and write** |
| meta pořád staré | Actions log Live radar — OPERA/CHMI fetch fail |
| CORS v prohlížeči | R2 bucket CORS `"AllowedOrigins": ["*"]` |
