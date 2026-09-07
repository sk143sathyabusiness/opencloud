# OpenCloud Feature Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trash & restore, move & copy, batch ZIP download, quota warnings/hard limits, duplicate detection, and public share links to the OpenCloud web app.

**Architecture:** Backend is Express + better-sqlite3 (single metadata mirror synced from cloud providers). New features are split across three waves: (1) trash/move/copy/zip, (2) quota/duplicates, (3) share links. Soft-delete state lives in a dedicated `trash` table because `fileService.replaceFilesForAccount` wipes mirror rows on every sync. Adapter defaults provide streaming copy (download→upload) so move/copy work across providers.

**Tech Stack:** Express 4, better-sqlite3, node-cron, archiver (ZIP), Vue 3 + vue-router + vue-i18n, Tailwind (utility classes), @tabler/icons-vue, Vite 8.

## Global Constraints

- Repo: `github.com/sk143sathyabusiness/opencloud`, branch `main`, workdir `C:\Users\Sathya\Downloads\AI_gateway\opencloud_omnicloud_fork\opencloud`. Backend in `backend/`, frontend in `frontend/`.
- Node ESM (`"type": "module"`) in backend; all imports use `.js` extension. Frontend is Vue/Vite ESM.
- Tabs for indentation (both backend JS and locale JSON). No code comments unless the surrounding file already documents.
- Every user-facing string goes in BOTH `frontend/src/locales/en.json` and `frontend/src/locales/id.json` (tab-indented JSON, verified with `JSON.parse`).
- Frontend API calls set `credentials: 'include'` and `Content-Type: application/json` (see `frontend/src/services/api.js` `request()`); the JSON helper throws `Error` with `.status` populated.
- Backend route errors flow through the single error middleware in `backend/src/app.js:50-56`; auth errors surface as 401, validation-ish messages as 400.
- No test framework exists in the repo. Verification is `node --check`, `JSON.parse` of both locales, `npm run build` (frontend), `node --test` (backend `tests/` using Node's built-in runner + better-sqlite3 against a throwaway DB via `DATABASE_PATH`), and curl smoke against a running backend.
- Do not mimic the frontend pixel-perfect design of existing views; reuse existing list/item/card markup conventions. Keep new components smaller than ~300 lines.
- Conventional commits. Wave commits: `feat: trash, move/copy, and batch zip download`, `feat: quota limits and duplicate detection`, `feat: public share links`. Push each wave to `main`.
- Backend dependencies live in `backend/package.json`. Add `archiver` only in Wave 1 Task 5; no other new backend deps.
- DB schema changes are additive `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` statements inside the single `db.exec(...)` block in `backend/src/config/database.js:16-79`.

---
---

# Wave 1 — Trash, Move/Copy, ZIP

## Task 1: Trash table + trashService + sync exclusion

**Files:**
- Modify: `backend/src/config/database.js:16-79` (add `trash` table + index)
- Create: `backend/src/services/trashService.js`
- Modify: `backend/src/services/fileService.js:217-255` (`replaceFilesForAccount` excludes trashed ids)
- Modify: `backend/src/config/env.js:16-45` (add `trashRetentionDays`)
- Test: `backend/tests/trash.test.mjs`
- Modify: `backend/package.json` (add `"test": "node --test tests/"` script)

**Interfaces:**
- Consumes: `fileService.listAllFiles(userId)`, `fileService.createFileMetadata(record)`, `fileService.getFileById`, `db` from `../config/database.js`, `randomUUID` from `crypto`, `env.trashRetentionDays`.
- Produces:
  - `trashService.listTrashedFiles(userId)` → `[{ id, user_id, cloud_account_id, remote_file_id, remote_parent_id, virtual_path, file_name, is_folder, size, mime_type, remote_created_time, remote_modified_time, deleted_at, provider }]` (deleted_at DESC)
  - `trashService.softDeleteFilesByIds(userId, ids)` → `{ trashed: number, skipped: number }`
  - `trashService.restoreTrashedFiles(userId, ids)` → `{ restored: number }`
  - `trashService.getTrashedRowsByIds(userId, ids)` → rows (for permanent delete)
  - `trashService.removeTrashedRows(userId, ids)` → `void`
  - `trashService.getExpiredTrashRows(userId?, cutoffIso)` → rows older than cutoff
  - `trashService.getTrashedRemoteIds(userId, cloudAccountId)` → `Set<remote_file_id>`
  - `env.trashRetentionDays: number` (default 30)

- [ ] **Step 1: Create the `trash` table**

Modify `backend/src/config/database.js`, inside the `db.exec(\` \`)` block after the `user_settings` table (line 78), add:

```sql
  CREATE TABLE IF NOT EXISTS trash (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    cloud_account_id TEXT NOT NULL,
    remote_file_id TEXT NOT NULL,
    remote_parent_id TEXT,
    virtual_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    is_folder INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    remote_created_time TEXT,
    remote_modified_time TEXT,
    deleted_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(cloud_account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    UNIQUE(user_id, cloud_account_id, remote_file_id)
  );
```

And in the index block (before line 100) add:

```sql
  CREATE INDEX IF NOT EXISTS idx_trash_user_deleted_at ON trash(user_id, deleted_at);
```

- [ ] **Step 2: Add env var**

In `backend/src/config/env.js`, inside the `env` object (alphabetical-ish, after `telegramChatId`), add:

```js
	trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS || 30),
	quotaHardLimitEnabled: process.env.QUOTA_HARD_LIMIT_ENABLED !== 'false',
```

(`quotaHardLimitEnabled` is used in Wave 2; adding both now avoids a second edit.)

- [ ] **Step 3: Write the failing test**

Create `backend/tests/trash.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = `:memory:`;

const { db } = await import('../src/config/database.js');
const { listAllFiles, createFileMetadata, replaceFilesForAccount, getFileById } = await import('../src/services/fileService.js');
const trash = await import('../src/services/trashService.js');

const USER = 'u-trash-test';
const ACCOUNT = 'acc-trash-test';
const ROW = (fileName, virtualPath, isFolder = 0, id = undefined) => ({
	id,
	user_id: USER,
	virtual_path: virtualPath,
	file_name: fileName,
	is_folder: isFolder,
	is_starred: 0,
	size: isFolder ? 0 : 100,
	mime_type: isFolder ? null : 'text/plain',
	cloud_account_id: ACCOUNT,
	remote_file_id: `${fileName}-remote`,
	remote_parent_id: null,
	remote_created_time: null,
	remote_modified_time: null,
});

test('softDelete snapshots folder subtree and removes mirror rows', () => {
	createFileMetadata(ROW('Project', '/', 1, 'folder-root'));
	createFileMetadata(ROW('a.txt', '/Project/', 0, 'file-a'));
	createFileMetadata(ROW('b.txt', '/Project/', 0, 'file-b'));
	createFileMetadata(ROW('keep.txt', '/', 0, 'file-keep'));

	const { trashed, skipped } = trash.softDeleteFilesByIds(USER, ['folder-root']);
	assert.equal(trashed, 3);
	assert.equal(skipped, 0);

	const remaining = listAllFiles(USER).map((f) => f.id);
	assert.deepEqual(remaining, ['file-keep']);

	const listed = trash.listTrashedFiles(USER);
	assert.equal(listed.length, 3);
	assert.equal(listed[0].remote_file_id, 'a.txt-remote');
	assert.equal(listed[0].provider, null);
});

test('trashed files are excluded from replaceFilesForAccount (sync)', () => {
	replaceFilesForAccount(USER, ACCOUNT, [
		ROW('a.txt', '/Project/'),
		ROW('keep.txt', '/'),
	]);
	const ids = listAllFiles(USER).map((f) => f.file_name).sort();
	assert.deepEqual(ids, ['keep.txt']);
});

test('restore re-inserts mirror rows and clears trash', () => {
	const { restored } = trash.restoreTrashedFiles(USER, [
		trash.listTrashedFiles(USER).find((f) => f.file_name === 'a.txt').id,
	]);
	assert.equal(restored, 1);
	assert.ok(getFileById(USER, trash.listTrashedFiles(USER).find((f) => f.file_name === 'a.txt').id) === undefined);
	const restoredFile = listAllFiles(USER).find((f) => f.file_name === 'a.txt');
	assert.ok(restoredFile, 'a.txt restored');
	assert.equal(restoredFile.virtual_path, '/Project/');
	assert.equal(restoredFile.remote_file_id, 'a.txt-remote');
});

test('permanent delete removes trash rows and returns them for provider calls', () => {
	const rows = trash.getTrashedRowsByIds(USER, []);
	trash.softDeleteFilesByIds(USER, ['file-keep']);
	const target = trash.listTrashedFiles(USER);
	const got = trash.getTrashedRowsByIds(USER, target.map((f) => f.id));
	assert.equal(got.length, 2);
	trash.removeTrashedRows(USER, got.map((f) => f.id));
	assert.equal(trash.listTrashedFiles(USER).length, 0);
});

test('getTrashedRemoteIds returns a Set', () => {
	trash.softDeleteFilesByIds(USER, ['file-keep']);
	const set = trash.getTrashedRemoteIds(USER, ACCOUNT);
	assert.ok(set instanceof Set);
	assert.ok(set.has('keep.txt-remote'));
});
```

Note: the test imports `database.js` which reads `DATABASE_PATH` at module load; the `await import` must be executed **after** setting `process.env.DATABASE_PATH`. Use `:memory:` so no file is created.

- [ ] **Step 4: Run test to verify it fails**

Run (from `backend/`):
```bash
npm install
node --test tests/trash.test.mjs
```
Expected: FAIL — `Cannot find module '../src/services/trashService.js'`.

- [ ] **Step 5: Implement `trashService.js`**

Create `backend/src/services/trashService.js`:

```js
import { randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { listAllFiles, createFileMetadata, getFileById } from './fileService.js';

function joinPath(parentPath, name) {
	const base = parentPath === '/' || !parentPath ? '/' : parentPath;
	const clean = base.endsWith('/') ? base : `${base}/`;
	return `${clean}${String(name).replace(/^\/+/, '')}`;
}

export function listTrashedFiles(userId) {
	return db
		.prepare(`
			SELECT t.*, ca.provider
			FROM trash t
			LEFT JOIN cloud_accounts ca ON ca.id = t.cloud_account_id
			WHERE t.user_id = ?
			ORDER BY t.deleted_at DESC, t.file_name COLLATE NOCASE
		`)
		.all(userId);
}

export function getTrashedRemoteIds(userId, cloudAccountId) {
	const rows = db
		.prepare('SELECT remote_file_id FROM trash WHERE user_id = ? AND cloud_account_id = ?')
		.all(userId, cloudAccountId);
	return new Set(rows.map((row) => row.remote_file_id));
}

export function softDeleteFilesByIds(userId, ids) {
	const all = listAllFiles(userId);
	const byId = new Map(all.map((row) => [row.id, row]));
	const insert = db.prepare(`
		INSERT OR IGNORE INTO trash (
			id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
			virtual_path, file_name, is_folder, size, mime_type,
			remote_created_time, remote_modified_time, deleted_at
		) VALUES (
			@id, @user_id, @cloud_account_id, @remote_file_id, @remote_parent_id,
			@virtual_path, @file_name, @is_folder, @size, @mime_type,
			@remote_created_time, @remote_modified_time, @deleted_at
		)
	`);

	const run = db.transaction(() => {
		let trashed = 0;
		const removeIds = [];
		for (const rawId of ids || []) {
			const root = byId.get(rawId);
			if (!root) continue;

			const folderPath = root.is_folder
				? joinPath(root.virtual_path, root.file_name)
				: null;
			const targets = [root];
			if (folderPath) {
				for (const row of all) {
					if (row.virtual_path.startsWith(folderPath)) targets.push(row);
				}
			}
			for (const target of targets) {
				if (!byId.has(target.id)) continue;
				insert.run({
					id: randomUUID(),
					user_id: userId,
					cloud_account_id: target.cloud_account_id,
					remote_file_id: target.remote_file_id,
					remote_parent_id: target.remote_parent_id,
					virtual_path: target.virtual_path,
					file_name: target.file_name,
					is_folder: target.is_folder ? 1 : 0,
					size: Number(target.size || 0),
					mime_type: target.mime_type || null,
					remote_created_time: target.remote_created_time || null,
					remote_modified_time: target.remote_modified_time || null,
					deleted_at: new Date().toISOString(),
				});
				byId.delete(target.id);
				removeIds.push(target.id);
				trashed += 1;
			}
		}
		if (removeIds.length) {
			const del = db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?');
			for (const id of removeIds) del.run(userId, id);
		}
		return trashed;
	});

	const trashed = run();
	return { trashed, skipped: (ids || []).length - trashed };
}

export function restoreTrashedFiles(userId, ids) {
	const rows = getTrashedRowsByIds(userId, ids);
	const restore = db.transaction(() => {
		let restored = 0;
		for (const row of rows) {
			createFileMetadata({
				user_id: userId,
				virtual_path: row.virtual_path,
				file_name: row.file_name,
				is_folder: row.is_folder,
				size: row.size,
				mime_type: row.mime_type,
				cloud_account_id: row.cloud_account_id,
				remote_file_id: row.remote_file_id,
				remote_parent_id: row.remote_parent_id,
				remote_created_time: row.remote_created_time,
				remote_modified_time: row.remote_modified_time,
			});
			db.prepare('DELETE FROM trash WHERE user_id = ? AND id = ?').run(userId, row.id);
			restored += 1;
		}
		return restored;
	});
	return { restored: restore() };
}

export function getTrashedRowsByIds(userId, ids) {
	if (!ids?.length) return [];
	const placeholders = ids.map(() => '?').join(', ');
	return db
		.prepare(`SELECT * FROM trash WHERE user_id = ? AND id IN (${placeholders})`)
		.all(userId, ...ids);
}

export function removeTrashedRows(userId, ids) {
	if (!ids?.length) return;
	const placeholders = ids.map(() => '?').join(', ');
	db.prepare(`DELETE FROM trash WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids);
}

