# Task 5: Chunked/Resumable Upload Support in Provider Adapters

## Status: COMPLETE

## Summary
Added `uploadChunked()` to all 6 provider adapters (Google Drive, OneDrive, Dropbox, S3, Yandex, pCloud) with provider-specific optimal strategies. Integrated chunked upload into the `/upload/complete` and `/upload/assemble` routes. All 178 cloudflare tests pass.

## Changes

### base.js
- Added `uploadChunked()` default: collects all chunks into `Uint8Array`, reassembles, falls back to `uploadStream()`
- Validates non-empty chunks

### google.js
- `uploadChunked()`: Resumable upload (>5MB) via `uploadType=resumable` session URI flow
- `_uploadChunkedFallback()` (≤5MB): single-part multipart upload
- `_readStreamBytes()` helper for reading ReadableStream to bytes
- Fixed Blob vs ReadableStream issue in FormData.append

### onedrive.js
- `uploadChunked()`: Upload session (>4MB) via `createUploadSession` + `Content-Range` PUTs + session DELETE
- `_uploadChunkedFallback()` (≤4MB): simple PUT to `graph.microsoft.com`
- `readStreamBytes()` helper

### dropbox.js
- `uploadChunked()`: Session upload (>150MB) via start/append_v2/finish
- `_uploadChunkedFallback()` (≤150MB): simple upload to `content.dropboxapi.com/2/files/upload`
- `dropboxReadStreamBytes()` helper

### s3.js
- `uploadChunked()`: Multipart (>5MB) via CreateMultipartUpload/UploadPart/CompleteMultipartUpload
- `_uploadChunkedFallback()` (≤5MB): simple PUT
- `s3ReadStreamBytes()` helper

### yandex.js / pcloud.js
- No changes needed; base class default handles them

### uploads.js
- Added `loadAdapter()` helper with lazy dynamic imports for all 6 providers
- Updated `/upload/complete` and `/upload/assemble` routes to call `adapter.uploadChunked()` after reassembling staged chunks

### adapters.test.mjs
- Added `patchReadCredentials()` and `patchGetAccessToken()` helpers
- Added 10 new chunked upload tests:
  - Base class: fallback to uploadStream, empty chunks rejection
  - Google: resumable (>5MB), multipart (≤5MB)
  - S3: multipart (>5MB), simple PUT (≤5MB)
  - Dropbox: session (>150MB), simple (≤150MB)
  - OneDrive: session (>4MB), simple (≤4MB)

## Key Decisions
- OneDrive adapter's `getAccessToken()` calls `decryptJson` directly (not via `readCredentials`), so tests use `patchGetAccessToken()` to cache the token on the adapter instance
- Dropbox adapter uses `requestWithReauth` which calls `getAccessToken()` internally, so same patching approach needed
- S3 multipart mock returns `<InitiateMultipartUploadResult>` with `<UploadId>` (not `<CompleteMultipartUploadResult>`)
- All adapters fall back to base class default if they don't override `uploadChunked()`

## Test Results
- **178/178 tests pass** (0 failures)
- 26 adapter tests (16 existing + 10 new)
- All other test suites unaffected (no regressions)
