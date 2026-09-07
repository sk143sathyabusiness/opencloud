# SP-2: Full Backend Port to Cloudflare Workers — Design

> Sub-project 2 of the Cloudflare Pages rewrite. Ports the complete Node.js backend API surface to run on Cloudflare Workers alongside the SP-1 slim app.

## Goals

- Port **all** API routes from `backend/src/` to run on Cloudflare Workers via the Express bridge
- Port all provider adapters: Google Drive, OneDrive, Dropbox, Yandex, S3, pCloud
- **Drop MEGA** provider entirely (`megajs` uses raw TCP sockets, incompatible with Workers)
- Keep the Node.js backend green — both runtimes coexist
- All existing tests pass; new tests cover ported routes

## Non-Goals

- MEGA provider support (dropped from Cloudflare version)
- Telegram integration (deferred to SP-5)
- Cron sync via Cron Triggers (deferred to SP-5; manual sync only in SP-2)
- Vitest migration (deferred)

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Router | Keep Express bridge (`expressBridge.js`) | Least code change from SP-1 |
| Upload progress | SSE (Server-Sent Events) or polling | Simpler than Durable Objects WebSocket |
| Ephemeral state | Workers KV | OAuth states, upload sessions, token caches |
| Crypto | PBKDF2 via Web Crypto API | `scryptSync` unavailable in Workers |
| MEGA | Dropped | `megajs` uses raw TCP/TLS, impossible in Workers |
| File uploads | `request.formData()` + chunking for >100MB | Workers 100MB body limit |

## Architecture

```
frontend/dist + _worker.js (advanced-mode entry)
    │
    ├── /api/*  →  Express (via expressBridge)  →  D1 + KV + Providers
    └── /*      →  env.ASSETS.fetch (static SPA)
```

**Bindings:**
- `DB` — D1 database (schema from SP-1 migration)
- `STATE` — Workers KV namespace (ephemeral state)
- `ASSETS` — Pages static assets
- `APP_MODE`, `AUTH_SECRET`, etc. — env vars (same as SP-1)

## Layers (Implementation Order)

### Layer 1: D1 Adapter Extension

Extend `cloudflare/db.js` with:
- `transaction(fn)` — wraps `DB.exec('BEGIN; ... COMMIT;')` with rollback
- `batch(queries)` — D1 batch for grouped reads
- All existing `D1Compat` methods remain

Every service method that touches DB becomes `async`.

### Layer 2: Crypto Module

Create `backend/src/config/crypto.js` with async versions:
- `hashPassword(password, salt)` → PBKDF2 via `crypto.subtle`
- `verifyPassword(password, storedHash, salt)` → constant-time compare
- `generateToken()` → `crypto.getRandomValues`
- `hashToken(token)` → SHA-256 digest

Both Node and Workers can use this (Node has `crypto.subtle` since v15+).

### Layer 3: Middleware + State Store

**Middleware (in `_worker.js` or bridge):**
- CORS headers (manual `Access-Control-*`)
- `express.json()` on bridge (for POST body parsing)
- `attachAuthContext` — reads cookies from bridge `req.cookies`, queries D1
- `requireAppUser` — checks `req.user`
- Cookie helpers (`Set-Cookie` header building)

**Workers KV (`STATE` namespace):**
| Key pattern | TTL | Contents |
|-------------|-----|----------|
| `oauth:{provider}:{state}` | 10min | `{userId, provider, redirectUri}` |
| `upload:{uploadId}` | 1hr | `{userId, accountId, fileName, progress, status}` |
| `token:{adapterId}` | tokenExpiry - 5min | `{accessToken, refreshToken, expiresAt}` |

### Layer 4: Auth Routes

Port `authRoutes.js`:
- `GET /api/auth/me` — session lookup from D1
- `POST /api/auth/register` — PBKDF2 hashing, D1 insert
- `POST /api/auth/login` — PBKDF2 verify, session create
- `POST /api/auth/logout` — session destroy

### Layer 5: Settings + Allocation Routes

Pure D1 CRUD — straightforward async migration:
- `GET /api/settings`, `PATCH /api/settings`
- `GET /api/allocation`, `PATCH /api/allocation`

### Layer 6: Share Routes

- `POST /api/share` — create link
- `GET /api/share` — list links
- `DELETE /api/share/:token` — revoke
- `GET /api/share/:token/info` — public info (already in SP-1)
- `GET /api/share/:token/download` — streaming download from provider

