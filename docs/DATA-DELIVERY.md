# Rychlé doručení dat (Cloudflare R2)

Radar se stahuje v GitHub Actions každých **5 min** a nahrává se na **Cloudflare R2**.  
Web čte data z R2 CDN (~5–7 min od snímku), ne z pomalého git raw cache.

## Co uděláš ty (jednorázově, ~15 min)

### 1. Cloudflare účet + R2 bucket

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → **Create bucket**
2. Název např. `kraller-data`
3. Bucket → **Settings** → **Public access** → povolit **R2.dev subdomain**  
   Dostaneš URL typu `https://pub-xxxxxxxx.r2.dev`

### 2. API token pro upload

1. R2 → **Manage R2 API Tokens** → **Create API token**
2. Permission: **Object Read & Write**, scope: bucket `kraller-data`
3. Ulož si: **Access Key ID**, **Secret Access Key**, **Account ID**

### 3. GitHub Secrets (repo → Settings → Secrets → Actions)

| Secret | Hodnota |
|--------|---------|
| `R2_ACCOUNT_ID` | Account ID z Cloudflare |
| `R2_ACCESS_KEY_ID` | z API tokenu |
| `R2_SECRET_ACCESS_KEY` | z API tokenu |
| `R2_BUCKET` | `kraller-data` |
| `R2_PUBLIC_URL` | `https://pub-xxxxxxxx.r2.dev` (bez lomítka na konci) |
| `VITE_DATA_ROOT` | stejné jako `R2_PUBLIC_URL` + `/` |

Příklad `VITE_DATA_ROOT`: `https://pub-abc123.r2.dev/`

### 4. Redeploy webu

Po nastavení secrets spusť **Publish site** (workflow_dispatch) nebo pushni změnu kódu.  
Build musí dostat `VITE_DATA_ROOT`, aby produkce četla z R2.

### 5. Ověření

- Actions → **Live radar** → log `R2: uploaded N file(s)`
- V prohlížeči: `https://pub-xxx.r2.dev/data/meta.json`
- V appce SyncStatus: radar by měl být **≤10 min** starý

## Co dělá pipeline

```
cron 5 min → fetch OPERA + ČHMÚ → upload R2 → (volitelně git backup meta)
```

- **Publish site** se nespouští při pushi jen `public/data/` (žádný zbytečný build).
- **Learning** běží zvlášť 1× za hodinu (`learning-collect.yml`).

## Lokální test uploadu

```bash
set R2_ACCOUNT_ID=...
set R2_ACCESS_KEY_ID=...
set R2_SECRET_ACCESS_KEY=...
set R2_BUCKET=kraller-data
python scripts/upload_data_r2.py
```

## Fallback

Když R2 secrets chybí, upload se přeskočí a app pořád čte `raw.githubusercontent.com` (pomalejší).