export function getExpiredTrashRows(userId, cutoffIso) {
	return db
		.prepare('SELECT * FROM trash WHERE user_id = ? AND deleted_at < ?')
		.all(userId, cutoffIso);
}
```

- [ ] **Step 6: Add sync exclusion to `replaceFilesForAccount`**

Modify `backend/src/services/fileService.js:217` — add the trashed-id filter at the top of the function body:

```js
export function replaceFilesForAccount(userId, cloudAccountId, records) {
	const trashedIds = getTrashedRemoteIds(userId, cloudAccountId);
	const normalizedRecords = records
		.filter((record) => !trashedIds.has(record.remote_file_id))
		.map((record) => ({
```

Keep the rest of the mapping unchanged. Add the import at the top of the file (but watch for a circular import: `trashService` imports from `fileService`, so `fileService` must NOT import from `trashService` at module top — instead require it lazily inside the function):

```js
import { getTrashedRemoteIds } from './trashService.js';
```

If this produces a circular-dependency runtime error, change `fileService.js` to do `const { getTrashedRemoteIds } = await import('./trashService.js')` — no, sync function cannot await. The real fix: move `getTrashedRemoteIds` from `trashService.js` into `fileService.js` itself (it only touches `db`), and have `trashService.js` import it from `fileService.js`. **Use this ordering:** `fileService.js` owns `getTrashedRemoteIds`; `trashService.js` imports it. See Step 7.

- [ ] **Step 7: Fix ownership of `getTrashedRemoteIds` (circular import)**

Move the `getTrashedRemoteIds` function into `backend/src/services/fileService.js` (it is a thin `db` query; `fileService` already imports `db`). Remove it from `trashService.js`. Update `trashService.js`:

```js
import { listAllFiles, createFileMetadata, getTrashedRemoteIds } from './fileService.js';
```

`softDeleteFilesByIds`, `restoreTrashedFiles`, etc. remain in `trashService.js`. `fileService.js` uses `getTrashedRemoteIds` internally (Step 6) with no import needed.

- [ ] **Step 8: Run test to verify it passes**

Run (from `backend/`):
```bash
node --test tests/trash.test.mjs
```
Expected: PASS (5 tests). Also run `node --check src/services/trashService.js` and `node --check src/services/fileService.js`.
Then temporarily revert nothing; commit.

- [ ] **Step 9: Add test script + commit**

In `backend/package.json` `scripts`, add:
```json
	"test": "node --test tests/"
```
Commit:
```bash
git add backend/src/config/database.js backend/src/config/env.js backend/src/services/trashService.js backend/src/services/fileService.js backend/tests/trash.test.mjs backend/package.json
git commit -m "feat: trash table, soft-delete service, sync exclusion"
```

---

## Task 2: Trash routes + purge cron

**Files:**
- Modify: `backend/src/routes/fileRoutes.js` (repurpose `DELETE /files/:id` + `POST /files/bulk/delete`, add `GET /files/trash`, `POST /files/trash/restore`, `DELETE /files/trash`, `DELETE /files/trash/all`)
- Modify: `backend/src/services/syncService.js` (add `scheduleTrashPurge()` and call from `scheduleSync()`)

**Interfaces:**
- Consumes: `trashService` from Task 1, `getFileContext` + `ensureFileContext` (already in `fileRoutes.js`), `getAccountById` from `../services/accountService.js`, `createAdapter` from `../services/adapterRegistry.js`, `listTrashedFiles`/`restoreTrashedFiles`/`getTrashedRowsByIds`/`removeTrashedRows`/`getExpiredTrashRows`.
- Produces: HTTP routes (auth-required via existing `router.use(requireAppUser)` at `fileRoutes.js:12`).

- [ ] **Step 1: Write failing test**

Add `backend/tests/trashRoutes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_MODE = 'local';

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata } = await import('../src/services/fileService.js');
const { getTrashedRowsByIds } = await import('../src/services/trashService.js');

async function login() {
	const res = await request(createApp()).post('/api/auth/login').send({ email: 'local@omnicloud.local', password: '' });
	return res.headers['set-cookie'][0].split(';')[0];
}

test('soft delete -> trash list -> restore round-trip', async () => {
	createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'victim.txt',
		is_folder: 0,
		size: 10,
		mime_type: 'text/plain',
		cloud_account_id: 'no-such-account',
		remote_file_id: 'victim-remote',
	});
	const cookie = await login();
	const app = createApp();

	const del = await request(app).delete('/api/files/nope').set('Cookie', cookie).expect(400);

	const listRes = await request(app).get('/api/files/trash').set('Cookie', cookie);
	assert.equal(listRes.status, 200);
	assert.ok(Array.isArray(listRes.body.data));
});
```

Note: `supertest` is not in the repo. Instead of adding a dev dependency, keep the smoke manual — see Step 5. If you want an automated route test, add `supertest` to `backend/package.json` devDependencies with `npm i -D supertest`. The plan's default is the manual smoke in Step 5.

- [ ] **Step 2: Repurpose delete handlers to soft delete**

In `backend/src/routes/fileRoutes.js`:
- Replace the body of `router.delete('/files/:id', ...)` (line 360-373) with:

```js
router.delete('/files/:id', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}
		softDeleteFilesByIds(req.user.id, [req.params.id]);
		return res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
});
```
- Find the existing `POST /files/bulk/delete` handler (grep `bulk/delete`) and replace its body so it calls `softDeleteFilesByIds(req.user.id, ids)` and returns `{ data: { success: true, deleted: result.trashed } }` where `result = softDeleteFilesByIds(...)`.
- Add import: `import { softDeleteFilesByIds } from '../services/trashService.js';`
- Note: `deleteContextFile` and `syncAccount` become unused for delete; remove the old import of `deleteContextFile` if the tree-shake complains (Node does not complain about unused imports — safe to leave, but prefer removing).

- [ ] **Step 3: Add trash routes**

Append before `router.delete('/files/:id')` in `fileRoutes.js`:

```js
router.get('/files/trash', (req, res) => {
	return res.json({ data: listTrashedFiles(req.user.id) });
});

router.post('/files/trash/restore', (req, res) => {
	const { ids } = req.body;
	if (!Array.isArray(ids) || !ids.length) {
		return res.status(400).json({ error: 'ids are required' });
	}
	return res.json({ data: restoreTrashedFiles(req.user.id, ids) });
});

router.delete('/files/trash', async (req, res, next) => {
	try {
		const { ids } = req.body;
		if (!Array.isArray(ids) || !ids.length) {
			return res.status(400).json({ error: 'ids are required' });
		}
		const rows = getTrashedRowsByIds(req.user.id, ids);
		const errors = [];
		for (const row of rows) {
			const account = getAccountById(req.user.id, row.cloud_account_id);
			try {
				if (account) {
					const adapter = createAdapter(account);
					await adapter.deleteFile({
						remote_file_id: row.remote_file_id,
						remote_parent_id: row.remote_parent_id,
						file_name: row.file_name,
						virtual_path: row.virtual_path,
						is_folder: Boolean(row.is_folder),
					});
				}
			} catch (error) {
				errors.push({ id: row.id, file_name: row.file_name, error: error.message });
			}
		}
		removeTrashedRows(req.user.id, rows.map((row) => row.id));
		return res.json({ data: { success: true, permanentlyDeleted: rows.length, errors } });
	} catch (error) {
		next(error);
	}
});

router.delete('/files/trash/all', async (req, res, next) => {
	try {
		const rows = listTrashedFiles(req.user.id);
		const reqLike = {
			user: req.user,
			body: { ids: rows.map((row) => row.id) },
		};
		const resLike = { status: () => ({ json: (body) => body }) };
		await handlePermanentDelete(reqLike, resLike);
		removeTrashedRows(req.user.id, rows.map((row) => row.id));
		return res.json({ data: { success: true, permanentlyDeleted: rows.length } });
	} catch (error) {
		next(error);
	}
});
```

Where `handlePermanentDelete` is a small shared helper. To avoid the awkward `reqLike`/`resLike` shim, refactor: extract the permanent-delete loop of the `DELETE /files/trash` route into a local async function `permanentlyDeleteRows(userId, rows)` that returns `{ count, errors }`, then call it from both `DELETE /files/trash` and `DELETE /files/trash/all`.

Add imports to `fileRoutes.js`:
```js
import { listTrashedFiles, restoreTrashedFiles, getTrashedRowsByIds, removeTrashedRows, softDeleteFilesByIds } from '../services/trashService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
```
(`getAccountById` and `createAdapter` are likely already imported at `fileRoutes.js:3-4`.)

- [ ] **Step 4: Add purge cron**

In `backend/src/services/syncService.js`:

```js
import { getExpiredTrashRows, getTrashedRowsByIds } from './trashService.js';
import { getActiveAccounts } from './accountService.js';

export async function purgeExpiredTrash(userId) {
	const cutoff = new Date(Date.now() - env.trashRetentionDays * 24 * 60 * 60 * 1000).toISOString();
	const rows = getExpiredTrashRows(userId, cutoff);
	if (!rows.length) return { purged: 0, errors: [] };

	const accountIds = [...new Set(rows.map((row) => row.cloud_account_id))];
	const accounts = accountIds
		.map((id) => getActiveAccounts(userId).find((account) => account.id === id))
		.filter(Boolean);
	const adapterByAccount = new Map(accounts.map((account) => [account.id, createAdapter(account)]));
	const errors = [];
	for (const row of rows) {
		const adapter = adapterByAccount.get(row.cloud_account_id);
		try {
			if (adapter) {
				await adapter.deleteFile({
					remote_file_id: row.remote_file_id,
					file_name: row.file_name,
					is_folder: Boolean(row.is_folder),
				});
			}
		} catch (error) {
			errors.push({ id: row.id, error: error.message });
		}
	}
	getTrashedRowsByIds(userId, rows.map((row) => row.id)); // force import usage
	removeExpiredRows(userId, cutoff);
	return { purged: rows.length, errors };
}

