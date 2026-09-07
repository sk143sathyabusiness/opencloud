# OpenCloud on Cloudflare Pages — Deployment Design

Date: 2026-09-07
Status: Approved (design review)
Scope: Port the OpenCloud full-stack app (currently Node/Express + better-sqlite3) to a single Cloudflare Pages deployment where both the frontend SPA and the backend API run on Cloudflare Pages alone.

## 1. Context & Decisions

### Current architecture
- **Frontend**: Vue 3 + Vite + Tailwind + Pinia static SPA (`frontend/`). Builds to `frontend/dist`. Already consumes a REST API at `/api/*` plus a WebSocket at `/ws/uploads` for upload progress.
- **Backend**: Express 5 app (`backend/`) with a centralized SQLite mirror via **better-sqlite3** (used only in `backend/src/config/database.js`). Features: auth (local/hosted), 7 provider adapters (Google Drive, OneDrive, Dropbox, Yandex, MEGA, pCloud, S3), upload pipeline (busboy, per-provider chunked upload), cron auto-sync, Telegram bot, global search, trash/restore, move/copy, batch ZIP download, quota (soft warning + hard 507 limit), duplicate detection, public share links.
- **Env**: `backend/src/config/env.js` reads `process.env` via `dotenv`; derives an encryption key from `OMNICLOUD_SECRET_HALF` + a machine fingerprint (`os.hostname()|platform|arch`).
- **Entry points**: `backend/src/app.js` exports `createApp()` (middleware + routes, error handler). `backend/src/server.js` calls `app.listen` and hosts a `WebSocketServer` on `/ws/uploads`.

### Decisions (user-approved)
1. **Rewrite to Workers + D1.** Backend ported to Cloudflare Workers/Pages Functions with D1 (SQLite-compatible) storage. This is a large rewrite (sync→async SQL, uploads, WebSocket via Durable Objects, fetch-based provider adapters).
2. **Full parity in one go**, decomposed into 6 sequenced sub-projects, each with its own spec → plan → review cycle.
3. **MEGA / pCloud / Telegram custom-protocol adapters are ported LAST** as their own sub-project (their npm SDKs are Node-native and cannot run in Workers). Everything else ships first so the stack is live while they are ported.
4. **Chunked upload support for files >100MB** to respect Cloudflare's per-request body cap.
5. **Approach A: monolithic Pages Function around the existing Express app.** Keep the Express router/middleware; add a Worker entry that bridges `Request/Response` into Express `req`/`res`. The deployment is one Cloudflare Pages project (advanced mode) serving both the SPA and the API from the same origin.

### Non-goals (for this program)
- No migrations of existing local `omnicloud.db` data as a requirement (optional import script offered, not promised).
- No cold-start/latency optimization beyond what the runtime gives us.
- No split into multiple Cloudflare resources (single Pages project on the `pages.dev` domain).

---

## 2. Target Architecture

```
   Cloudflare Pages project "opencloud" (advanced mode)

   build: npm run build:web           →  frontend/dist
   output: frontend/dist              →  static assets via env.ASSETS

   functions/_worker.js  (the API + SPA fallback)
     ├─ /api/*            → Express bridge (existing routes unchanged)
     ├─ /*                → env.ASSETS.fetch(req) SPA fallback (so /s/{token} works)
     ├─ /ws/uploads       → WebSocket served through a Durable Object hub
     ├─ D1 binding        → the DB (schema parity, async client)
     ├─ KV binding        → sessions / short-lived caches
     ├─ R2 binding        → large-file staging for chunked uploads
     └─ Cron Trigger      → auto-sync (scheduled handler)
```

- Same origin for frontend and API → no CORS (the browser no longer cross-origins).
- OAuth redirect URIs become `https://<project>.pages.dev/api/accounts/{provider}/callback`.
- Share-link URLs use `FRONTEND_URL` (the pages.dev origin) — the SPA catches `/s/{token}` and the worker falls back to the SPA for non-`/api` routes.

### Runtime strategy
- `compatibility_date` recent; `compatibility_flags = ["nodejs_compat"]` (v2) → provides `node:crypto`, `node:os`, `node:path`, `node:stream`, `node:buffer`, `process`, `process.env`.
- Express is retained **only** as the routing + middleware layer. `_worker.js` implements a minimal adapter:
  - Builds a `req` from the `Request` (method, url, headers, readable body, parsed cookies, `req.query`/`req.params`/`req.body` set by middlewares).
  - Builds a `res` bridge that services the Express `res` API actually used (`status`, `json`, `send`, `end`, `setHeader`, `append`, `cookie`, `clearCookie`, `req` passthroughs).
  - The existing `res.cookie`/`res.clearCookie` shim in `app.js` continues to work.
  - On completion/error, the bridge collects status/headers/body and returns a Web `Response`.
