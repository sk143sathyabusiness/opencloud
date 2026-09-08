# SP-3: Uploads & Streams — Close the Gaps

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining gaps between SP-2's working upload pipeline and a fully functional streaming upload/download system on Cloudflare Workers.

**Scope:** R2 staging for large bodies, ~100MB cap enforcement, streaming downloads (file + preview + share), provider chunked/resumable upload paths, and bulk ZIP streaming download. WebSocket/Durable Object progress hub is OUT of scope (keep SSE poll).

## Context

SP-2 delivered:
- Chunked upload pipeline (D1 BLOB chunks + SSE progress via KV)
- All 6 provider adapters with `uploadStream` + `getDownloadStream` (Web ReadableStream)
- 138 cloudflare tests + 16 backend tests passing

SP-3 closes the gaps:
- D1 BLOBs are unsuitable for large files (D1 row size limits, storage bloat)
- Download/preview/share routes still return 501
- No multipart size cap enforcement
- Provider adapters use single-request uploads (no resumable/chunked paths for large files)
- Bulk ZIP download returns 501

## Global Constraints

- Single Cloudflare Pages project; same origin (no CORS).
- `compatibility_flags = ["nodejs_compat"]`; `compatibility_date = "2025-12-01"`.
- D1 for metadata. KV for ephemeral state. R2 for large-file staging.
- `node:test` + Miniflare for tests. Node backend 16/16 must stay green.
- `express.json()` NOT used on bridge. Body parsing via `request.json()` / `request.formData()`.
- All crypto via Web Crypto API (async).
- MEGA provider dropped. pCloud uses simple upload (single-shot API).
- SSE poll for progress (no WebSocket/DO).

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `cloudflare/staging.js` | R2 wrapper (put/get/delete staged chunks) |
| `cloudflare/tests/staging.test.mjs` | R2 staging tests |
| `cloudflare/zipWriter.js` | Streaming ZIP writer (Workers-native, no archiver) |
| `cloudflare/tests/zipWriter.test.mjs` | ZIP writer tests |

### Modified files

| File | Changes |
|------|---------|
| `wrangler.jsonc` | Add R2 binding |
| `cloudflare/routes/uploads.js` | R2 staging for chunks, size cap enforcement |
| `cloudflare/routes/files.js` | Streaming download/preview, streaming ZIP bulk download |
| `cloudflare/routes/share.js` | Streaming share download |
| `cloudflare/adapters/base.js` | Add `uploadChunked()` orchestrator |
| `cloudflare/adapters/google.js` | Resumable upload support |
| `cloudflare/adapters/onedrive.js` | Large-file upload session |
| `cloudflare/adapters/dropbox.js` | Upload session (start/append/finish) |
| `cloudflare/adapters/s3.js` | Multipart upload (CreateMultipart/UploadPart/Complete) |
| `cloudflare/adapters/yandex.js` | Keep simple upload (document cap) |
| `cloudflare/adapters/pcloud.js` | Keep simple upload (document cap) |
| `docs/cloudflare.md` | Document new env vars |

---

## Task 1: R2 Binding + Storage Abstraction

**Goal:** Add R2 bucket binding to wrangler, create `cloudflare/staging.js` (R2 wrapper), and update upload routes to stage large chunks in R2 instead of D1 BLOBs.

### What to do

1. Add `r2_buckets` binding to `wrangler.jsonc`:
   ```json
   "r2_buckets": [
     { "binding": "R2", "bucket_name": "opencloud-staging" }
   ]
   ```

2. Create `cloudflare/staging.js`:
   - `putStagedChunk(env, uploadId, index, data)` — writes to R2 at `staging/{uploadId}/{index}`
   - `getStagedChunks(env, uploadId)` — lists all objects under `staging/{uploadId}/`, returns sorted array of `{index, body}`
   - `deleteStaged(env, uploadId)` — lists and deletes all objects under `staging/{uploadId}/`
   - All functions use `env.R2` binding (Workers R2 API: `env.R2.put()`, `env.R2.list()`, `env.R2.get()`, `env.R2.delete()`)

3. Update `cloudflare/routes/uploads.js`:
   - Import `putStagedChunk`, `getStagedChunks`, `deleteStaged` from `../staging.js`
   - On `/upload/chunk`: if `env.R2` exists, store chunk in R2 via `putStagedChunk`; otherwise fall back to D1 BLOB (current behavior)
   - On `/upload/complete` and `/upload/assemble`: if R2 was used, read chunks from R2 via `getStagedChunks`, assemble, then `deleteStaged`
   - Track whether R2 was used in the session record (new column or KV flag)