function removeExpiredRows(userId, cutoffIso) {
	// local-only helper to delete rows matching cutoff; reuse removeTrashedRows via ids
	const { db } = null; // replaced below
}
```

This is drifting. Simplify: `purgeExpiredTrash` should call `removeTrashedRows(userId, rows.map(r => r.id))` after the provider attempts. Add `removeTrashedRows` to the import. Final purge function:

```js
export async function purgeExpiredTrash(userId) {
	const cutoff = new Date(Date.now() - env.trashRetentionDays * 24 * 60 * 60 * 1000).toISOString();
	const rows = getExpiredTrashRows(userId, cutoff);
	if (!rows.length) return { purged: 0, errors: [] };

	const accounts = getActiveAccounts(userId);
	const adapterByAccount = new Map(accounts.map((account) => [account.id, createAdapter(account)]));
	const errors = [];
	for (const row of rows) {
		const adapter = adapterByAccount.get(row.cloud_account_id);
		try {
			if (adapter) {
				await adapter.deleteFile({
					remote_file_id: row.remote_file_id,
					file_name: row.file_name,
					is_folder: Boolean(row.is_folder),
				});
			}
		} catch (error) {
			errors.push({ id: row.id, error: error.message });
		}
	}
	removeTrashedRows(userId, rows.map((row) => row.id));
	return { purged: rows.length, errors };
}
```

Then extend `scheduleSync()` in `syncService.js` to also schedule the purge (runs daily at 03:00):

```js
export function scheduleTrashPurge() {
	cron.schedule('0 3 * * *', async () => {
		if (env.appMode === 'local') {
			await purgeExpiredTrash(LOCAL_USER_ID).catch((error) => {
				console.error('Trash purge failed:', error.message);
			});
			return;
		}
		const userIds = getTrashUserIds();
		for (const userId of userIds) {
			await purgeExpiredTrash(userId).catch((error) => {
				console.error(`Trash purge failed for ${userId}:`, error.message);
			});
		}
	});
}
```

Add `getTrashUserIds()` to `trashService.js`:
```js
export function getTrashUserIds() {
	return db.prepare('SELECT DISTINCT user_id FROM trash').all().map((row) => row.user_id);
}
```

Call `scheduleTrashPurge()` at the end of the existing `scheduleSync()` in `syncService.js` (the file exports both; wire both in `index.js` startup — grep for `scheduleSync()` invocation and call `scheduleTrashPurge()` next to it).

Also update the import line at `syncService.js:6`:
```js
import { clearFilesForAccount, replaceFilesForAccount } from './fileService.js';
```
stays; add:
```js
import { getExpiredTrashRows, removeTrashedRows, getTrashUserIds } from './trashService.js';
```
and remove the unused `getTrashedRowsByIds`/`getExpiredTrashRows` audience by using only what's referenced. Remove the erroneous draft block above.

- [ ] **Step 5: Manual smoke (documented, not automated)**

Run backend with `npm run dev` in `backend/`. With curl (needs a logged-in cookie from Firefox devtools) or the UI:
1. `DELETE /api/files/:id` → file disappears from list; `GET /api/files/trash` shows it.
2. `POST /api/files/trash/restore` with its trash id → reappears in the original folder.
3. `DELETE /api/files/trash` with id → row gone, provider delete attempted.
4. `DELETE /api/files/trash/all` → trash empty.
Verify a folder delete moves all descendants into trash and restore brings back each leaf.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/fileRoutes.js backend/src/services/syncService.js backend/src/services/trashService.js
git commit -m "feat: trash routes, soft delete handlers, daily purge cron"
```

---

## Task 3: Trash UI (API client, locale keys, router, TrashView, selection actions)

**Files:**
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/components/DriveShell.vue:268-275` (nav item)
- Modify: `frontend/src/views/MyDriveView.vue` (pass trash actions to context menu & selection bar — grep `deleteSelectedFile`)
- Create: `frontend/src/views/TrashView.vue`

**Interfaces:**
- Consumes: `api.listTrash/restoreTrashFiles/deleteTrashFiles/emptyTrash` (this task), `useFileSelection` composable, `t` from `useI18n`.
- Produces: `TrashView.vue` (exported route component), api methods below.

- [ ] **Step 1: Add API methods**

In `frontend/src/services/api.js`, inside `api` object (after `deleteFiles`):

```js
	listTrash() {
		return request('/files/trash');
	},
	restoreTrashFiles(ids) {
		return request('/files/trash/restore', {
			method: 'POST',
			body: JSON.stringify({ ids }),
		});
	},
	deleteTrashFiles(ids) {
		return request('/files/trash', {
			method: 'DELETE',
			body: JSON.stringify({ ids }),
		});
	},
	emptyTrash() {
		return request('/files/trash/all', {
			method: 'DELETE',
		});
	},
```

- [ ] **Step 2: Add locale keys**

Append a `"trash"` section to `en.json` (tab-indented; add after the `copy`/`move` sections whichever exists — near `"share"` placeholder later; for now append before the closing `}`):

```json
	"trash": {
		"title": "Trash",
		"empty": "Trash is empty",
		"emptyState": "Files you delete land here for up to 30 days.",
		"restore": "Restore",
		"restored": "Restored",
		"restoreSuccess": "Restored items to their original location.",
		"deleteForever": "Delete forever",
		"confirmDeleteForever": "Permanently delete {name}? This cannot be undone.",
		"emptyTrash": "Empty trash",
		"confirmEmpty": "Permanently delete everything in trash? This cannot be undone.",
		"deletedAt": "Deleted {date}",
		"restoredAt": "Restored {date}"
	},
```

Mirror the same keys in `id.json` with Indonesian translations:
```json
	"trash": {
		"title": "Sampah",
		"empty": "Sampah kosong",
		"emptyState": "File yang Anda hapus akan tersimpan di sini hingga 30 hari.",
		"restore": "Pulihkan",
		"restored": "Dipulihkan",
		"restoreSuccess": "Item dipulihkan ke lokasi asalnya.",
		"deleteForever": "Hapus permanen",
		"confirmDeleteForever": "Hapus permanen {name}? Tindakan ini tidak dapat dibatalkan.",
		"emptyTrash": "Kosongkan sampah",
		"confirmEmpty": "Hapus permanen semua isi sampah? Tindakan ini tidak dapat dibatalkan.",
		"deletedAt": "Dihapus {date}",
		"restoredAt": "Dipulihkan {date}"
	},
```

Verify both files parse: `node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json','utf8'))"`.

- [ ] **Step 3: Register route + nav item**

`frontend/src/router/index.js` — import and register:

```js
import TrashView from '../views/TrashView.vue';
// routes array — right after the '/quota' entry:
		{
			path: '/trash',
			name: 'trash',
			component: TrashView,
		},
```

`frontend/src/components/DriveShell.vue` `navItems` (line 268) — add before `storage`:

```js
	{ id: 'trash', label: t('nav.trash'), icon: IconTrash, activeIcon: IconTrashFilled, to: '/trash' },
```

Import `IconTrash, IconTrashFilled` from `@tabler/icons-vue` in DriveShell. Add locale keys:
- `en.json` `"nav": { "trash": "Trash", ... }`
- `id.json` `"nav": { "trash": "Sampah", ... }`
(Add `"trash"` inside the existing `"nav"` objects; grep `"nav": {`.)

Note: `DriveShell.vue` already imports `IconTrash` (used elsewhere). Reuse it for `icon`; there may be no `IconTrashFilled` export — if missing, use `IconTrash` for both icon fields.

- [ ] **Step 4: Create `TrashView.vue`**

```vue
<script setup>
import { ref, computed } from 'vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { useFileSelection } from '../composables/useFileSelection';
import DriveShell from '../components/DriveShell.vue';
import FileListContextMenu from '../components/FileListContextMenu.vue';
import FileListSelectionBar from '../components/FileListSelectionBar.vue';
import { formatFileSize, formatDate } from '../utils/formatters'; // reuse existing helpers if present

const { t } = useI18n();
const items = ref([]);
const loading = ref(true);
const errorRef = ref('');

const {
	selectedFileIds,
	lastSelectedFileId,
	selectedFiles,
	selectedCount,
	isSelected,
	replaceSelection,
	toggleSelection,
	selectRange,
	selectItem,
	clearSelection,
} = useFileSelection({ sourceList: items });

const isBusy = ref(false);

async function refresh() {
	loading.value = true;
	errorRef.value = '';
	try {
		const res = await api.listTrash();
		items.value = res.data || [];
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		loading.value = false;
	}
}

async function run(then) {
	isBusy.value = true;
	try {
		await then();
		clearSelection();
		await refresh();
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		isBusy.value = false;
	}
}

async function restoreSelected() {
	await run(() => api.restoreTrashFiles(selectedFiles.value.map((f) => f.id)));
}

async function deleteSelectedForever() {
	if (!selectedCount.value) return;
	if (!window.confirm(t('trash.confirmDeleteForever', { name: t('common.items') }))) { clearSelection(); return; }
	await run(() => api.deleteTrashFiles(selectedFiles.value.map((f) => f.id)));
}

async function emptyTrash() {
	if (!items.value.length) return;
	if (!window.confirm(t('trash.confirmEmpty'))) { clearSelection(); return; }
	await run(() => api.emptyTrash());
}

const canActOnSelection = computed(() => selectedCount.value > 0);

onMounted(refresh);
</script>

<template>
	<DriveShell current-section="trash">
		<div class="mx-auto max-w-6xl px-4 py-6">
			<div class="flex items-center justify-between gap-4">
				<div>
					<h1 class="text-2xl font-semibold">{{ t('trash.title') }}</h1>
					<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('trash.emptyState') }}</p>
				</div>
				<button
					v-if="items.length"
					type="button"
					class="rounded-full bg-[#c5221f] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
					:disabled="isBusy"
					@click="emptyTrash"
				>{{ t('trash.emptyTrash') }}</button>
			</div>

			<div v-if="selectedCount" class="sticky top-20 z-30 mt-4">
				<FileListSelectionBar
					:selected-count="selectedCount"
					:can-delete="canActOnSelection"
					@clear="clearSelection"
					@delete="deleteSelectedForever"
				>
					<template #prefix>
						<button type="button" class="inline-flex size-9 items-center justify-center rounded-full transition hover:bg-[#d2e3fc] dark:hover:bg-sky-500/20" :title="t('trash.restore')" @click="restoreSelected">
							<IconRestore :size="18" :stroke="2" />
						</button>
					</template>
				</FileListSelectionBar>
			</div>

			<div v-if="errorRef" class="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

			<div v-if="loading" class="mt-8 text-center text-sm text-[#5f6368] dark:text-slate-400">{{ t('common.loading') }}</div>
			<div v-else-if="!items.length" class="mt-16 text-center">
				<p class="text-sm font-medium">{{ t('trash.empty') }}</p>
				<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('trash.emptyState') }}</p>
			</div>
			<div v-else class="mt-4 divide-y divide-[#e8f0fe] overflow-hidden rounded-2xl border border-[#e8f0fe] bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
				<div
					v-for="item in items"
					:key="item.id"
					class="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-[#f8fafd] dark:hover:bg-slate-700/40"
					:class="isSelected(item.id) ? 'bg-[#e8f0fe] dark:bg-blue-500/15' : ''"
					@click="selectRange(item, $event.shiftKey)"
					@contextmenu.prevent="selectItem(item)"
				>
					<div class="grid size-9 shrink-0 place-items-center rounded-2xl bg-[#e8f0fe] text-[#1a73e8] dark:bg-blue-500/15 dark:text-blue-300">
						{{ item.provider ? item.provider : '?' }}
					</div>
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium">{{ item.file_name }}</div>
						<div class="truncate text-xs text-[#5f6368] dark:text-slate-400">{{ item.virtual_path }}</div>
					</div>
					<div class="shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ item.is_folder ? t('common.folder') : formatSize(item.size) }}</div>
					<div class="shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ formatDate(item.deleted_at) }}</div>
				</div>
			</div>
		</div>
	</DriveShell>
</template>
```

Where `formatSize` and `formatDate` reuse helpers already imported in `MyDriveView.vue` (grep `formatFileSize`/`formatDate` in `frontend/src` and import the same ones) and `IconRestore` is imported from `@tabler/icons-vue` (start a new `<script setup>` import block). `useFileSelection` expects `sourceList` as a ref-like with `.value` array — passing `items` (a `ref`) matches its existing usage (check `frontend/src/composables/useFileSelection.js` calls in `MyDriveView.vue`).

Add context-menu actions for trashed items in `TrashView.vue` only if the existing `FileListContextMenu` supports action slots; otherwise rely on the selection bar (acceptable minimum).

- [ ] **Step 5: Wire delete quick-action text in MyDriveView**

Locate where `MyDriveView.vue` builds the context menu (grep `deleteSelectedFile`). Update the confirm message for the "move to trash" semantic is optional; keep the existing `drive.deleteConfirm` copy — do not rewire naming. No change required for correctness.

- [ ] **Step 6: Verify + commit**

