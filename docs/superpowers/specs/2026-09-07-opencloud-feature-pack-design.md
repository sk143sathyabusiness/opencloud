# OpenCloud Feature Pack — Design Spec

**Date:** 2026-09-07
**Status:** Approved (design Q&A completed; user selected all features, then approved the consolidated plan)
**Repo:** github.com/sk143sathyabusiness/opencloud (branch `main`)
**Build order:** Wave 1 (Trash → Move/Copy → ZIP), Wave 2 (Quota → Duplicates), Wave 3 (Share links). Three commits, one per wave, each pushed to `main`.

## Background

OpenCloud aggregates Google Drive, OneDrive, Dropbox, MEGA, pCloud, Yandex Disk, and S3-compatible storage into one unified workspace. It maintains a SQLite metadata mirror (`file_metadata`) refreshed by scheduled delta sync (`syncService.runDeltaSync`), and exposes adapter-normalized file operations.

Two constraints drive most of this design:

1. **Sync wipes per-account mirror rows.** `syncService.syncAccount` → `fileService.replaceFilesForAccount` deletes all `file_metadata` rows for an account and re-inserts fresh ones. Any soft-delete state stored *in the mirror* would be resurrected by the next sync.
2. **Deletes are permanent.** `DELETE /files/:id` currently calls `adapter.deleteFile()` (provider-side permanent delete). There is no trash, no restore.

Confirmed existing state: theme toggle (dark/light) **already exists** (DriveShell + AuthLayout `toggleTheme`, `localStorage.omnicloud-theme`) — excluded from this spec. The backend `settings` already stores `theme`; the preview endpoint, Telegram backup, starred, recent, shared-with-me, search, allocation, and bulk-delete already exist.

## Non-goals

- Outbound sharing beyond download-only links (no upload/edit via links).
- Drag-and-drop move between folders (use dialog + selection bar instead).
- Server-side content hashing for duplicate detection (heuristic only).
- Provider-specific trash; all trash semantics are OpenCloud-level.

---

## Feature 1 — Trash & Restore

### Data model

New table `trash`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT NOT NULL FK → users, CASCADE | |
| `cloud_account_id` | TEXT NOT NULL | Original account id |
| `remote_file_id` | TEXT NOT NULL | Provider id |
| `remote_parent_id` | TEXT | Preserve original location |
| `virtual_path` | TEXT NOT NULL | Original normalized path |
| `file_name` | TEXT NOT NULL | |
| `is_folder` | INTEGER DEFAULT 0 | |
| `size` | INTEGER DEFAULT 0 | |
| `mime_type` | TEXT | |
| `remote_created_time` / `remote_modified_time` | TEXT | For details/restore fidelity |
| `deleted_at` | TEXT NOT NULL | Sort + auto-purge |
| UNIQUE `(user_id, cloud_account_id, remote_file_id)` | | Guards double-trash |

`file_metadata`'s unique constraint `(cloud_account_id, remote_file_id)` is unaffected because trashed rows are removed from the mirror.

### Behavior

- **Soft delete** replaces current behavior: `DELETE /files/:id` and `POST /files/bulk/delete` now (a) snapshot the file + its descendants (folders expanded via `fileService.listDirectoryTree`) into `trash`, (b) delete the mirror rows, (c) **do not** call `adapter.deleteFile()`. Remote file stays.
- **Sync exclusion:** `fileService.replaceFilesForAccount` filters out incoming items whose `(cloud_account_id, remote_file_id)` exists in `trash`, so trashed files never resurrect from the next sync.
- **Restore:** `POST /files/trash/restore` `{ ids }` — for each trash row, re-insert a mirror row preserving original `virtual_path`/`remote_*` fields (new mirror id), then delete the trash row. Folders restore as leaf snapshots (children already individually snapshotted).
- **Permanent delete:** `DELETE /files/trash` `{ ids }` and `DELETE /files/trash/all` — call `adapter.deleteFile()` on the provider using the stored `cloud_account_id`/`remote_file_id`, then remove trash rows. Gracefully report accounts with `invalid_token`.
- **Auto-purge:** cron job in `syncService.scheduleSync()` (new `scheduleTrashPurge()`) runs daily; deletes trash rows older than `TRASH_RETENTION_DAYS` (env, **default 30**) using the permanent-delete path.

### Routes (in `fileRoutes.js`)

- `GET /files/trash` → `{ data: [...] }` (deleted_at desc)
- `POST /files/trash/restore` `{ ids }`
- `DELETE /files/trash` `{ ids }` (permanent)
- `DELETE /files/trash/all`
- Existing `DELETE /files/:id`, `POST /files/bulk/delete` repurposed to soft-delete.

### Frontend