- **Spike risk (early validation, Phase 1):** if Express does not behave correctly under `nodejs_compat`, fall back to a Workers-native router (`sane-router`-style) that reuses the same service layer. The service layer is designed to be router-agnostic so this fallback does not invalidate the data/async work.

---

## 3. Data Layer (the crux of the port)

### D1 schema parity
`migrations/0001_init.sql` reproduces the full current schema (see `backend/src/config/database.js`):

- `users` (id TEXT PK, email UNIQUE, password_hash, is_local, created_at, updated_at)
- `auth_sessions` (id PK, user_id FK, token_hash UNIQUE, expires_at, created_at, last_used_at)
- `cloud_accounts` (id PK, user_id FK, email, provider, encrypted_credentials, total_space, used_space, status CHECK)
- `file_metadata` (id PK, user_id FK, cloud_account_id FK, virtual_path, file_name, is_folder, is_starred, size, mime_type, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time, created_at, updated_at)
- `user_settings` (id PK, user_id FK, key, value, created_at, updated_at)
- `trash` (id PK, user_id FK, cloud_account_id FK, remote_file_id, remote_parent_id, virtual_path, file_name, is_folder, size, mime_type, remote_created_time, remote_modified_time, deleted_at, UNIQUE(user_id, cloud_account_id, remote_file_id))
- `share_links` (id PK, user_id FK, file_id, cloud_account_id, remote_file_id, file_name, size, mime_type, is_folder, token UNIQUE, password_hash, expires_at, created_at, last_used_at, download_count)
- Indexes: idx_auth_sessions_user_id, idx_cloud_accounts_user_provider_email (UNIQUE), idx_cloud_accounts_user_id, idx_file_virtual_path, idx_file_remote_id, idx_share_links_user, idx_share_links_file, idx_file_account_remote_id (UNIQUE), idx_file_user_account_id, idx_user_settings_user_key (UNIQUE), idx_trash_user_deleted_at

D1 notes:
- `WAL` pragma dropped (no-op in D1; not applicable).
- **Foreign keys are enforced ON by default in D1** (matches current `PRAGMA foreign_keys = ON`).
- `CURRENT_TIMESTAMP` defaults and string types are already compatible.
- Seed row: local user `local-default-user / local@omnicloud.local` (is_local = 1) via migration.

### Async D1 client
- Replace `better-sqlite3` usage with an async D1 client. D1's `Statement` API mirrors better-sqlite3 closely (`prepare().run()`, `.get()`, `.all()`, `db.exec()`), so **no SQL rewrites** are needed — only `await`.
- `backend/src/config/database.js` becomes an async factory bound to the D1 binding: `export async function getDb(env)` returning `db` with `prepare/exec`. `LOCAL_USER_ID` / `LOCAL_USER_EMAIL` move to a shared constants file.
- Call sites gain `await`. This is mechanical and done per-service in Phase 2, but a working vertical slice (Phase 1) must exercise it end-to-end.

### Crypto pinning in serverless
- `env.js` currently derives the credential-encryption key from `OMNICLOUD_SECRET_HALF + machine fingerprint`. On Workers `os.hostname()` is empty/unstable → old local keys cannot decrypt cloud credentials (acceptable: cloud starts fresh, provider OAuth only).
- Serverless derivation: `sha256(OMNICLOUD_SECRET_HALF + ":cloudflare-pages")` — stable, documented. Remove `dotenv`/`os` fingerprint from the runtime path (dotenv becomes a local-dev-only convenience or is removed).

---

## 4. Env Model for Pages

No `.env` for deployment. All configuration is **Pages environment variables** (dashboard or `wrangler pages secret put` / `vars`), surfaced via `process.env.*` under `nodejs_compat`.