Run (from `frontend/`):
```bash
npm run build
```
Expected: PASS. Then:
```bash
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('src/locales/id.json','utf8'));console.log('locales ok')"
```
Commit:
```bash
git add frontend/src/services/api.js frontend/src/locales/en.json frontend/src/locales/id.json frontend/src/router/index.js frontend/src/components/DriveShell.vue frontend/src/views/TrashView.vue
git commit -m "feat: trash view with restore and permanent-delete actions"
```

---

## Task 4: Adapter move/copy + backend move/copy routes

**Files:**
- Modify: `backend/src/adapters/BaseCloudAdapter.js`
- Modify: `backend/src/services/fileService.js` (add `getFolderByPath`, `getDescendants`)
- Modify: `backend/src/routes/fileRoutes.js` (add `POST /files/:id/move`, `POST /files/:id/copy`, `POST /files/bulk/move`, `POST /files/bulk/copy`)

**Interfaces:**
- Consumes: `selectBestAccount` (already imported), `getFileContext`, `ensureFileContext`, `getAccountById`, `createAdapter` (imported), `syncAccount` (imported), `listAllFiles` from fileService.
- Produces:
  - Adapter methods `moveFile(file, destinationParentId)` and `copyFile(file, destinationParentId, destinationAccount)` that all providers inherit.
  - `fileService.getFolderByPath(userId, virtualPath)` → folder row or `null`.
  - `fileService.getDescendants(rows, rootRow)` → array of rows under a folder (leaf snapshots).
  - HTTP: `POST /files/:id/move|copy` `{ destinationPath }` → `{ data: { success, moved/copies } }` (singular); bulk → `{ data: { success, moved, copies, errors: [] } }`.

- [ ] **Step 1: Write failing unit test**

Add `backend/tests/copyMove.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { createFileMetadata, listAllFiles, replaceFilesForAccount, getFolderByPath, getDescendants } = await import('../src/services/fileService.js');
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');

const USER = 'u-move';
const ACCOUNT = 'acc-move';
const acc = { id: ACCOUNT, provider: 's3', email: 'a@a', total_space: 1000, used_space: 10 };
const adapter = new BaseCloudAdapter(acc);

test('getFolderByPath resolves normalized folder paths', () => {
	createFileMetadata({ user_id: USER, virtual_path: '/', file_name: 'Docs', is_folder: 1, size: 0, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'docs-remote' });
	const folder = getFolderByPath(USER, '/Docs');
	assert.equal(folder.file_name, 'Docs');
	assert.equal(getFolderByPath(USER, '/'), null);
});

test('getDescendants collects subtree rows', () => {
	createFileMetadata({ user_id: USER, virtual_path: '/Docs/', file_name: 'a.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'a-remote' });
	createFileMetadata({ user_id: USER, virtual_path: '/Docs/Sub/', file_name: 'b.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'b-remote' });
	createFileMetadata({ user_id: USER, virtual_path: '/', file_name: 'top.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'top-remote' });
	const rows = listAllFiles(USER);
	const docs = getFolderByPath(USER, '/Docs');
	const descendants = getDescendants(rows, docs);
	assert.equal(descendants.length, 2);
	assert.ok(descendants.every((row) => row.file_name !== 'top.txt'));
});

test('BaseCloudAdapter copyFile streams through uploadStream', async () => {
	const out = await adapter.copyFile({ remote_file_id: 'r', file_name: 'x.txt', mime_type: 'text/plain', size: 3, virtual_path: '/' }, null);
	assert.ok(out.remoteFileId);
	assert.equal(out.fileName, 'x.txt');
});
```

- [ ] **Step 2: Run test to verify it fails**

From `backend/`:
```bash
node --test tests/copyMove.test.mjs
```
Expected: FAIL — `getFolderByPath is not a function`, `copyFile is not a function`.

- [ ] **Step 3: Add adapter methods (BaseCloudAdapter)**

Add to `backend/src/adapters/BaseCloudAdapter.js`, after `deleteFile`:

```js
	async copyFile(file, destinationParentId, destinationAccount) {
		const target = destinationAccount || this;
		const stream = await this.getDownloadStream(file);
		return target.uploadStream({
			stream,
			size: Number(file.size || 0),
			fileName: file.file_name,
			mimeType: file.mime_type || 'application/octet-stream',
			virtualPath: file.virtual_path,
			remoteParentId: destinationParentId || null,
		});
	}

	async moveFile(file, destinationParentId, destinationAccount) {
		const copied = await this.copyFile(file, destinationParentId, destinationAccount);
		await this.deleteFile(file);
		return copied;
	}
```

Also bump the capability map so the frontend can gate controls:

```js
	getCapabilities() {
		return {
			starred: false,
			rename: true,
			delete: true,
			move: true,
			copy: true,
		};
	}
```

- [ ] **Step 4: Add fileService helpers**

Add to `backend/src/services/fileService.js`:

```js
export function getFolderByPath(userId, virtualPath) {
	const target = normalizePath(virtualPath);
	if (target === '/') return null;
	const rows = listAllFiles(userId);
	return rows.find(
		(row) => row.is_folder === 1 && normalizePath(joinPath(row.virtual_path, row.file_name)) === target,
	) || null;
}

function joinPath(parentPath, name) {
	const base = parentPath === '/' || !parentPath ? '/' : parentPath;
	const clean = base.endsWith('/') ? base : `${base}/`;
	return `${clean}${String(name).replace(/^\/+/, '')}`;
}

export function getDescendants(rows, rootRow) {
	const folderPath = normalizePath(joinPath(rootRow.virtual_path, rootRow.file_name));
	return rows.filter((row) => row.virtual_path.startsWith(folderPath));
}
```

- [ ] **Step 5: Add move/copy routes**

In `backend/src/routes/fileRoutes.js` add:

```js
function resolveDestination(userId, destinationPath, sourceAccountId) {
	const folder = getFolderByPath(userId, destinationPath);
	if (!folder) {
		const { selected } = selectBestAccount(userId, 0);
		return { accountId: selected.id, parentId: null };
	}
	return { accountId: folder.cloud_account_id, parentId: folder.remote_file_id };
}

async function transferFile(req, { mode }) {
	const context = await getFileContext(req.user.id, req.params.id);
	if (!ensureFileContext(context, res)) return null;

	const { destinationPath } = req.body;
	if (!destinationPath?.trim()) {
		const err = new Error('destinationPath is required');
		err.status = 400;
		throw err;
	}

	const target = resolveDestination(req.user.id, destinationPath, context.file.cloud_account_id);
	const sameAccount = target.accountId === context.file.cloud_account_id;

	if (mode === 'move') {
		await context.adapter.moveFile(context.file, target.parentId, target.accountId === context.file.cloud_account_id ? null : null);
		if (!sameAccount) {
			const targetAccount = getAccountById(req.user.id, target.accountId);
			await context.adapter.deleteFile(context.file);
			await syncAccount(req.user.id, targetAccount);
		}
		await syncAccount(req.user.id, context.account);
		return { moved: 1 };
	}

	const targetAccount = getAccountById(req.user.id, target.accountId);
	if (sameAccount) {
		await context.adapter.copyFile(context.file, target.parentId, null);
	} else {
		const targetAdapter = createAdapter(targetAccount);
		const stream = await context.adapter.getDownloadStream(context.file);
		await targetAdapter.uploadStream({
			stream,
			size: Number(context.file.size || 0),
			fileName: context.file.file_name,
			mimeType: context.file.mime_type || 'application/octet-stream',
			virtualPath: context.file.virtual_path,
			remoteParentId: target.parentId,
		});
	}
	await syncAccount(req.user.id, targetAccount);
	if (!sameAccount) await syncAccount(req.user.id, context.account);
	return { copied: 1 };
}
```

The `moveFile` call above is muddled. Final signature decided here (update Task 4 Step 1's expectations accordingly): the **route** owns cross-account orchestration; the adapter `moveFile`/`copyFile` are always same-account operations. Clean route bodies:

```js
async function performTransfer(userId, context, destinationPath, mode) {
	const target = resolveDestination(userId, destinationPath, context.file.cloud_account_id);
	const sameAccount = target.accountId === context.file.cloud_account_id;
	const targetAccount = getAccountById(userId, target.accountId);
	if (!targetAccount) {
		const err = new Error('Destination account is unavailable');
		err.status = 400;
		throw err;
	}

	if (mode === 'move' && sameAccount) {
		await context.adapter.moveFile(context.file, target.parentId);
		await syncAccount(userId, context.account);
		return { moved: 1 };
	}

	const stream = await context.adapter.getDownloadStream(context.file);
	const targetAdapter = sameAccount
		? context.adapter
		: createAdapter(targetAccount);
	await targetAdapter.uploadStream({
		stream,
		size: Number(context.file.size || 0),
		fileName: context.file.file_name,
		mimeType: context.file.mime_type || 'application/octet-stream',
		virtualPath: context.file.virtual_path,
		remoteParentId: target.parentId,
	});

	if (mode === 'move') {
		await context.adapter.deleteFile(context.file);
		await syncAccount(userId, context.account);
	}
	await syncAccount(userId, targetAccount);
	return mode === 'move' ? { moved: 1 } : { copied: 1 };
}

router.post('/files/:id/move', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) return;
		const { destinationPath } = req.body;
		if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
		const result = await performTransfer(req.user.id, context, destinationPath, 'move');
		return res.json({ data: result });
	} catch (error) {
		next(error);
	}
});

router.post('/files/:id/copy', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) return;
		const { destinationPath } = req.body;
		if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
		const result = await performTransfer(req.user.id, context, destinationPath, 'copy');
		return res.json({ data: result });
	} catch (error) {
		next(error);
	}
});

router.post('/files/bulk/move', async (req, res, next) => {
	try {
		const { ids, destinationPath } = req.body;
		if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
		if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
		const errors = [];
		let moved = 0;
		for (const id of [...new Set(ids)]) {
			try {
				const context = await getFileContext(req.user.id, id);
				if (!context.file) { errors.push({ id, error: 'File not found' }); continue; }
				const result = await performTransfer(req.user.id, context, destinationPath, 'move');
				moved += result.moved;
			} catch (error) {
				errors.push({ id, error: error.message });
			}
		}
		return res.json({ data: { success: true, moved, errors } });
	} catch (error) {
		next(error);
	}
});

router.post('/files/bulk/copy', async (req, res, next) => {
	try {
		const { ids, destinationPath } = req.body;
		if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
		if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
		const errors = [];
		let copied = 0;
		for (const id of [...new Set(ids)]) {
			try {
				const context = await getFileContext(req.user.id, id);
				if (!context.file) { errors.push({ id, error: 'File not found' }); continue; }
				const result = await performTransfer(req.user.id, context, destinationPath, 'copy');
				copied += result.copied;
			} catch (error) {
				errors.push({ id, error: error.message });
			}
		}
		return res.json({ data: { success: true, copied, errors } });
	} catch (error) {
		next(error);
	}
});
```

Add imports: `import { getFolderByPath, getDescendants, listAllFiles } from '../services/fileService.js';` (extend existing import at line 2).

- [ ] **Step 6: Run tests + smoke**

```bash
node --test tests/copyMove.test.mjs
node --check src/routes/fileRoutes.js
node --check src/adapters/BaseCloudAdapter.js
```
Expected: PASS. Manual smoke (documented): create folders `/A` and `/B`; `POST /files/:id/move` with `{ destinationPath: '/B' }` moves a file from `/A` to `/B`; `POST /files/:id/copy` duplicates it; bulk variants with one bogus id still return `{ success: true, moved: N, errors: [...] }`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/adapters/BaseCloudAdapter.js backend/src/services/fileService.js backend/src/routes/fileRoutes.js backend/tests/copyMove.test.mjs
git commit -m "feat: cross-provider move and copy with bulk variants"
```

---

## Task 5: Batch ZIP download

**Files:**
- Modify: `backend/package.json` (add `archiver`)
- Modify: `backend/src/routes/fileRoutes.js` (add `POST /files/bulk/download`)
- Modify: `frontend/src/services/api.js` (add `bulkDownload`)
- Modify: `frontend/src/composables/useFileActions.js` (add `downloadSelectionAsZip`)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json` (add `download.*` keys)
- Modify: `frontend/src/components/FileListSelectionBar.vue` (add download-zip button via `canDownloadZip` + slot; alternatively handle in views)

**Interfaces:**
- Consumes: `listAllFiles`, `getDescendants`, `getFileContext`-style account lookup via `getAccountById`/`createAdapter`; `env` not needed here.
- Produces: `POST /files/bulk/download` streaming `application/zip`; `api.bulkDownload(ids)` returning the raw `Response` (blob); `useFileActions.downloadSelectionAsZip()`.

- [ ] **Step 1: Add dependency**

From `backend/`:
```bash
npm install archiver
```
Confirm it appears in `backend/package.json` dependencies.

- [ ] **Step 2: Add ZIP route**

In `backend/src/routes/fileRoutes.js`, import at top:
```js
import archiver from 'archiver';
import { Readable } from 'stream';
```

Add before `router.delete('/files/:id')`:

```js
function collectZipEntries(userId, rootIds) {
	const all = listAllFiles(userId);
	const byId = new Map(all.map((row) => [row.id, row]));
	const resolved = [...new Set(rootIds || [])].map((id) => byId.get(id));
	if (resolved.some((row) => !row)) {
		const err = new Error('One or more requested files were not found');
		err.status = 400;
		throw err;
	}
	const entries = [];
	const seen = new Set();
	for (const root of resolved) {
		const leaves = root.is_folder ? [root, ...getDescendants(all, root)] : [root];
		for (const leaf of leaves) {
			const key = `${leaf.cloud_account_id}:${leaf.remote_file_id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const rel = leaf.virtual_path === '/'
				? leaf.file_name
				: `${leaf.virtual_path.replace(/^\//, '')}${leaf.file_name}`;
			entries.push({ ...leaf, relPath: rel.replace(/^\/+/, '') });
		}
	}
	return entries;
}

