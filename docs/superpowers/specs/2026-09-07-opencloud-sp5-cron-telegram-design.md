# SP-5 — Cron Sync + Telegram

Date: 2026-09-07
Status: Approved
Scope: Workers Cron Trigger for auto-sync (replaces node-cron), Telegram bot push notifications.

## 1. Context

SP-1 through SP-4 are complete (211 cloudflare + 16 backend tests). The Cloudflare port has all provider adapters, OAuth, upload/download, move/copy, and credential encryption working. SP-5 adds background sync and Telegram backup.

The original Node backend uses `node-cron` for scheduled sync (every 5 min, default) and daily trash purge (3 AM). Telegram is push-only — no webhook, no polling, just `sendDocument` to a configured chat.

## 2. Task 1 — Adapter Registry + providerErrors Utility

### Files to create
- `cloudflare/adapters/registry.js` — maps provider string → adapter class
- `cloudflare/utils/providerErrors.js` — async `withRetry()`, `isAuthError()`, `isTransientError()`
- `cloudflare/tests/registry.test.mjs`
- `cloudflare/tests/providerErrors.test.mjs`

### Registry
```js
const adapters = {
  google_drive: () => import('./google.js'),
  onedrive: () => import('./onedrive.js'),
  dropbox: () => import('./dropbox.js'),
  yandex: () => import('./yandex.js'),
  s3: () => import('./s3.js'),
  pcloud: () => import('./pcloud.js'),
};

export async function createAdapter(provider, account, env) {
  const factory = adapters[provider];
  if (!factory) throw new Error(`Unknown provider: ${provider}`);
  const { default: AdapterClass } = await factory();
  return new AdapterClass(account, env);
}
```

### providerErrors
Port `backend/src/utils/providerErrors.js` with async retry (3 retries, exponential backoff). Workers-compatible.

## 3. Task 2 — Sync Service

### Files to create
- `cloudflare/services/syncService.js` — core sync logic
- `cloudflare/services/accountService.js` — getActiveAccounts, updateAccountStorage, markAccountStatus
- `cloudflare/services/fileService.js` — replaceFilesForAccount, getTrashedRemoteIds
- `cloudflare/services/trashService.js` — getExpiredTrashRows, removeTrashedRows, purgeExpiredTrash

### Sync flow (mirrors backend syncService.js)
1. `runDeltaSync(userId)`:
   - Get active accounts via `getActiveAccounts(userId)`
   - For each: call `adapter.fetchStructure()` + `adapter.getStorageSummary()`
   - On success: `replaceFilesForAccount()` (DELETE all + batch INSERT) + `updateAccountStorage()`
   - On auth error: clear files, mark `invalid_token`
   - On transient error: log and continue
   - Track `lastSyncReport` (lastRunAt, scannedAccounts, changesDetected)

2. `replaceFilesForAccount()`:
   - D1 transaction: DELETE all rows for account, then batch INSERT new records
   - Use `db.batch()` with 500-statement chunks (D1 limit)

3. `purgeExpiredTrash()`:
   - Find expired trash rows, call `adapter.deleteFile()` on each, remove from D1

## 4. Task 3 — Cron Trigger + Sync Routes

### Files to modify/create
- `cloudflare/_worker.js` — add `scheduled(event, env, ctx)` export
- `cloudflare/routes/sync.js` — create (POST /run, GET /status)

### Cron handler
```js
export default {
  fetch(request, env) { /* existing */ },
  async scheduled(event, env, ctx) {
    if (event.cron.includes('3 * * *')) {
      ctx.waitUntil(purgeExpiredTrash(LOCAL_USER_ID, env));
    } else {
      ctx.waitUntil(runDeltaSync(LOCAL_USER_ID, env));
    }
  },
};
```

### Sync routes
- `POST /api/sync/run` — manual trigger, returns results
- `GET /api/sync/status` — returns `lastSyncReport`
- `POST /api/sync/:accountId` — single account sync (upgrade existing stub)

## 5. Task 4 — Telegram Service + Routes

### Files to create
- `cloudflare/services/telegramService.js` — port all functions
- `cloudflare/routes/telegram.js` — 3 routes
- `cloudflare/tests/telegram.test.mjs`

### Telegram functions (all fetch-based, Workers-native)
- `getTelegramStatus(env)` — verify bot + chat
- `backupFileToTelegram(file, account, env)` — download from provider, send via Telegram API (50MB cap)
- `backupMetadataToTelegram(userId, env)` — export metadata as JSON, send to chat
- `sendDocument(buffer, filename, env)` — multipart form POST to `api.telegram.org`

### Routes
- `GET /api/telegram/status`
- `POST /api/telegram/backup-file`
- `POST /api/telegram/backup-metadata`

## 6. Task 5 — Integration

- Register Telegram routes in `cloudflare/app.js`
- Upgrade health.js sync stubs to real sync calls
- Register sync routes

## 7. Task 6 — Docs + Verification + Push

- Update `docs/cloudflare.md` (cron schedule, Telegram env vars, known gaps)
- Add `TELEGRAM_CHAT_ID` to env vars
- Full test suites + push

## 8. Non-Goals

- WebSocket/DO progress hub (keep SSE poll)
- Telegram webhook/polling (push-only is sufficient)
- Incremental/delta sync (full replace only, matching original)
- Per-user hosted-mode sync (local-mode only for now)
