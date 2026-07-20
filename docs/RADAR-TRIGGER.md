# Spolehlivá obnova radaru (≤ 7 min)

GitHub Actions `schedule` **sám o sobě nestačí** — běhy se vynechávají (15–30 min mezery).  
Cíl **5–7 min** od snímku vyžaduje **Cloudflare Cron Worker**, který každých 5 min spustí workflow **Live radar**.

```
Cloudflare Cron (*/5) → GitHub workflow_dispatch → fetch OPERA+ČHMÚ → R2 → kraller.eu (poll 30 s)
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

Worker má cron **`*/5 * * * *`** (UTC). Po deployi:

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
| Actions → **Live radar** | nový běh cca každých 5 min |
| `https://pub-xxx.r2.dev/data/meta.json` | `updatedAt` do ~7 min od teď |
| kraller.eu SyncStatus | „Aktualizace · před 0–5 min“ |

---

## 4. Co dělají jednotlivé části

| Část | Úloha |
|------|--------|
| **Cloudflare Worker** | spolehlivý trigger každých 5 min |
| **Live radar** (GHA) | stáhne data, nahraje R2 |
| **Radar watchdog** (GHA) | záloha — meta > 7 min → dispatch |
| **GitHub schedule** (2× cron) | další záloha, když Worker vypadne |
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
| Worker neběží | Cloudflare → Workers → Triggers; `wrangler tail` |
| Dispatch 401/403 | Token musí mít **Actions: Read and write** |
| meta pořád staré | Actions log Live radar — OPERA/CHMI fetch fail |
| CORS v prohlížeči | R2 bucket CORS `"AllowedOrigins": ["*"]` |