function sanitizeZipName(raw, usedNames) {
	const cleaned = String(raw || 'file')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.split('/')
		.map((part) => part.replace(/^\.+$/, '_').replace(/[<>:"|?*]/g, '_'))
		.join('/');
	const unique = usedNames.has(cleaned)
		? `${cleaned} (${usedNames.size}).zip-suffix`
		: cleaned;
	usedNames.add(unique);
	return unique.endsWith('.zip-suffix') && false ? cleaned : unique;
}

router.post('/files/bulk/download', async (req, res, next) => {
	try {
		const { ids } = req.body;
		if (!Array.isArray(ids) || !ids.length) {
			return res.status(400).json({ error: 'ids are required' });
		}
		const entries = collectZipEntries(req.user.id, ids);

		res.setHeader('Content-Type', 'application/zip');
		res.setHeader('Content-Disposition', 'attachment; filename="omnicloud-download.zip"');

		const archive = archiver('zip', { zlib: { level: 9 } });
		archive.on('error', () => res.end());
		archive.pipe(res);

		const errors = [];
		const usedNames = new Set();
		for (const entry of entries) {
			if (entry.is_folder) continue;
			const name = sanitizeZipName(entry.relPath, usedNames);
			try {
				const account = getAccountById(req.user.id, entry.cloud_account_id);
				if (!account) {
					errors.push(entry.file_name);
					continue;
				}
				const adapter = createAdapter(account);
				const stream = await adapter.getDownloadStream(entry);
				archive.append(stream, { name });
			} catch {
				errors.push(entry.file_name);
			}
		}
		if (errors.length) {
			archive.append(Readable.from([`The following files could not be downloaded:\n${errors.join('\n')}\n`]), { name: 'errors.txt' });
		}
		archive.finalize();
	} catch (error) {
		next(error);
	}
});
```

Note the `sanitizeZipName` collision logic above is convoluted; replace with the clear canonical version:

```js
function sanitizeZipName(raw, usedNames) {
	let cleaned = String(raw || 'untitled')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.split('/')
		.map((part) => part.replace(/\.\./g, '_').replace(/[<>:"|?*]/g, '_').trim() || '_')
		.filter(Boolean)
		.join('/');
	if (!cleaned) cleaned = 'untitled';
	const base = cleaned.replace(/(\.\w+)?$/, '');
	const ext = cleaned.match(/\.\w+$/) ? cleaned.match(/\.\w+$/)[0] : '';
	let candidate = cleaned;
	let i = 2;
	while (usedNames.has(candidate)) {
		candidate = `${base} (${i})${ext}`;
		i += 1;
	}
	usedNames.add(candidate);
	return candidate;
}
```

Use this final version in the route.

- [ ] **Step 3: Add frontend API method**

In `frontend/src/services/api.js`:

```js
	bulkDownloadUrl() {
		return `${API_BASE_URL}/files/bulk/download`;
	},
	async bulkDownload(ids) {
		return fetch(this.bulkDownloadUrl(), {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids }),
		});
	},
```

- [ ] **Step 4: Add useFileActions helper**

In `frontend/src/composables/useFileActions.js`, add and export:

```js
	const canZipDownloadSelection = computed(
		() => selectedFiles.value.length > 0
			|| (contextMenu.value.file && contextMenu.value.file.is_folder),
	);

	async function downloadSelectionAsZip() {
		const targets = getActionFiles();
		if (!targets.length) return;
		closeContextMenu();
		errorRef.value = '';
		try {
			const response = await api.bulkDownload(targets.map((file) => file.id));
			if (!response.ok) {
				const payload = await response.json().catch(() => ({ error: 'ZIP download failed' }));
				throw new Error(payload.error || 'ZIP download failed');
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = 'omnicloud-download.zip';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			const noErrors = true;
			void noErrors;
		} catch (error) {
			errorRef.value = error.message;
		}
	}
```

Add `downloadSelectionAsZip` and `canZipDownloadSelection` to the returned object.

- [ ] **Step 5: Locale keys + selection bar entry**

`en.json`:
```json
	"download": {
		"zipLabel": "Download (.zip)",
		"preparingZip": "Preparing ZIP archive…",
		"zipReady": "Archive ready",
		"zipFailed": "Could not create the ZIP archive.",
		"zipNote": "Large selections may take a moment."
	},
```
`id.json`:
```json
	"download": {
		"zipLabel": "Unduh (.zip)",
		"preparingZip": "Menyiapkan arsip ZIP…",
		"zipReady": "Arsip siap",
		"zipFailed": "Gagal membuat arsip ZIP.",
		"zipNote": "Pilihan dalam jumlah besar mungkin memerlukan waktu."
	},
```
Verify with `JSON.parse` both files.

Wire the button: in `FileListSelectionBar.vue` add a `canZipDownload` prop (default `false`) and emit `download-zip`; in views that mount the selection bar (`MyDriveView.vue` etc.) pass `:can-zip-download="actions.canZipDownloadSelection || actions.contextMenu.file?.is_folder"` and handle `@download-zip="actions.downloadSelectionAsZip"`. Add the button (icon `IconZip` from `@tabler/icons-vue` — if the icon is missing, use `IconDownload`).

- [ ] **Step 6: Verify + commit**

```bash
cd backend && node --check src/routes/fileRoutes.js && cd ../frontend && npm run build
```
Expected: PASS. Manual smoke: select 2 files + 1 folder with subfiles → ZIP downloads; unzip contains nested paths; confirm an unresolvable file yields `errors.txt` inside the archive.

Commit:
```bash
git add backend/package.json backend/package-lock.json backend/src/routes/fileRoutes.js frontend/src/services/api.js frontend/src/composables/useFileActions.js frontend/src/locales/en.json frontend/src/locales/id.json frontend/src/components/FileListSelectionBar.vue
git commit -m "feat: batch download selection as ZIP archive"
```

---

## Task 6: Wave 1 end-to-end verification

- [ ] **Step 1: Full checks**

From repo root:
```bash
cd backend && node --check src/services/trashService.js && node --check src/services/fileService.js && node --check src/services/syncService.js && node --check src/routes/fileRoutes.js && node --test tests/ && cd ..
cd frontend && npm run build
cd ../backend && node -e "JSON.parse(require('fs').readFileSync('../frontend/src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('../frontend/src/locales/id.json','utf8'));console.log('ok')"
```
Expected: all pass.

- [ ] **Step 2: Manual smoke**

Run backend `npm run dev` in `backend/`, frontend `npm run dev` in `frontend/`. In the UI: soft delete a folder with children → appears in Trash → restore → verify files return; move a file between two folders via context menu; copy a file; bulk-select → "Download (.zip)".

- [ ] **Step 3: Commit + push Wave 1**

```bash
git add -A
git commit -m "feat: trash, move/copy, and batch zip download"
git push origin main
```
Expected: pushed; remote `main` advanced.

---
---

# Wave 2 — Quota & Duplicates

## Task 7: Quota hard limit (507) + soft threshold

**Files:**
- Modify: `backend/src/services/spaceAllocator.js` (export `toFreeSpaceView`, `isAlmostFull`, `isFull`)
- Modify: `backend/src/routes/uploadRoutes.js` (507 + breakdown)
- Modify: `frontend/src/services/api.js` (request helper preserves `error.data`)
- Modify: `frontend/src/stores/uploadQueue.js` (surface 507 breakdown)
- Modify: `frontend/src/views/QuotaView.vue` (Almost full / Full states)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`

**Interfaces:**
- Consumes: `env.quotaHardLimitEnabled` (Task 1).
- Produces: `toFreeSpaceView(account)` → `{ ...account, freeSpace, usedRatio }` (rename/export of existing `withFreeSpace`); `isAlmostFull(account)` → boolean (usedRatio ≥ 0.85 && freeSpace > 0); `isFull(account)` → boolean (freeSpace ≤ 0); `POST /uploads/initiate` may return 507.

- [ ] **Step 1: Export helpers from spaceAllocator**

In `backend/src/services/spaceAllocator.js`, rename `withFreeSpace` → `toFreeSpaceView` (keep the internal `withFreeSpace` name by exporting an alias):

```js
export function toFreeSpaceView(account) {
	const total = Number(account.total_space) || 0;
	const used = Number(account.used_space) || 0;
	return {
		...account,
		freeSpace: Math.max(0, total - used),
		usedRatio: total > 0 ? used / total : 1,
	};
}

export function isAlmostFull(account) {
	const view = toFreeSpaceView(account);
	return view.freeSpace > 0 && view.usedRatio >= 0.85;
}

export function isFull(account) {
	return toFreeSpaceView(account).freeSpace <= 0;
}
```

Replace all internal `withFreeSpace(` call sites with `toFreeSpaceView(`.

- [ ] **Step 2: Write failing route-level test**

`backend/tests/uploadQuota.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.QUOTA_HARD_LIMIT_ENABLED = 'true';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata } = await import('../src/services/fileService.js');
// Seed a full account row directly:
db.prepare(`INSERT OR REPLACE INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,?,?,?,?, 'active')`)
	.run('acc-full', LOCAL_USER_ID, 'full@x', 's3', '', 100, 100);

const { selectBestAccount } = await import('../src/services/spaceAllocator.js');

test('selectBestAccount with requiredBytes returns a view with freeSpace', () => {
	const { selected } = selectBestAccount(LOCAL_USER_ID, 1);
	assert.equal(selected.freeSpace, 0);
	assert.equal(isFull(selected), true);
	assert.equal(isAlmostFull(selected), false);
});
```

`isFull`/`isAlmostFull` imported from spaceAllocator. The seed row needs a provider adapter — `s3` may not map; use `google_drive` if `adapterRegistry` rejects unknown providers during `selectBestAccount` (it does not; selectBestAccount only reads account rows). Keep `s3`.

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test tests/uploadQuota.test.mjs
```
Expected: FAIL — `isFull is not a function`.

- [ ] **Step 4: Implement 507 in uploadRoutes**

`backend/src/routes/uploadRoutes.js`:

```js
import { selectBestAccount, toFreeSpaceView } from '../services/spaceAllocator.js';
import { env } from '../config/env.js';
```

Replace the initiate handler body (lines 11-41) allocation section with:

```js
	const allocation = selectBestAccount(req.user.id, Number(size));
	const requiredBytes = Number(size) || 0;
	const selectedView = toFreeSpaceView(allocation.selected);

	if (requiredBytes > selectedView.freeSpace && env.quotaHardLimitEnabled) {
		const perAccount = [allocation.selected, ...allocation.fallbackChain].map((account) => {
			const view = toFreeSpaceView(account);
			return {
				id: view.id,
				provider: view.provider,
				email: view.email,
				totalBytes: Number(view.total_space || 0),
				usedBytes: Number(view.used_space || 0),
				freeBytes: view.freeSpace,
				soft: view.usedRatio >= 0.85,
			};
		});
		return res.status(507).json({
			error: 'Insufficient storage available — free some space or connect another account',
			data: { perAccount },
		});
	}
```

Keep the rest of the original handler (session creation) unchanged.

- [ ] **Step 5: Frontend — preserve 507 payload + surface breakdown**

`frontend/src/services/api.js` `request()`:
```js
	if (!response.ok) {
		const payload = await response.json().catch(() => ({ error: 'Unknown API error' }));
		const error = new Error(payload.error || 'API request failed');
		error.status = response.status;
		error.data = payload.data;
		throw error;
	}
```

`frontend/src/stores/uploadQueue.js` — in the `initiateUpload` catch (line ~260), after computing `error.message`, if `error.status === 507` and `error.data?.perAccount`, enrich:

```js
				} catch (error) {
					if (error.status === 507 && Array.isArray(error.data?.perAccount)) {
						error.message = `${error.message}\n${error.data.perAccount
							.map((a) => `${a.provider} (${a.email}): ${a.freeBytes} bytes free`)
							.join('\n')}`;
					}
					queueItem.abortController?.abort?.();
					this.updateUpload(queueItem.id, { status: 'failed', error: error.message });
					if (batchTotal === 1) throw error;
				}
```

Locate the actual catch block in `uploadQueue.js` and merge accordingly (the file's catches set status per queue item).

- [ ] **Step 6: Quota UI states**

Modify the per-account card in `frontend/src/views/QuotaView.vue` (grep `usedSpace`/`used_`). Where each account ratio is rendered toggle class + label:

```js
const usedRatioPercent = account.used_space / account.total_space; // existing
const state = usedRatioPercent >= 1
	? 'full'
	: usedRatioPercent >= 0.85
		? 'almost-full'
		: 'ok';
```
Template: when `state === 'full'` show a red bar + `t('quota.full')`; when `'almost-full'` show an amber bar + `t('quota.almostFull')`.

Locale keys:
```json
	"quota": {
		"full": "Full",
		"almostFull": "Almost full",
		"freeSpace": "of {total} used",
		"blocked": "Storage limit reached",
		"blockedBody": "The selected account does not have enough free space."
	},
```
`id.json`:
```json
	"quota": {
		"full": "Penuh",
		"almostFull": "Hampir penuh",
		"freeSpace": "dari {total} terpakai",
		"blocked": "Batas penyimpanan tercapai",
		"blockedBody": "Akun yang dipilih tidak memiliki ruang kosong yang cukup."
	},
```
Merge into the existing `"quota"` section if one exists (grep `"quota":`); otherwise add it.

- [ ] **Step 7: Verify + commit**

```bash
cd backend && node --test tests/uploadQuota.test.mjs && node --check src/routes/uploadRoutes.js && cd ../frontend && npm run build
```
Expected: PASS. Commit:
```bash
git add backend/src/services/spaceAllocator.js backend/src/routes/uploadRoutes.js frontend/src/services/api.js frontend/src/stores/uploadQueue.js frontend/src/views/QuotaView.vue frontend/src/locales/en.json frontend/src/locales/id.json backend/tests/uploadQuota.test.mjs
git commit -m "feat: quota hard limit with 507 and almost-full UI states"
```

---

## Task 8: Duplicate detection

**Files:**
- Modify: `backend/src/services/fileService.js` (add `findDuplicateGroups`)
- Modify: `backend/src/routes/fileRoutes.js` (add `GET /files/duplicates`)
- Modify: `frontend/src/services/api.js` (add `duplicates`)
- Modify: `frontend/src/router/index.js` (+ `/duplicates`)
- Modify: `frontend/src/components/DriveShell.vue` (nav item)
- Create: `frontend/src/views/DuplicatesView.vue`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`

**Interfaces:**
- Consumes: `db` in fileService.
- Produces: `fileService.findDuplicateGroups(userId)` → `[{ key, file_name, size, count, totalBytes, items: [mirror rows w/ provider] }]` sorted by `totalBytes` DESC; `GET /files/duplicates` → `{ data: [...] }`.

- [ ] **Step 1: Write failing test**

`backend/tests/duplicates.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata, findDuplicateGroups } = await import('../src/services/fileService.js');
const { replaceFilesForAccount } = await import('../src/services/fileService.js');

const ACCOUNT = 'acc-dup';
db.prepare(`INSERT OR REPLACE INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,?,?,?,?, 'active')`)
	.run(ACCOUNT, LOCAL_USER_ID, 'dup@x', 'google_drive', '', 1000, 10);

test('findDuplicateGroups groups by (file_name,size)', () => {
	replaceFilesForAccount(LOCAL_USER_ID, ACCOUNT, [
		{ file_name: 'report.pdf', size: 500, is_folder: 0, remote_file_id: 'r1', virtual_path: '/' },
		{ file_name: 'report.pdf', size: 500, is_folder: 0, remote_file_id: 'r2', virtual_path: '/Sub/' },
		{ file_name: 'report.pdf', size: 300, is_folder: 0, remote_file_id: 'r3', virtual_path: '/' },
		{ file_name: 'unique.txt', size: 700, is_folder: 0, remote_file_id: 'u1', virtual_path: '/' },
		{ file_name: 'folder', size: 0, is_folder: 1, remote_file_id: 'f1', virtual_path: '/' },
	]);

	const groups = findDuplicateGroups(LOCAL_USER_ID);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].file_name, 'report.pdf');
	assert.equal(groups[0].count, 2);
	assert.equal(groups[0].size, 500);
	assert.equal(groups[0].totalBytes, 1000);
	assert.equal(groups[0].items.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/duplicates.test.mjs
```
Expected: FAIL — `findDuplicateGroups is not a function`.

- [ ] **Step 3: Implement `findDuplicateGroups`**

In `backend/src/services/fileService.js`:

```js
export function findDuplicateGroups(userId) {
	const groups = db
		.prepare(`
			SELECT fm.file_name, fm.size, COUNT(*) AS count, SUM(fm.size) AS totalBytes
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND fm.is_folder = 0 AND fm.size > 0 AND ca.status = 'active'
			GROUP BY fm.file_name, fm.size
			HAVING COUNT(*) >= 2
			ORDER BY totalBytes DESC, fm.file_name COLLATE NOCASE
		`)
		.all(userId);

	const items = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND fm.is_folder = 0 AND fm.size > 0
				AND ca.status = 'active'
			ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time, fm.updated_at) DESC, fm.file_name COLLATE NOCASE
		`)
		.all(userId);

	const byKey = (name, size) => `${name}|${size}`;
	const itemGroups = new Map();
	for (const item of items) {
		const key = byKey(item.file_name, item.size);
		if (!itemGroups.has(key)) itemGroups.set(key, []);
		itemGroups.get(key).push(buildDisplayNames([item])[0]);
	}

	return groups
		.map((group) => ({
			key: byKey(group.file_name, group.size),
			file_name: group.file_name,
			size: Number(group.size),
			count: Number(group.count),
			totalBytes: Number(group.totalBytes),
			items: itemGroups.get(byKey(group.file_name, group.size)) || [],
		}))
		.filter((group) => group.items.length >= 2);
}
```

- [ ] **Step 4: Add route**

In `backend/src/routes/fileRoutes.js` — update the import at line 2 to include `findDuplicateGroups`, then add:

```js
router.get('/files/duplicates', (req, res) => {
	return res.json({ data: findDuplicateGroups(req.user.id) });
});
```

(Place after `GET /files/trash`.)

- [ ] **Step 5: Run test + verify route**

```bash
node --test tests/duplicates.test.mjs
node --check src/routes/fileRoutes.js
```
Expected: PASS.

- [ ] **Step 6: Frontend — api, router, nav**

`frontend/src/services/api.js`:
```js
	duplicates() {
		return request('/files/duplicates');
	},
