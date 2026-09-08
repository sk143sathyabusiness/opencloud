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

## API Endpoints (SP-2 Full Port)

All endpoints are mounted under `/api` via Express 5 on the Cloudflare Worker.

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Status check, returns `appMode` |
| `POST` | `/api/sync/run` | Manual metadata sync trigger |

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/auth/me` | Current user info |
| `POST` | `/api/auth/register` | Create account (hosted mode) |
| `POST` | `/api/auth/login` | Login, sets session cookie |
| `POST` | `/api/auth/logout` | Destroy session |

### Accounts (Cloud Providers)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/accounts` | List connected accounts |
| `GET` | `/api/accounts/:provider/status` | Provider connection status |
| `GET` | `/api/accounts/:provider/connect` | Start OAuth flow |
| `GET` | `/api/accounts/:provider/callback` | OAuth callback |
| `DELETE` | `/api/accounts/:id` | Remove account |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files` | List files (query: `path`, `provider`, `account_id`) |
| `GET` | `/api/files/search` | Search files |
| `GET` | `/api/files/trash` | List trashed files |
| `GET` | `/api/files/duplicates` | Detect duplicates |
| `POST` | `/api/files/star` | Star/unstar file |
| `POST` | `/api/files/rename` | Rename file |
| `POST` | `/api/files/move` | Move file(s) |
| `POST` | `/api/files/copy` | Copy file |
| `POST` | `/api/files/delete` | Soft-delete to trash |
| `POST` | `/api/files/restore` | Restore from trash |
| `POST` | `/api/files/folders` | Create folder |

### Uploads
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/uploads/initiate` | Start upload session |
| `POST` | `/api/uploads/:id/stream` | Stream upload (FormData) |
| `POST` | `/api/uploads/:id/chunk` | Chunked upload |
| `GET` | `/api/uploads/:id/progress` | Upload progress (SSE/poll) |
| `DELETE` | `/api/uploads/:id` | Cancel upload |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get user settings |
| `PATCH` | `/api/settings` | Update setting |

### Allocation
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/allocation` | Get allocation config |
| `PATCH` | `/api/allocation` | Update allocation strategy |

### Share
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/share` | Create share link |
| `GET` | `/api/share` | List user's share links |
| `DELETE` | `/api/share/:token` | Revoke share link |
| `GET` | `/api/share/:token/info` | Public share info |
| `GET` | `/api/share/:token/download` | Download shared file |

---

## File Structure

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Pages advanced-mode config, D1 + KV bindings, compatibility flags |
| `migrations/0001_init.sql` | D1 schema + seed (ground truth) |
| `cloudflare/_worker.js` | Worker entry: routes `/api/*` → Express, else → ASSETS |
| `cloudflare/app.js` | Full Express app: mounts all route groups |
| `cloudflare/appSlim.js` | Legacy slim app (SP-1, superseded by `app.js`) |
| `cloudflare/expressBridge.js` | `Request/Response → Express req/res` adapter |
| `cloudflare/db.js` | `envStore` (AsyncLocalStorage) + `D1Compat` async statement API |
| `cloudflare/middleware.js` | CORS, auth context, cookie helpers, error handler |
| `cloudflare/kvStore.js` | Workers KV wrapper (get/set/delete with JSON + TTL) |
| `cloudflare/routes/auth.js` | Auth routes (me, register, login, logout) |
| `cloudflare/routes/accounts.js` | Account routes (list, connect, callback, delete, status) |
| `cloudflare/routes/files.js` | File routes (list, search, star, rename, delete, move, copy, trash, duplicates) |
| `cloudflare/routes/uploads.js` | Upload routes (initiate, stream, chunk, progress) |
| `cloudflare/routes/settings.js` | Settings routes (get, update) |
| `cloudflare/routes/allocation.js` | Allocation routes (get, update) |
| `cloudflare/routes/share.js` | Share routes (create, list, revoke, info, download) |
| `cloudflare/routes/health.js` | Health check + manual sync trigger |
| `cloudflare/adapters/base.js` | Abstract adapter with Web Streams |
| `cloudflare/adapters/google.js` | Google Drive adapter (raw REST API) |
| `cloudflare/adapters/onedrive.js` | OneDrive adapter |
| `cloudflare/adapters/dropbox.js` | Dropbox adapter |
| `cloudflare/adapters/yandex.js` | Yandex adapter |
| `cloudflare/adapters/s3.js` | S3 adapter (AWS SDK v3) |
| `cloudflare/adapters/pcloud.js` | pCloud adapter |
| `backend/src/config/crypto.js` | Async crypto module (PBKDF2, SHA-256, timing-safe compare) |
| `scripts/pages-build.mjs` | Build script (vite + worker copy) |

### Test Files

| File | Purpose |
|------|---------|
| `cloudflare/tests/app.test.mjs` | Full app integration tests |
| `cloudflare/tests/auth.test.mjs` | Auth route tests |
| `cloudflare/tests/accounts.test.mjs` | Account route tests |
| `cloudflare/tests/files.test.mjs` | File route tests |
| `cloudflare/tests/uploads.test.mjs` | Upload route tests |
| `cloudflare/tests/settings.test.mjs` | Settings/allocation tests |
| `cloudflare/tests/share.test.mjs` | Share route tests |
| `cloudflare/tests/health.test.mjs` | Health route tests |
| `cloudflare/tests/crypto.test.mjs` | Crypto module unit tests |
| `cloudflare/tests/kv.test.mjs` | KV store unit tests |
| `cloudflare/tests/middleware.test.mjs` | Middleware unit tests |
| `cloudflare/tests/bridge.test.mjs` | Express bridge tests |
| `cloudflare/tests/db.test.mjs` | D1 transaction/batch tests |
| `cloudflare/tests/worker.test.mjs` | Worker fetch handler tests |

---

## Known Gaps

These are deferred to subsequent sub-projects:

- **WebSocket upload progress:** WS `/ws/uploads` not yet wired. Poll-based fallback is used.
- **Chunked >100MB uploads:** Large-file streaming upload support deferred.
- **Cron sync:** `node-cron` → Cloudflare Cron Triggers (SP-5).
- **Telegram integration:** Bot token handling and file sync (SP-5).
- **MEGA provider:** Dropped from Cloudflare version (not compatible with Workers).
- **Vitest pool:** Tests use direct Miniflare API; migration to `@cloudflare/vitest-pool-workers` deferred.