### Layer 7: Account Routes + OAuth

Port `accountRoutes.js`:
- `GET /api/accounts` — list accounts
- Provider status endpoints (config checks)
- OAuth connect URLs (generate state, store in KV, return redirect URL)
- OAuth callbacks (exchange code, store tokens in KV + encrypted creds in D1)
- MEGA/pCloud/S3 email-password connect endpoints
- `DELETE /api/accounts/:id` — remove account

**Provider adapter changes:**
- Google Drive: replace `googleapis` with raw REST API calls
- OneDrive, Dropbox, Yandex, pCloud: minimal changes (already `fetch`-based)
- S3: `@aws-sdk/client-s3` v3 works in Workers

### Layer 8: File Routes

Port `fileRoutes.js`:
- `GET /api/files` — list/search/starred/recent/shared
- `GET /api/files/:id` — file details
- `PATCH /api/files/:id/star` — star/unstar
- `PATCH /api/files/:id/rename` — rename
- `DELETE /api/files/:id` — soft delete
- `POST /api/files/bulk/delete` — bulk soft delete
- `POST /api/files/folders` — create folder
- `POST /api/files/:id/move`, `POST /api/files/:id/copy` — transfer
- `POST /api/files/bulk/move`, `POST /api/files/bulk/copy` — bulk transfer
- `GET /api/files/trash`, `POST /api/files/trash/restore`, `DELETE /api/files/trash`
- `GET /api/files/duplicates` — duplicate detection

**Stream handling:** `BaseCloudAdapter.getDownloadStream()` returns `ReadableStream` (Web Streams) instead of Node `stream.Readable`.

### Layer 9: Upload Pipeline

- `POST /api/uploads/initiate` — create session in D1 + KV
- `POST /api/uploads/:id/stream` — `request.formData()` → read `File` blob → upload to provider
- `POST /api/uploads/:id/chunk` — chunked upload for >100MB files
- `GET /api/uploads/:id/progress` — poll KV for progress (or SSE)

**Chunking:** Client sends 50MB chunks with `Content-Range` header. Server assembles on provider side.

### Layer 10: Download/Preview Streaming

- `GET /api/files/:id/download` — stream from provider via `ReadableStream`
- `GET /api/files/:id/preview` — same, with `Content-Disposition: inline`
- `POST /api/files/bulk/download` — streaming ZIP (replace `archiver` with `@cf/plain-blob-zip` or manual implementation)

## File Changes

**New files:**
- `backend/src/config/crypto.js` — async crypto functions
- `cloudflare/middleware.js` — CORS, auth context, cookie helpers
- `cloudflare/kvStore.js` — KV wrapper for state management
- `cloudflare/routes/` — one file per route group (auth, accounts, files, uploads, settings, allocation, share)
- `cloudflare/adapters/` — ported provider adapters (Google, OneDrive, Dropbox, Yandex, S3, pCloud)

**Modified files:**
- `cloudflare/_worker.js` — mount full app, add CORS, cron handler
- `cloudflare/appSlim.js` → rename to `cloudflare/app.js` (full Express app)
- `cloudflare/db.js` — add transaction/batch support
- `cloudflare/expressBridge.js` — add `res.req` stub, finish timeout, body reader
- `backend/src/services/*.js` — make DB methods async
- `wrangler.jsonc` — add KV binding, cron triggers
- `package.json` — add `@cf/plain-blob-zip` or similar

**Removed:**
- MEGA adapter, MEGA account service, MEGA OAuth service

## Testing

- All SP-1 tests remain green
- New Miniflare integration tests for each route group
- `npm run web:test` covers all Workers tests
- `npm test` covers Node backend tests (must remain green)
- `wrangler pages dev` manual smoke for upload/download flows

## Risks

| Risk | Mitigation |
|------|------------|
| `express.json()` breaks in Workers (SP-1 finding) | Already removed from slim app; re-add with bridge body reader for POST routes |
| Google Drive `googleapis` rewrite is large | OneDrive/Dropbox/Yandex/pCloud already use `fetch`; Google is the only heavy rewrite |
| 100MB upload limit | Chunked upload with Content-Range headers |
| `scryptSync` → PBKDF2 password migration | Version byte alongside hash; local mode has empty hashes (no migration needed) |
| KV eventual consistency for OAuth states | 10min TTL is fine; state is write-once-read-once |