```

`frontend/src/router/index.js`:
```js
import DuplicatesView from '../views/DuplicatesView.vue';
		{
			path: '/duplicates',
			name: 'duplicates',
			component: DuplicatesView,
		},
```

`DriveShell.vue` navItems: after `storage` add
```js
	{ id: 'duplicates', label: t('nav.duplicates'), icon: IconFiles, activeIcon: IconFiles, to: '/duplicates' },
```
Import `IconFiles` (exists in `@tabler/icons-vue`).

Nav locale keys: `"nav": { ..., "duplicates": "Duplicates" }` (en) / `"duplicates": "Duplikat"` (id).

- [ ] **Step 7: Create `DuplicatesView.vue`**

```vue
<script setup>
import { ref, computed, h } from 'vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { useFileSelection } from '../composables/useFileSelection';
import DriveShell from '../components/DriveShell.vue';

const { t } = useI18n();
const groups = ref([]);
const loading = ref(true);
const errorRef = ref('');
const flatItems = computed(() => groups.value.flatMap((g) => g.items));
const { selectedFileIds, toggleSelection, clearSelection, selectedFiles } = useFileSelection({ sourceList: flatItems });
const isBusy = ref(false);

async function refresh() {
	loading.value = true;
	errorRef.value = '';
	try {
		const res = await api.duplicates();
		groups.value = res.data || [];
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		loading.value = false;
	}
}

function keepOne(group) {
	clearSelection();
	const newest = group.items[0];
	group.items.forEach((item) => {
		if (item.id !== newest.id) toggleSelection(item);
	});
}

async function deleteSelected() {
	if (!selectedFiles.value.length) return;
	if (!window.confirm(t('duplicates.confirmDelete', { name: t('common.items') }))) return;
	isBusy.value = true;
	try {
		await api.deleteFiles(selectedFiles.value.map((f) => f.id));
		clearSelection();
		await refresh();
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		isBusy.value = false;
	}
}