4. Create `cloudflare/tests/staging.test.mjs`:
   - Test `putStagedChunk` writes to R2
   - Test `getStagedChunks` returns sorted chunks
   - Test `deleteStaged` removes all objects
   - Use Miniflare with R2 bucket binding

### Dependencies
None (first task).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-1-report.md`

---

## Task 2: ~100MB Upload + Chunk Cap Enforcement

**Goal:** Enforce total upload size cap and per-chunk size cap on upload routes.

### What to do

1. Add env vars to `docs/cloudflare.md`:
   - `UPLOAD_MAX_BYTES` (default `104857600` = 100MB)
   - `MAX_CHUNK_BYTES` (default `26214400` = 25MB)

2. Update `cloudflare/routes/uploads.js`:
   - On `/upload/init`: validate `file_size <= UPLOAD_MAX_BYTES`; return 413 with `{error, data: {maxBytes, requestedBytes}}` if exceeded
   - On `/upload/chunk`: validate each chunk `<= MAX_CHUNK_BYTES`; return 413 if exceeded
   - Read limits from `env` via `envStore.getStore()`
   - Also validate total assembled size on `/upload/complete` as a safety check

3. Update `cloudflare/tests/uploads.test.mjs`:
   - Test init over cap returns 413
   - Test chunk over cap returns 413
   - Test normal sizes still work

### Dependencies
None (independent of Task 1).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-2-report.md`

---

## Task 3: Streaming Downloads (File + Preview)

**Goal:** Wire `getDownloadStream` into file download and preview routes, replacing 501 stubs.

### What to do

1. Create adapter factory helper in `cloudflare/routes/files.js` (or a shared module):
   - `async function getAdapterForAccount(accountId)` — looks up account in D1, imports the right adapter class, instantiates with `(account, env)`

2. Implement `GET /api/files/:id/download`:
   - Look up file in `file_metadata` by `id`
   - Get adapter via `getAdapterForAccount(file.cloud_account_id)`
   - Call `adapter.getDownloadStream(file)` — returns `ReadableStream`
   - Stream response: `new Response(stream, {headers: {'Content-Disposition': 'attachment; filename="..."', 'Content-Type': file.mime_type || 'application/octet-stream'}})`
   - Handle errors gracefully (adapter failure → 502 with message)