- New route `/trash` + `TrashView.vue` (mirror Starred/Recent patterns; list of trashed items with provider badge + `deleted_at`).
- Selection bar actions: **Restore**, **Delete forever**, **Empty trash**.
- Context menu for trashed items: Restore, Delete forever.
- i18n EN + ID: `trash.*` keys (title, empty, restore, restoreSuccess, deleteForever, emptyTrash, confirmEmpty, emptyState, restoredAt, deletedAt).

---

## Feature 2 — Move & Copy

### Backend approach

Each adapter gains:

- `async moveFile(file, destinationParentId)` — native move when available (e.g. Google Drive parents update). Default fallback = copy-then-delete.
- `async copyFile(file, destinationParentId, destinationAccount)` — native copy when available (Google Drive `files.copy`); default fallback = streaming: `getDownloadStream(source)` → `uploadStream(target, stream, { name })`.

Cross-provider operations are always copy-then-delete (for move) because a streamed copy is the only universal mechanism. All operations resolve the destination into a concrete *target account + parent id*:

1. Resolve destination virtual path to a folder mirror row (`fileService` lookup by path).
2. Same account as source → same-provider move/copy.
3. Different account → stream to target, then (for move) delete source after successful copy.
4. Update mirror rows' `virtual_path`/`remote_parent_id` on success, then `syncAccount` the touched accounts to realign.

### Routes (in `fileRoutes.js`)

- `POST /files/:id/move` `{ destinationPath }` (+ bulk `POST /files/bulk/move` `{ ids, destinationPath }`)
- `POST /files/:id/copy` `{ destinationPath }` (+ bulk `POST /files/bulk/copy`)
- Response `{ data: { success, moved: n, errors: [...] } }` — per-item errors never abort the batch.

### Frontend

- `useFileActions`: `moveFiles`, `copyFiles`.
- New `MoveCopyModal.vue`: folder picker built on `fileService.listDirectoryTree` + breadcrumb navigation (same shape as existing breadcrumbs), "Move"/"Copy" button, error list display.
- Context menu: **Move to…**, **Copy to…**; selection bar: **Move to…**, **Copy to…**.
- i18n EN + ID: `move.*`, `copy.*` (title, pickDestination, move, copy, moving, copying, moved, copied, errors, sameFolder).

---

## Feature 3 — Batch download as ZIP

### Backend

- New `POST /files/bulk/download` `{ ids }` (auth, cookie session).
- Resolve each id; expand folders by reading the **SQLite mirror** (`listFilesByPath` walked recursively) — no provider calls for enumeration.
- Stream a ZIP with `archiver` (new backend dep): for each leaf, open `adapter.getDownloadStream` and `archive.append(stream, { name: relativePath })` with sanitized paths (no absolute/`..`/provider prefixes; collision-safe suffixing).
- Abort cleanly + `500` if a listed file cannot be resolved; otherwise, unresolvable names are written to a final `errors.txt` entry inside the ZIP rather than failing the whole download.
- Auth-context convenience: endpoint streams with `Content-Disposition: attachment; filename="omnicloud-download.zip"`.

### Frontend

- Selection bar action **Download (.zip)**; context menu on a folder also offers it.
- Flow: `fetch(api.bulkDownloadUrl(), { method:'POST', headers, body, credentials })` → Blob → object-URL save via existing download helper; progress via `useFileActionProgress`.
- i18n EN + ID: `download.zipLabel`, `download.preparingZip`, `download.zipReady`, `download.zipFailed`, `download.zipNote` (large-set notice).

---

## Feature 4 — Public share links

### Data model

New table `share_links`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT NOT NULL FK → users, CASCADE | |
| `file_id` | TEXT NOT NULL | Mirror id (info badge) |
| `cloud_account_id` | TEXT NOT NULL | For adapter construction |
| `remote_file_id` | TEXT NOT NULL | For stream lookup |
| `file_name` / `size` / `mime_type` / `is_folder` | TEXT/INT | Snapshot for public info |
| `token` | TEXT NOT NULL UNIQUE | 128-bit random (crypto.randomBytes → hex) |
| `password_hash` | TEXT | Optional; scrypt (reuse authService hasher) |
| `expires_at` | TEXT | Default now + 7 days |
| `created_at` / `last_used_at` | TEXT | |
| `download_count` | INTEGER DEFAULT 0 | |

### Routes (new `backend/src/routes/shareRoutes.js`, mounted at `/api/share`)

Auth (`requireAppUser`):
- `POST /share` `{ fileId, expiresInDays?, password? }` → `{ data: { token, url, expiresAt } }`
- `GET /share` → owned links
- `DELETE /share/:token`