function formatSize(size) {
	if (!size) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
	return `${(size / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

onMounted(refresh);
</script>

<template>
	<DriveShell current-section="duplicates">
		<div class="mx-auto max-w-5xl px-4 py-6">
			<h1 class="text-2xl font-semibold">{{ t('duplicates.title') }}</h1>
			<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('duplicates.description') }}</p>

			<div v-if="selectedFiles.length" class="sticky top-20 z-30 mt-4 flex items-center gap-3 rounded-full bg-[#e8f0fe] px-4 py-2 dark:bg-sky-500/15">
				<span class="text-sm font-semibold">{{ selectedFiles.length }} {{ t('common.items') }}</span>
				<button type="button" class="ml-auto rounded-full bg-[#c5221f] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="isBusy" @click="deleteSelected">Delete</button>
			</div>

			<div v-if="errorRef" class="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

			<div v-if="loading" class="mt-8 text-center text-sm text-[#5f6368] dark:text-slate-400">{{ t('common.loading') }}</div>
			<div v-else-if="!groups.length" class="mt-16 text-center">
				<p class="text-sm font-medium">{{ t('duplicates.empty') }}</p>
				<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('duplicates.emptyState') }}</p>
			</div>
			<div v-else class="mt-6 space-y-4">
				<div v-for="group in groups" :key="group.key" class="rounded-2xl border border-[#e8f0fe] bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<div class="truncate text-sm font-semibold">{{ group.file_name }}</div>
							<div class="mt-0.5 text-xs text-[#5f6368] dark:text-slate-400">{{ group.count }} {{ t('duplicates.files') }} · {{ formatSize(group.size) }} × {{ group.count }} · {{ t('duplicates.wasted') }} {{ formatSize(group.totalBytes - group.size) }}</div>
						</div>
						<button type="button" class="shrink-0 rounded-full border border-[#1a73e8] px-3 py-1.5 text-xs font-semibold text-[#1a73e8] hover:bg-[#e8f0fe] dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-500/15" @click="keepOne(group)">{{ t('duplicates.keepOne') }}</button>
					</div>
					<ul class="mt-3 space-y-1">
						<li v-for="item in group.items" :key="item.id" class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f8fafd] dark:hover:bg-slate-700/40" @click="toggleSelection(item)">
							<input type="checkbox" :checked="selectedFileIds.has(item.id)" class="size-4 accent-[#1a73e8]" @click.prevent="toggleSelection(item)" />
							<span class="truncate text-sm">{{ item.file_name }}</span>
							<span class="ml-auto shrink-0 text-xs text-[#5f6368] dark:text-slate-400">{{ item.provider }} · {{ item.virtual_path }}</span>
						</li>
					</ul>
				</div>
			</div>
		</div>
	</DriveShell>
</template>
```

The checkbox `@click.prevent` overlaps with the row `@click` — simpler: drop the separate checkbox input and make the row itself the toggle (checkbox row click already calls `toggleSelection(item)`; keep a plain `<input type="checkbox" ...>` without `@click.prevent`). Use the simpler version.

- [ ] **Step 8: Locale keys**

`en.json`:
```json
	"duplicates": {
		"title": "Duplicate files",
		"description": "Files with the same name and size, grouped across all providers.",
		"empty": "No duplicates found",
		"emptyState": "We couldn't find any files with identical name and size.",
		"keepOne": "Keep one",
		"files": "files",
		"wasted": "potential waste",
		"confirmDelete": "Move {name} to trash?"
	},
```
`id.json`:
```json
	"duplicates": {
		"title": "File duplikat",
		"description": "File dengan nama dan ukuran sama, dikelompokkan di semua penyedia.",
		"empty": "Tidak ada duplikat",
		"emptyState": "Tidak ditemukan file dengan nama dan ukuran yang identik.",
		"keepOne": "Simpan satu",
		"files": "file",
		"wasted": "potensi terbuang",
		"confirmDelete": "Pindahkan {name} ke sampah?"
	},
```

- [ ] **Step 9: Verify + commit**

```bash
cd backend && node --test tests/duplicates.test.mjs && cd ../frontend && npm run build
```
```bash
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('src/locales/id.json','utf8'))"
```
Expected: PASS. Commit:
```bash
git add backend/src/services/fileService.js backend/src/routes/fileRoutes.js backend/tests/duplicates.test.mjs frontend/src/services/api.js frontend/src/router/index.js frontend/src/components/DriveShell.vue frontend/src/views/DuplicatesView.vue frontend/src/locales/en.json frontend/src/locales/id.json
git commit -m "feat: duplicate detection view and group selection"
```

---

## Task 9: Wave 2 end-to-end verification

- [ ] **Step 1: Full checks**

```bash
cd backend && node --test tests/ && node --check src/routes/uploadRoutes.js && node --check src/services/spaceAllocator.js && cd ../frontend && npm run build
```

- [ ] **Step 2: Manual smoke**

Set `QUOTA_HARD_LIMIT_ENABLED=true` and connect a near-full account; attempt an upload over the free space → expect 507 with per-account breakdown in the UI upload error. In the Duplicates view confirm grouping, "Keep one" preselects all but newest, delete 💯 moves to trash (check Trash lists them).

- [ ] **Step 3: Commit + push Wave 2**

```bash
git add -A
git commit -m "feat: quota limits and duplicate detection"
git push origin main
```

---
---

# Wave 3 — Share Links

## Task 10: share_links table + shareService

**Files:**
- Modify: `backend/src/config/database.js` (add `share_links` table + index)
- Create: `backend/src/services/shareService.js`
- Test: `backend/tests/share.test.mjs`

**Interfaces:**
- Consumes: `db`, `getFileById`, `hashPassword`/`verifyPassword` from `authService.js`, `randomBytes` from `crypto`.
- Produces:
  - `shareService.createShareLink({ userId, fileId, expiresInDays?, password? })` → `{ id, token, url, expiresAt }` (throws 400-style Error `'Folders are not shareable'` for folders)
  - `shareService.listShareLinks(userId)` → rows + `url` + `expired`
  - `shareService.revokeShareLink(userId, token)` → `{ revoked: 0|1 }`
  - `shareService.getShareLinkByToken(token)` → row with `expired` flag or `null`
  - `shareService.touchShareLink(token)` → increments `download_count`, sets `last_used_at`
  - `env.frontendUrl` already exists.

- [ ] **Step 1: Add table**

In `backend/src/config/database.js` schema block, after `trash`:

```sql
  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    cloud_account_id TEXT NOT NULL,
    remote_file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    is_folder INTEGER NOT NULL DEFAULT 0,
    token TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    download_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
```

Index block:
```sql
  CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);
  CREATE INDEX IF NOT EXISTS idx_share_links_file ON share_links(file_id);
```

- [ ] **Step 2: Write failing test**

`backend/tests/share.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata } = await import('../src/services/fileService.js');
const share = await import('../src/services/shareService.js');

test('createShareLink requires a non-folder file', () => {
	createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 'f.txt', is_folder: 0, size: 10, mime_type: 'text/plain', cloud_account_id: 'acc', remote_file_id: 'f1' });
	createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 'Folder', is_folder: 1, size: 0, mime_type: null, cloud_account_id: 'acc', remote_file_id: 'f2' });

	const link = share.createShareLink({ userId: LOCAL_USER_ID, fileId: 'f.txt-lookup' }); // must fail before use; see below
	assert.throws(() => share.createShareLink({ userId: LOCAL_USER_ID, fileId: share.getShareLinkByToken('nope') && '' }), /not found/);
});

test('create, list, touch, revoke round-trip', () => {
	const fileId = requireFileId();
	const link = share.createShareLink({ userId: LOCAL_USER_ID, fileId, expiresInDays: 7 });
	assert.ok(link.token.length >= 32);
	assert.equal(share.listShareLinks(LOCAL_USER_ID).length, 1);

	share.touchShareLink(link.token);
	const again = share.getShareLinkByToken(link.token);
	assert.equal(again.download_count, 1);
	assert.ok(!again.expired);

	const revoke = share.revokeShareLink(LOCAL_USER_ID, link.token);
	assert.equal(revoke.revoked, 1);
	assert.equal(share.getShareLinkByToken(link.token), null);
});
```

The first test needs a real file id. Because ids are random UUIDs, structure the tests to query via `listAllFiles`: add a helper at top:
```js
const { listAllFiles } = await import('../src/services/fileService.js');
function requireFileId(fileName = 'f.txt') {
	return listAllFiles(LOCAL_USER_ID).find((row) => row.file_name === fileName).id;
}
```
Replace `createShareLink({ userId, fileId: 'f.txt-lookup' })` nonsense with the empty-state check:
```js
test('createShareLink throws for folders and missing files', () => {
	const folder = requireFileId('Folder');
	assert.throws(() => share.createShareLink({ userId: LOCAL_USER_ID, fileId: folder }), /not shareable/);
	assert.throws(() => share.createShareLink({ userId: LOCAL_USER_ID, fileId: 'nope' }), /not found/);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test tests/share.test.mjs
```
Expected: FAIL — `Cannot find module '../src/services/shareService.js'`.

- [ ] **Step 4: Implement `shareService.js`**

```js
import { randomBytes, randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { getFileById } from './fileService.js';
import { hashPassword, verifyPassword } from './authService.js';

function linkUrl(token) {
	return `${env.frontendUrl}/s/${token}`;
}

function toPublic(row) {
	return {
		...row,
		url: linkUrl(row.token),
		expired: Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now()),
	};
}

export function createShareLink({ userId, fileId, expiresInDays = 7, password }) {
	const file = getFileById(userId, fileId);
	if (!file) {
		const err = new Error('File not found');
		err.status = 400;
		throw err;
	}
	if (file.is_folder) {
		const err = new Error('Folders are not shareable');
		err.status = 400;
		throw err;
	}

	const token = randomBytes(16).toString('hex');
	const expiresAt = Number(expiresInDays) > 0
		? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000).toISOString()
		: null;

	db.prepare(`
		INSERT INTO share_links (
			id, user_id, file_id, cloud_account_id, remote_file_id,
			file_name, size, mime_type, is_folder,
			token, password_hash, expires_at
		) VALUES (
			@id, @user_id, @file_id, @cloud_account_id, @remote_file_id,
			@file_name, @size, @mime_type, @is_folder,
			@token, @password_hash, @expires_at
		)
	`).run({
		id: randomUUID(),
		user_id: userId,
		file_id: file.id,
		cloud_account_id: file.cloud_account_id,
		remote_file_id: file.remote_file_id,
		file_name: file.file_name,
		size: Number(file.size || 0),
		mime_type: file.mime_type || null,
		is_folder: file.is_folder ? 1 : 0,
		token,
		password_hash: password ? hashPassword(password) : null,
		expires_at: expiresAt,
	});

	return { token, url: linkUrl(token), expiresAt };
}

export function listShareLinks(userId) {
	return db
		.prepare('SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC')
		.all(userId)
		.map(toPublic);
}

export function revokeShareLink(userId, token) {
	const result = db
		.prepare('DELETE FROM share_links WHERE user_id = ? AND token = ?')
		.run(userId, token);
	return { revoked: result.changes };
}

export function getShareLinkByToken(token) {
	const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
	return row ? toPublic(row) : null;
}

export function touchShareLink(token) {
	db.prepare(`
		UPDATE share_links
		SET download_count = download_count + 1, last_used_at = CURRENT_TIMESTAMP
		WHERE token = ?
	`).run(token);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test tests/share.test.mjs
```
Expected: PASS. Also `node --check src/services/shareService.js`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/database.js backend/src/services/shareService.js backend/tests/share.test.mjs
git commit -m "feat: share link service with expiry and password hashing"
```

---

## Task 11: shareRoutes (auth + public)

**Files:**
- Create: `backend/src/routes/shareRoutes.js`
- Modify: `backend/src/app.js` (mount at `/api/share`)

**Interfaces:**
- Consumes: `shareService`, `requireAppUser` from `../middleware/authMiddleware.js`, `getAccountById`, `createAdapter`, `verifyPassword` from authService.
- Produces: routes — auth `POST /share`, `GET /share`, `DELETE /share/:token`; public `GET /share/:token/info`, `GET /share/:token/download`.

- [ ] **Step 1: Write failing service-level test for expiry gate**

`backend/tests/shareRoutes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata } = await import('../src/services/fileService.js');
const share = await import('../src/services/shareService.js');

const { listAllFiles } = await import('../src/services/fileService.js');
const fileId = () => listAllFiles(LOCAL_USER_ID).find((row) => row.file_name === 's.txt').id;

test('getShareLinkByToken flags expiry', () => {
	createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 's.txt', is_folder: 0, size: 1, mime_type: 'text/plain', cloud_account_id: 'acc', remote_file_id: 's1' });
	const link = share.createShareLink({ userId: LOCAL_USER_ID, fileId: fileId(), expiresInDays: -1 });
	assert.equal(share.getShareLinkByToken(link.token).expired, true);
});
```

- [ ] **Step 2: Implement `shareRoutes.js`**

```js
import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import {
	createShareLink,
	listShareLinks,
	revokeShareLink,
	getShareLinkByToken,
	touchShareLink,
} from '../services/shareService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { verifyPassword } from '../services/authService.js';

const router = Router();

router.post('/share', requireAppUser, (req, res) => {
	const { fileId, expiresInDays = 7, password } = req.body;
	if (!fileId) {
		return res.status(400).json({ error: 'fileId is required' });
	}
	const link = createShareLink({
		userId: req.user.id,
		fileId,
		expiresInDays: Number(expiresInDays),
		password: password || undefined,
	});
	return res.status(201).json({ data: link });
});

router.get('/share', requireAppUser, (_req, res) => {
	return res.json({ data: listShareLinks(_req.user.id) });
});

router.delete('/share/:token', requireAppUser, (req, res) => {
	return res.json({ data: revokeShareLink(req.user.id, req.params.token) });
});

function resolvePublicLink(req, res) {
	const link = getShareLinkByToken(req.params.token);
	if (!link || link.expired || link.is_folder) {
		res.status(404).json({ error: 'Link not found' });
		return null;
	}
	return link;
}

router.get('/share/:token/info', (req, res) => {
	const link = resolvePublicLink(req, res);
	if (!link) return;
	return res.json({
		data: {
			file_name: link.file_name,
			size: link.size,
			mime_type: link.mime_type,
			expires_at: link.expires_at,
			created_at: link.created_at,
			download_count: link.download_count,
			has_password: Boolean(link.password_hash),
		},
	});
});

router.get('/share/:token/download', async (req, res, next) => {
	try {
		const link = resolvePublicLink(req, res);
		if (!link) return;

		if (link.password_hash) {
			const provided = req.get('x-link-password') || '';
			if (!verifyPassword(provided, link.password_hash)) {
				return res.status(401).json({ error: 'Wrong or missing link password' });
			}
		}

		const account = getAccountById(link.user_id, link.cloud_account_id);
		if (!account) {
			return res.status(404).json({ error: 'Link not found' });
		}

		const adapter = createAdapter(account);
		const stream = await adapter.getDownloadStream({
			remote_file_id: link.remote_file_id,
			remote_parent_id: null,
			file_name: link.file_name,
			virtual_path: '/',
			is_folder: Boolean(link.is_folder),
			size: link.size,
			mime_type: link.mime_type,
		});

		touchShareLink(link.token);
		res.setHeader('Content-Disposition', `attachment; filename="${link.file_name}"`);
		res.setHeader('Content-Type', link.mime_type || 'application/octet-stream');
		stream.pipe(res);
	} catch (error) {
		next(error);
	}
});