3. Implement `GET /api/files/:id/preview`:
   - Same as download but with `Content-Disposition: inline`
   - Set `Content-Type` from mime_type (must be previewable: image/*, video/*, audio/*, text/*, application/pdf)
   - For non-previewable types, return 415

4. Implement `POST /api/files/folders` (create folder):
   - Look up parent path in D1
   - Get adapter, call `adapter.createFolder(name, remoteParentId)`
   - Insert new folder row into D1 `file_metadata`

5. Implement `POST /api/files/:id/move` and `POST /api/files/:id/copy`:
   - Resolve destination path to a folder mirror row
   - Get adapter, call `adapter.moveFile(file, destRemoteId)` or `adapter.copyFile(file, destRemoteId)`
   - Update mirror row's `virtual_path`/`remote_parent_id`

6. Implement bulk move/copy (`POST /api/files/bulk/move`, `POST /api/files/bulk/copy`):
   - Process each file, collect per-item errors, never abort mid-batch

7. Update tests in `cloudflare/tests/files.test.mjs`:
   - Test download with a mock adapter returning a ReadableStream
   - Test preview with inline disposition
   - Test folder creation
   - Test move/copy with mock adapter

### Dependencies
None (adapters already have `getDownloadStream`).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-3-report.md`

---

## Task 4: Streaming Share Download

**Goal:** Wire `getDownloadStream` into the share download route, replacing 501 stub. Implement password verification, expiry check, download count increment.

### What to do

1. Implement `GET /api/share/:token/download`:
   - Look up share link by `hashToken(token)` (using `hashToken` from `../config/crypto.js`)
   - If not found → 404 (don't reveal existence)
   - If expired → 404
   - If `password_hash` set, verify via `X-Link-Password` header using `verifyPassword` from crypto
   - Wrong/missing password → 401
   - Increment `download_count`, update `last_used_at`
   - Reconstruct adapter from stored `cloud_account_id`
   - Call `adapter.getDownloadStream({remote_file_id, ...})` — stream response
   - Handle adapter errors (invalid_token → 502 "Reconnect this provider")

2. Implement `GET /api/share/:token/info` (already works, but verify):
   - Should return file metadata without exposing password_hash
   - If link not found or expired → 404

3. Update `cloudflare/tests/share.test.mjs`:
   - Test download with no password → success
   - Test download with wrong password → 401
   - Test download with expired link → 404
   - Test download_count increments

### Dependencies
None (adapters already have `getDownloadStream`).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-4-report.md`

---

## Task 5: Provider Chunked/Resumable Upload Paths

**Goal:** Add chunked/resumable upload support to adapters for large files, so assembled bytes actually reach providers.

### What to do

1. Add `uploadChunked()` to `cloudflare/adapters/base.js`:
   - Default implementation: falls back to `uploadStream()` (single-request)
   - Signature: `async uploadChunked({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize })`
   - `chunks` is an async iterable yielding `{index, body: ReadableStream}`

2. Google Drive adapter (`cloudflare/adapters/google.js`):
   - For files > 5MB: use resumable upload (`uploadType=resumable`)
   - `POST /upload/drive/v3/files?uploadType=resumable` → get session URI
   - `PUT {sessionUri}` with each chunk
   - For files <= 5MB: keep existing `uploadStream()` (multipart)

3. OneDrive adapter (`cloudflare/adapters/onedrive.js`):
   - For files > 4MB: use upload session
   - `POST /me/drive/items/{parentId}:/{name}:/createUploadSession`
   - `PUT` each chunk with `Content-Range` header
   - `DELETE` session on completion

4. Dropbox adapter (`cloudflare/adapters/dropbox.js`):
   - For files > 150MB: use upload session
   - `POST /2/files/upload_session/start` with first chunk
   - `POST /2/files/upload_session/append_v2` with subsequent chunks
   - `POST /2/files/upload_session/finish` to commit

5. S3 adapter (`cloudflare/adapters/s3.js`):
   - For files > 5MB: use multipart upload
   - `CreateMultipartUpload` (SigV4)
   - `UploadPart` for each chunk (SigV4 per request)
   - `CompleteMultipartUpload` with part ETags

6. Yandex and pCloud: keep simple `uploadStream()` (single-shot API). Document that files > their API limits will fail.

7. Update `cloudflare/routes/uploads.js`:
   - On `/upload/complete` or `/upload/assemble`: after assembling chunks, call `adapter.uploadChunked()` instead of just returning the assembled bytes
   - The assembled bytes flow: R2/D1 staging → adapter.uploadChunked() → provider

8. Tests: mock fetch sequences for each provider's chunk flow (assert request shape), verify assemble invokes the right path by size threshold.

### Dependencies
Depends on Task 1 (R2 staging must work for large chunks).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-5-report.md`

---

## Task 6: Bulk ZIP Streaming Download

**Goal:** Implement `POST /api/files/bulk/download` streaming a ZIP archive via a Workers-native ZIP writer (no `archiver` dependency).

### What to do

1. Create `cloudflare/zipWriter.js`:
   - Streaming ZIP writer using Web Streams API
   - `createZipStreamWriter()` returns `{ writeEntry(name, stream, size), finalize() } → ReadableStream`
   - Implements local file headers + data + central directory + end-of-central-directory
   - CRC32 computed on-the-fly as data streams through
   - Handles multiple files, collision-safe naming (append `_1`, `_2` etc.)

2. Implement `POST /api/files/bulk/download`:
   - Accept `{ ids }` in body
   - For each id: look up in `file_metadata`, expand folders by recursive D1 query (`listFilesByPath`)
   - For each leaf file: get adapter, call `getDownloadStream()`, write to ZIP via `writeEntry()`
   - For unresolvable files: write entry to `errors.txt` inside the ZIP
   - Stream ZIP response: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="omnicloud-download.zip"`

3. Create `cloudflare/tests/zipWriter.test.mjs`:
   - Test single-file ZIP (verify PK signature + file entry)
   - Test multi-file ZIP
   - Test error handling (unresolvable file → errors.txt entry)
   - Test CRC32 correctness

4. Update `cloudflare/tests/files.test.mjs`:
   - Test bulk download returns ZIP with correct entries

### Dependencies
Depends on Task 3 (adapter `getDownloadStream` must work).

### Report file
`.superpowers/sdd/2026-09-07-cloudflare-sp3-uploads-streams/task-6-report.md`

---

## Task Verification

After all 6 tasks:
- `node --test "cloudflare/tests/*.test.mjs"` — all cloudflare tests pass
- `node --test "backend/tests/*.test.mjs"` — all 16 backend tests pass
- `npm run build:web` — frontend builds successfully
- `node --check cloudflare/app.js cloudflare/_worker.js` — no syntax errors
