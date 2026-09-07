# Cloudflare Pages Deployment

Single-project deployment: frontend SPA + Express API served from the same origin, backed by D1.

## Architecture

```
frontend/dist (Vite output) + _worker.js (advanced-mode entry)
    │
    ├── /api/*  →  Express (via expressBridge)  →  D1
    └── /*      →  env.ASSETS.fetch (static SPA)
```

No CORS. Same origin. One Pages project.

---

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed globally (`npm i -g wrangler`)
- A Cloudflare account with Pages and D1 enabled

## Initial Setup

### 1. Create the D1 database

```bash
npx wrangler d1 create opencloud
```

Copy the `database_id` from the output. Paste it into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "opencloud",
    "database_id": "paste-here"
  }
]
```

> Never commit `database_id` to source control. Add it locally only.

### 2. Apply migrations

Remote (production):
```bash
npm run d1:apply
```

Local (dev):
```bash
npm run d1:apply:local
```

---

## Environment Variables

Set these in the Cloudflare Pages dashboard or via `wrangler.toml` / `vars`.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_MODE` | `local` | `local` = single-user (auto-injects local user). `hosted` = multi-user with login/register. |
| `OMNICLOUD_SECRET_HALF` | — | Half of the encryption key. Paired with `OMNICLOUD_FINGERPRINT`. |
| `AUTH_SECRET` | — | Secret for signing auth session cookies (hosted mode). |
| `AUTH_COOKIE_NAME` | `omnicloud_session` | Name of the session cookie. |
| `AUTH_SESSION_TTL_HOURS` | `336` | Session lifetime in hours (14 days default). |
| `TRASH_RETENTION_DAYS` | `30` | Days before soft-deleted files are purged. |
| `QUOTA_HARD_LIMIT_ENABLED` | — | Enable hard quota enforcement. |
| `SYNC_INTERVAL_MINUTES` | `5` | Cron interval for background metadata sync. |
| `FRONTEND_URL` | — | The deployed origin (e.g., `https://opencloud.pages.dev`). Must match. |
| `OMNICLOUD_FINGERPRINT` | `local-machine` | Set to `cloudflare-pages` on Pages. Used for encryption key derivation. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | — | Google Drive OAuth (SP-4+). |
| `ONEDRIVE_CLIENT_ID` / `ONEDRIVE_CLIENT_SECRET` / `ONEDRIVE_TENANT_ID` / `ONEDRIVE_REDIRECT_URI` | — | OneDrive OAuth (SP-4+). |
| `DROPBOX_CLIENT_ID` / `DROPBOX_CLIENT_SECRET` / `DROPBOX_REDIRECT_URI` | — | Dropbox OAuth (SP-4+). |
| `YANDEX_CLIENT_ID` / `YANDEX_CLIENT_SECRET` / `YANDEX_REDIRECT_URI` | — | Yandex OAuth (SP-4+). |
| `TELEGRAM_BOT_TOKEN` | — | Telegram integration (SP-5+). |

> **No `.env` on Pages.** `dotenv` only loads in the Node server process (`backend/src/server.js`). On Workers, env vars come from Pages dashboard or Wrangler vars.

---

## Local Development

```bash
# 1. Apply D1 schema locally
npm run d1:apply:local

# 2. Start the dev server (builds frontend + starts wrangler pages dev)
npm run web:dev
```

Then open **http://localhost:8788**.

| Endpoint | Expected |
|----------|----------|
| `GET /` | SPA HTML (Vue app) |
| `GET /api/health` | `{"status":"ok","appMode":"local","port":8787}` |
| `GET /api/files` | `{"files":[]}` (empty D1, local mode auto-authenticated) |

---

## Build

```bash
npm run web:build
```

This runs:
1. `npm --prefix frontend run build` (Vite produces `frontend/dist/`)
2. Copies `cloudflare/_worker.js` → `frontend/dist/_worker.js`

Output is in `frontend/dist/` — ready for Pages deploy.

---

## Deploy

```bash
# 1. Apply migrations to remote D1
npm run d1:apply

# 2. Build + deploy
npm run web:deploy
```

Or manually:
```bash
npx wrangler pages deploy frontend/dist --branch main --project-name opencloud
```

---

## OAuth Redirect URIs

When deploying, update your OAuth provider redirect URIs to match the deployed origin:

```
https://your-app.pages.dev/api/accounts/google/callback
https://your-app.pages.dev/api/accounts/onedrive/callback
https://your-app.pages.dev/api/accounts/dropbox/callback
https://your-app.pages.dev/api/accounts/yandex/callback
```

---

## Testing

```bash
# Cloudflare worker tests (Miniflare, no deploy needed)
npm run web:test

# Node backend tests (unchanged)
npm test
```

---

## File Structure

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Pages advanced-mode config, D1 binding, compatibility flags |
| `migrations/0001_init.sql` | D1 schema + seed (ground truth) |
| `cloudflare/_worker.js` | Worker entry: routes `/api/*` → Express, else → ASSETS |
| `cloudflare/appSlim.js` | Express app with health, files, share-info routes |
| `cloudflare/expressBridge.js` | `Request/Response → Express req/res` adapter |
| `cloudflare/db.js` | `envStore` (AsyncLocalStorage) + `D1Compat` async statement API |
| `scripts/pages-build.mjs` | Build script (vite + worker copy) |

---

## Known Gaps (SP-1 handoff)

These are deferred to subsequent sub-projects:

- **Full route surface (SP-2):** Only `/api/health`, `/api/files`, `/api/share/:token/info` are mounted. Auth, accounts, uploads, settings, allocation, sync — all come in SP-2 when the full `createApp()` is ported.
- **WebSocket upload progress (SP-2+):** WS `/ws/uploads` not yet wired. Poll-based fallback documented in spec.
- **Chunked >100MB uploads (SP-2+):** Large-file streaming upload support deferred.
- **Provider adapters (SP-4):** Google Drive, OneDrive, Dropbox, Yandex, MEGA, pCloud, S3 — all ported in SP-4.
- **OAuth flow (SP-4):** OAuth redirect handling and token storage.
- **Cron sync (SP-5):** `node-cron` → Cloudflare Cron Triggers.
- **Telegram integration (SP-5):** Bot token handling and file sync.
- **MEGA/pCloud provider port (SP-6):** Email/password account connections.
- **Vitest pool (SP-2):** Tests migrate from direct Miniflare API to `@cloudflare/vitest-pool-workers`.