export default router;
```

- [ ] **Step 3: Mount in `app.js`**

`backend/src/app.js`:
```js
import shareRoutes from './routes/shareRoutes.js';
// after telegramRoutes mount line 48:
	app.use('/api', shareRoutes);
```

- [ ] **Step 4: Route smoke + syntax check**

```bash
node --check src/routes/shareRoutes.js
```
For a functional smoke without provider creds, use the test file: the `share` service level is covered; the route layer is thin. Manual smoke (documented): `POST /api/share` with a file id → get `token`,`url`; anonymous `GET /api/share/:token/info` (200); `GET /api/share/:token/download` returns bytes (Mock/S3 provider can return a simulated stream); with password set, missing header → 401, wrong → 401, correct → 200; expired → 404; folder → 400 at create.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/shareRoutes.js backend/src/app.js backend/tests/shareRoutes.test.mjs
git commit -m "feat: public share link download and info routes"
```

---

## Task 12: Share links UI

**Files:**
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/composables/useFileActions.js` (+ `canShareSelection`, `openShareLinkModal`)
- Modify: `frontend/src/components/FileListContextMenu.vue` (add "Get link" action)
- Create: `frontend/src/components/ShareLinkModal.vue`
- Modify: `frontend/src/components/FileDetailsModal.vue` (live-link badge)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`

**Interfaces:**
- Consumes: `api.createShareLink/listShareLinks/revokeShareLink`, `contextMenu`/`resolveFile` from useFileActions.
- Produces: `ShareLinkModal.vue` (props `open`, `file`, emits `close`), `FileDetailsModal` badge.

- [ ] **Step 1: Add API methods**

`frontend/src/services/api.js`:
```js
	createShareLink(payload) {
		return request('/share', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	listShareLinks() {
		return request('/share');
	},
	revokeShareLink(token) {
		return request(`/share/${token}`, {
			method: 'DELETE',
		});
	},
```

- [ ] **Step 2: `ShareLinkModal.vue`**

```vue
<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconX, IconCopy, IconCheck, IconLink } from '@tabler/icons-vue';
import { api } from '../services/api';

const props = defineProps({ open: { type: Boolean, default: false }, file: { type: Object, default: null } });
const emit = defineEmits(['close']);

const { t } = useI18n();
const token = ref('');
const url = ref('');
const expiresAt = ref(null);
const expiryDays = ref(7);
const password = ref('');
const errorRef = ref('');
const copied = ref(false);
const revoking = ref(false);
const creating = ref(false);

watch(() => props.open, (open) => {
	if (!open) return;
	token.value = '';
	url.value = '';
	expiresAt.value = null;
	errorRef.value = '';
	copied.value = false;
	password.value = '';
	expiryDays.value = 7;
});

async function create() {
	creating.value = true;
	errorRef.value = '';
	try {
		const { data } = await api.createShareLink({
			fileId: props.file.id,
			expiresInDays: expiryDays.value,
			password: password.value || undefined,
		});
		token.value = data.token;
		url.value = data.url;
		expiresAt.value = data.expiresAt;
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		creating.value = false;
	}
}

async function copyUrl() {
	try {
		await navigator.clipboard.writeText(url.value);
		copied.value = true;
		setTimeout(() => { copied.value = false; }, 1500);
	} catch {
		// clipboard blocked — fall back to prompt-less select
	}
}

async function revoke() {
	revoking.value = true;
	try {
		await api.revokeShareLink(token.value);
		token.value = '';
		url.value = '';
	} catch (error) {
		errorRef.value = error.message;
	} finally {
		revoking.value = false;
	}
}
</script>

<template>
	<div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" @click.self="emit('close')">
		<div class="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-800">
			<div class="flex items-center justify-between">
				<h2 class="text-lg font-semibold">{{ t('share.title') }}</h2>
				<button type="button" class="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" @click="emit('close')"><IconX :size="18" /></button>
			</div>

			<div v-if="errorRef" class="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{{ errorRef }}</div>

			<div v-if="!token" class="mt-4 space-y-3">
				<label class="block text-sm font-medium">{{ t('share.expiry') }}</label>
				<select v-model="expiryDays" class="w-full rounded-xl border border-[#dfe6f1] bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
					<option :value="7">7 {{ t('common.days') }}</option>
					<option :value="30">30 {{ t('common.days') }}</option>
					<option :value="0">{{ t('share.noExpiry') }}</option>
				</select>
				<label class="block text-sm font-medium">{{ t('share.password') }} <span class="font-normal text-[#5f6368] dark:text-slate-400">({{ t('share.optional') }})</span></label>
				<input v-model="password" type="password" class="w-full rounded-xl border border-[#dfe6f1] px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
				<button type="button" class="mt-2 w-full rounded-full bg-[#1a73e8] py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="creating" @click="create">{{ t('share.create') }}</button>
			</div>

			<div v-else class="mt-4 space-y-3">
				<div class="flex items-center gap-2 rounded-xl bg-[#e8f0fe] px-3 py-2 dark:bg-sky-500/15">
					<IconLink :size="18" class="shrink-0 text-[#1a73e8] dark:text-blue-300" />
					<input :value="url" readonly class="min-w-0 flex-1 bg-transparent text-sm outline-none" />
					<button type="button" class="grid size-8 shrink-0 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" :title="t('share.copy')" @click="copyUrl">
						<IconCheck v-if="copied" :size="16" class="text-green-600" />
						<IconCopy v-else :size="16" />
					</button>
				</div>
				<p class="text-xs text-[#5f6368] dark:text-slate-400">{{ expiresAt ? `${t('share.expires')}: ${new Date(expiresAt).toLocaleString()}` : t('share.noExpiry') }}</p>
				<button type="button" class="w-full rounded-full border border-[#c5221f] py-2 text-sm font-semibold text-[#c5221f] disabled:opacity-50" :disabled="revoking" @click="revoke">{{ t('share.revoke') }}</button>
			</div>
		</div>
	</div>
</template>
```

Add `"days"` to `common` in both locales if missing (`"days": "days"` / `"hari"`).

- [ ] **Step 3: useFileActions + context menu wiring**

In `frontend/src/composables/useFileActions.js`:
```js
	const canShareSelection = computed(
		() => selectedCount.value === 1 && Boolean(primarySelectedFile.value) && !primarySelectedFile.value.is_folder,
	);
	const shareLinkFile = ref(null);
	const isShareLinkOpen = ref(false);
	function openShareLinkModal() {
		const file = resolveFile();
		if (!file || file.is_folder) return;
		closeContextMenu();
		shareLinkFile.value = file;
		isShareLinkOpen.value = true;
	}
	function closeShareLinkModal() {
		isShareLinkOpen.value = false;
		shareLinkFile.value = null;
	}
```
Add to imports `ref`. Export `canShareSelection`, `shareLinkFile`, `isShareLinkOpen`, `openShareLinkModal`, `closeShareLinkModal`.

In `FileListContextMenu.vue` add a `Get link` entry gated on `canShareSelection` that emits `get-link`; in `MyDriveView.vue` render `<ShareLinkModal :open="actions.isShareLinkOpen" :file="actions.shareLinkFile" @close="actions.closeShareLinkModal" />` and `@get-link="actions.openShareLinkModal"`.

- [ ] **Step 4: FileDetailsModal badge**

In `frontend/src/components/FileDetailsModal.vue` fetch owned links on open and show a badge:
```js
const liveLinks = ref([]);
async function loadLinks() {
	try {
		const { data } = await api.listShareLinks();
		liveLinks.value = (data || []).filter((link) => link.file_id === detailsRef.value?.id && !link.expired);
	} catch { liveLinks.value = []; }
}
```
Show `{{ t('share.hasLink') }} (${liveLinks.value.length})` when > 0.

- [ ] **Step 5: Locale keys**

`en.json`:
```json
	"share": {
		"title": "Share link",
		"copy": "Copy",
		"copied": "Copied",
		"expiry": "Expiry",
		"expires": "Expires",
		"password": "Password",
		"optional": "optional",
		"create": "Create link",
		"revoke": "Revoke link",
		"revoked": "Link revoked",
		"noExpiry": "Never expires",
		"hasLink": "Has link",
		"downloadCount": "downloads"
	},
```
`id.json`:
```json
	"share": {
		"title": "Tautan berbagi",
		"copy": "Salin",
		"copied": "Tersalin",
		"expiry": "Kedaluwarsa",
		"expires": "Kedaluwarsa",
		"password": "Kata sandi",
		"optional": "opsional",
		"create": "Buat tautan",
		"revoke": "Cabut tautan",
		"revoked": "Tautan dicabut",
		"noExpiry": "Tidak pernah kedaluwarsa",
		"hasLink": "Memiliki tautan",
		"downloadCount": "unduhan"
	},
```

- [ ] **Step 6: Verify + commit**

```bash
cd frontend && npm run build
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('src/locales/id.json','utf8'))"
```
Expected: PASS. Commit:
```bash
git add frontend/src/services/api.js frontend/src/composables/useFileActions.js frontend/src/components/FileListContextMenu.vue frontend/src/components/ShareLinkModal.vue frontend/src/components/FileDetailsModal.vue frontend/src/locales/en.json frontend/src/locales/id.json
git commit -m "feat: share link modal and file details badge"
```

---

## Task 13: Document env vars

**Files:**
- Modify: `.env.example` (repo root)

- [ ] **Step 1: Add environment variables**

Append to `.env.example`:
```bash
# How many days trashed files are kept before permanent deletion
TRASH_RETENTION_DAYS=30
# Reject uploads when the selected account lacks free space (false = warn only)
QUOTA_HARD_LIMIT_ENABLED=true
```
If `.env.example` does not exist at repo root and lives in `backend/.env.example`, update that file instead.

- [ ] **Step 2: Verify + commit**

```bash
git add .env.example
git commit -m "docs: document trash retention and quota hard-limit env vars"
```

---

## Task 14: Wave 3 end-to-end verification

- [ ] **Step 1: Full checks**

```bash
cd backend && node --test tests/ && cd ../frontend && npm run build
```

- [ ] **Step 2: Manual smoke**

1. Create a link on a file → open the URL in a private window → `:token/info` renders name/size; `/download` stream works.
2. Add a password → anonymous download without header → 401; with correct header → 200; download_count increments (assert via `GET /share/:token/info`).
3. Revoke → 404 on both public endpoints.
4. Folder → create returns 400 "Folders are not shareable".
5. Expired link → 404.

- [ ] **Step 3: Commit + push Wave 3**

```bash
git add -A
git commit -m "feat: public share links"
git push origin main
```

---
---

# Self-review notes

Checked against spec:
- Trash: table ✓, soft delete ✓, sync exclusion ✓, restore ✓, permanent ✓, purge cron ✓, routes ✓, UI ✓, i18n ✓.
- Move/Copy: adapter defaults ✓, cross-provider streaming ✓, routes + bulk ✓, dialog + context menu ✓, i18n ✓.
- ZIP: archiver ✓, mirror-walk expansion ✓, `errors.txt` ✓, sanitized paths ✓, frontend blob save ✓, i18n ✓.
- Share: table ✓, scrypt via authService hasher ✓, expiry default 7d ✓, counter ✓, public info/download ✓, 404 for missing/expired ✓, folder → 400 ✓, UI + badge ✓, i18n ✓.
- Quota: 507 ✓, env gate ✓, soft ≥85% flag ✓, UI states ✓, upload breakdown ✓, i18n ✓.
- Duplicates: SQL GROUP BY ✓, files only, size>0, count≥2 ✓, keep-one helper ✓, soft-delete path ✓, i18n ✓.
- Frontend wiring: api.js ✓, useFileActions ✓, router ✓, DriveShell nav ✓, .env.example ✓, tab-indented dual locales ✓.
- Build order: Wave 1 → 2 → 3, three pushed commits (+ per-task commits) ✓.
- Note: `test-driven-development` is approximated with `node:test`; the workflow in this plan uses fail-then-pass cycles per task.