| Category | Variables |
|---|---|
| Core | `APP_MODE` (local/hosted), `OMNICLOUD_SECRET_HALF` (required secret), `AUTH_SECRET`, `AUTH_COOKIE_NAME` (default `omnicloud_session`), `AUTH_SESSION_TTL_HOURS`, `TRASH_RETENTION_DAYS`, `QUOTA_HARD_LIMIT_ENABLED`, `SYNC_INTERVAL_MINUTES` |
| Origin | `FRONTEND_URL` (must equal the pages.dev URL) — no `CORS_ORIGIN` needed (same origin) |
| OAuth | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`, `ONEDRIVE_CLIENT_ID` / `ONEDRIVE_CLIENT_SECRET` / `ONEDRIVE_TENANT_ID` / `ONEDRIVE_REDIRECT_URI`, `DROPBOX_CLIENT_ID` / `DROPBOX_CLIENT_SECRET` / `DROPBOX_REDIRECT_URI`, `YANDEX_CLIENT_ID` / `YANDEX_CLIENT_SECRET` / `YANDEX_REDIRECT_URI` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Bindings | D1 `DB` (env.DB), KV `KV` (sessions), R2 `R2` (staging), Durable Object `UPLOAD_HUB` |

- Local dev uses Wrangler's `.dev.vars` (same variable names).
- `PORT` is dropped (the platform owns the listener).

---

## 5. Delivery Order (sub-projects)

Each sub-project gets its own spec → plan → implementation → review.

### SP-1 · Platform lift (this plan)
Stand up the Pages project and prove the pipe:
- `wrangler.jsonc` (advanced-mode Pages): compat flags, D1/KV/R2/DO bindings, build config (build command `npm run build:web`, output **`frontend/dist`**), `.dev.vars` template.
- `migrations/0001_init.sql` + `wrangler d1 migrations apply`.
- Async D1 client replacing better-sqlite3 in `database.js`.
- `_worker.js` entry: Express bridge + `env.ASSETS fetch` SPA fallback. **Verbose spike first:** Express must handle the health route under Workers before anything else.
- Env refactor (`env.js` serverless-safe; no dotenv on runtime path; stable fingerprint).
- **Vertical slice that proves the pipe end-to-end:** `GET /api/health`, `APP_MODE=local` auth (auto local user), `GET /api/files?path=/` (list files from D1 after seeding a folder + file via migration/dev script), and public `GET /api/share/{token}/info` (a seeded share row) — all returning 200 over `wrangler dev` and on a live Pages deploy.
- SPA served at `/` and at non-`/api` paths with correct `index.html` fallback.
- Testing: `@cloudflare/vitest-pool-workers` (Miniflare) — port the smallest affected tests to `await`; new tests for health, local auth, file list, share info.

### SP-2 · Services to async
Await every service + route rest: authService, userService, fileService (full), trashService, quota, allocationService, settingsService, shareService, and all remaining routes. Sync tests to async.

### SP-3 · Uploads & streams
Chunked multipart parsing (no busboy) honoring the ~100MB cap; provider chunked upload paths; streaming downloads; R2 staging for large bodies; WebSocket upload progress served by a **Durable Object** hub (poll fallback kept).

### SP-4 · REST-capable providers
Rewrite Google Drive, OneDrive, Dropbox, Yandex, S3 adapters as pure-fetch adapters; OAuth flows against new redirect URIs; credential encryption under the serverless key.

### SP-5 · Cron sync + Telegram
Workers Cron Trigger for auto-sync (replaces `node-cron`), Telegram bot (HTTPS polling/webhook).

### SP-6 · Custom-protocol providers (last)
Port MEGA, pCloud (and Telegram file transfer semantics) to fetch-based implementations of their custom protocols. Risky, self-contained, shipped last.

---

## 6. Testing Strategy

- **Unit/integration:** `@cloudflare/vitest-pool-workers` runs tests against Miniflare with a real D1 in-memory instance and `nodejs_compat`. The existing 16 backend tests migrate to `await` where they touch DB.
- **Route-level:** Miniflare fetch against the `_worker.js` entry (no socket). Existing supertest-style tests adapt to `worker.fetch()`.
- **Manual smoky:** live Pages deploy + local `wrangler dev`.
- **Frontend:** unchanged (`vite build`), SPA fallback asserted in worker tests.

## 7. Risks & Fallbacks

| # | Risk | Fallback |
|---|---|---|
| 1 | Express under `nodejs_compat` misbehaves (socket assumptions, stream timing) | Workers-native router (service layer untouched — data work not wasted); spike decision gate in SP-1 |
| 2 | megajs / pCloud crypto ports (SP-6) can't be faithfully replicated | Ship SP-1…5 without MEGA/pCloud; document gap (user already accepted "last" ordering) |
| 3 | Durable Object capacity / WebSocket reliability for upload progress | Poll-based progress endpoint (WS optional enhancement) |
| 4 | Node-only SDKs in providers (e.g., Dropbox) | Already planned: raw REST calls in SP-4 |
| 5 | `nodejs_compat` gaps for `fs` (archiver/zip) | Batch-zip built as in-memory/streamed response or via R2 temp object instead of disk |

## 8. Concise Success Criteria (SP-1)

1. `wrangler dev` and a real Pages deploy both serve the SPA at `/`.
2. `GET /api/health` returns 200 on the live deploy.
3. Local-mode auth + `GET /api/files` list seeded rows from **D1** (not better-sqlite3) — 200 with correct JSON.
4. Public share `GET /api/share/{token}/info` returns 200 from D1 on the live deploy.
5. Local-mode `APP_MODE=local` bypass works on the Workers platform (default local user).
6. `npm test` (workers-pool) green locally without a real Pages deploy.