Public:
- `GET /share/:token/info` → name/size/mime, expires_at, expired flag (no password leak)
- `GET /share/:token/download` → optional `X-Link-Password` header; scrypt verify; increments `download_count`; streams `adapter.getDownloadStream`

Adapter is reconstructed from stored `cloud_account_id` credentials at request time (works without a session). Expired/revoked/token-not-found → 404 (don't reveal existence). Sharing a folder → **400** "folders are not shareable"; the link only downloads the file itself.

### Frontend

- `api.js`: `createShareLink`, `listShareLinks`, `revokeShareLink`.
- Context menu **Get link** → `ShareLinkModal.vue`: copy URL, expiry picker (7d/30d/never), optional password field, generated state, revoke.
- `FileDetailsModal`: "Has link" badge when a live link exists for `file_id`.
- i18n EN + ID: `share.*` (title, copy, copied, expiry, password, optional, create, revoke, revoked, noExpiry, hasLink, downloadCount).

---

## Feature 5 — Quota warnings & hard limits

### Backend

- `uploadRoutes` `POST /uploads/initiate`: after `spaceAllocator.selectBestAccount(userId, requiredBytes)`, if the selected account's free space (`total_space - used_space`) < `requiredBytes` → respond **507** `{ error, data: { perAccount: [...] } }` with a per-account availability breakdown.
- Gate on env `QUOTA_HARD_LIMIT_ENABLED` (default `true`; when `false`, send the breakdown but allow).
- Helper `getAccountFreeBytes(account)` shared with allocation; expose a `soft` flag (`free/total < 0.15`, i.e. ≥85% used) for UI banners.

### Frontend

- `QuotaView` / `StorageAccountsPanel`: per-account bar states **Almost full** (≥85%) and **Full** (0 free); derived from existing `listAccounts`/usage data.
- Upload dialogs: show a notice when the best target is tight; on 507 show the availability breakdown.
- i18n EN + ID: `quota.full`, `quota.almostFull`, `quota.freeSpace`, `quota.blocked`, `quota.blockedBody`.

---

## Feature 6 — Duplicate detection

### Backend

- `GET /files/duplicates` (in `fileRoutes.js`): SQL `GROUP BY (file_name, size)` over the mirror for the user, files only (`is_folder = 0`, `size > 0`), groups with count ≥ 2. Returns `{ data: [ { key, file_name, size, count, totalBytes, items: [...] } ] }` sorted by totalBytes desc.

### Frontend

- New route `/duplicates` + `DuplicatesView.vue`: grouped cards (thumb/name/size × count), per-item provider badge, selection via existing `useFileSelection`, **Delete** action (uses new soft-delete), and a "**Keep one**" helper that pre-selects all but the newest item per group.
- i18n EN + ID: `duplicates.*` (title, empty, emptyState, keepOne, files, wasted, description).

---

## Frontend wiring (shared across features)

- `api.js`: add `listTrash`, `restoreTrashFiles`, `deleteTrashFiles`, `emptyTrash`, `moveFile`, `bulkMove`, `copyFile`, `bulkCopy`, `bulkDownload`, `duplicates`, `share.*` methods.
- `useFileActions.js` / `FileListContextMenu.vue` / `FileListSelectionBar.vue`: add contextual actions per view (Trash view shows trash actions; normal views show move/copy/download-zip/get-link).
- Router: `/trash`, `/duplicates` registrations (+ `DriveShell` nav items, `currentSection` ids).
- Env additions documented in `.env.example`: `TRASH_RETENTION_DAYS=30`, `QUOTA_HARD_LIMIT_ENABLED=true`.
- Every user-facing string added to both `en.json` and `id.json` (tab-indented JSON).

## Error handling

- Batch operations (move/copy/trash-restore/trash-purge) never abort mid-way; they return per-item `errors`.
- Share downloads: 404 for missing/expired/revoked; 401 (or 403) for wrong/missing password.
- Adapter failures (invalid_token, offline account) surface as actionable messages (e.g. "Reconnect this provider", matching existing `invalid_token` handling in sync).
- ZIP: server streams; client shows failure state if fetch rejects.

## Testing / verification

- Per wave: `node --check` on all touched backend files; `JSON.parse` both locale files; `npm run build` (frontend) succeeds.
- Manual smoke (documented in implementation plan): soft-delete → trash list → restore; move same/cross-provider; copy; bulk zip download; duplicate grouping; quota 507; share link create → anonymous download (with/without password) → revoke.

## Build order (3 commits, each pushed)

1. **Wave 1:** Trash & Restore → Move & Copy → Batch ZIP (commit `feat: trash, move/copy, and batch zip download`)
2. **Wave 2:** Quota warnings & hard limits → Duplicate detection (commit `feat: quota limits and duplicate detection`)
3. **Wave 3:** Share links (commit `feat: public share links`)