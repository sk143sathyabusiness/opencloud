# SP-4 — Close the Provider Gaps

Date: 2026-09-07
Status: Approved
Scope: Fix credential encryption, add move/copy, persist refreshed tokens, wire shared listings, unify S3 endpoints.

## 1. Context

SP-1 through SP-3 are complete. All 6 provider adapters are pure-fetch with Web Streams. OAuth connect/callback flows are real. But the gap analysis surfaced concrete remaining work:

- `accounts.js` stores credentials as **plaintext JSON**; adapters read via AES-256-GCM `decryptJson`
- `moveFile`/`copyFile` missing from all adapters + base; 4 routes 501
- Yandex/pCloud don't persist refreshed tokens/sessions
- Shared-file listing (`?shared=1`, `shared-children`) stubbed 501
- S3 listing/quota hardcodes AWS endpoint (breaks MinIO/R2-style)

## 2. Task 1 — Credential Encryption on Write (Critical)

### Problem
`accounts.js` stores `JSON.stringify(credentials)` (plaintext) at 6 write points. All adapters call `decryptJson(encrypted_credentials)` expecting AES-256-GCM base64 format. Real connects would store undecryptable data.

### Fix
- `cloudflare/routes/accounts.js`: replace `JSON.stringify(credentials)` with `encryptJson(credentials)` at every INSERT/UPDATE (Google :358, OneDrive ~:416, Dropbox ~:474, Yandex ~:527, S3 ~:572, pCloud ~:661)
- `cloudflare/tests/helpers.mjs`: seed accounts with `encryptJson`-encrypted credentials so adapter tests round-trip the real decrypt path
- `crypto.test.mjs`: add `encryptJson`/`decryptJson` round-trip tests under Miniflare
- **Fallback**: if `crypto.createCipheriv` misbehaves under `nodejs_compat`, implement async AES-256-GCM via `crypto.subtle` in `cloudflare/config/crypto.js`

### Files
- `cloudflare/routes/accounts.js` — modify
- `cloudflare/tests/helpers.mjs` — modify
- `cloudflare/tests/crypto.test.mjs` — modify

## 3. Task 2 — moveFile/copyFile (Hybrid)

### Strategy
- **Base composition** in `cloudflare/adapters/base.js`: `copyFile` = `getDownloadStream` + `uploadStream`; `moveFile` = copy + delete. Satisfies all providers.
- **Native overrides** for REST providers: Google (`files.copy`, `files.update`), OneDrive (PATCH copy/move), Dropbox (`files/copy_v2`/`move_v2`), Yandex (`POST /resources/copy`/`move`), S3 (`CopyObject` + DELETE). pCloud uses base.

### Route changes
- Un-501 `files.js` :642 (move), :728 (copy), :846/:910 (error fallbacks)
- Bulk move/copy routes: per-item errors, never abort mid-batch; update mirror rows

### Files
- `cloudflare/adapters/base.js` — add copyFile/moveFile
- `cloudflare/adapters/google.js` — native override
- `cloudflare/adapters/onedrive.js` — native override
- `cloudflare/adapters/dropbox.js` — native override
- `cloudflare/adapters/yandex.js` — native override
- `cloudflare/adapters/s3.js` — native override
- `cloudflare/routes/files.js` — un-501
- `cloudflare/tests/files.test.mjs` — move/copy tests
- `cloudflare/tests/adapters.test.mjs` — native path tests

## 4. Task 3 — Yandex & pCloud Token Persistence

### Problem
Yandex `getAccessToken` refreshes tokens in-memory; pCloud `getSession` re-logs in. Both lose refreshed tokens on cold start.

### Fix
- New shared `updateAccountCredentials(accountId, encryptedCredentials)` helper in `cloudflare/adapters/helpers.js`
- Yandex: persist after successful refresh; only write on actual change
- pCloud: persist after re-login
- Persistence failures caught+ignored (never break API calls)

### Files
- `cloudflare/adapters/helpers.js` — create (updateAccountCredentials)
- `cloudflare/adapters/yandex.js` — persist
- `cloudflare/adapters/pcloud.js` — persist
- `cloudflare/tests/adapters.test.mjs` — persistence tests

## 5. Task 4 — Shared-File Listing Wiring

### Changes
- `files.js:215` `GET /api/files?shared=1`: call `adapter.listSharedWithMe()` per account (Google/OneDrive only; others skip gracefully)
- `files.js:767` shared-children: call `adapter.listSharedFolderChildren(folderRecord)`; 501 only if adapter lacks the method

### Files
- `cloudflare/routes/files.js` — replace 501s
- `cloudflare/tests/files.test.mjs` — shared listing tests

## 6. Task 5 — S3 Endpoint Consistency

### Fix
Unify listing/quota/fetchStructure/multipart URL construction from hardcoded `s3.${region}.amazonaws.com` to `getEndpoint()` + `forcePathStyle`, matching upload/download/createFolder paths.

### Files
- `cloudflare/adapters/s3.js` — refactor endpoint construction
- `cloudflare/tests/adapters.test.mjs` — custom endpoint tests

## 7. Task 6 — Docs + Verification

- Update `docs/cloudflare.md` (encryption, move/copy matrix, shared listings, known gaps)
- Full suites: cloudflare + backend + `npm run build:web`
- Commit + push

## 8. Non-Goals

- MEGA (SP-6), Telegram/cron (SP-5)
- `invalid_token` status handling
- WebSocket/DO progress hub
