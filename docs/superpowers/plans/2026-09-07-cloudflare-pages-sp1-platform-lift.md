# Cloudflare Pages Platform Lift (SP-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a single Cloudflare Pages project (advanced mode) that serves the static SPA and a slim Express-backed API from the same origin, with the DB on D1, proving the full pipe end-to-end (health, local-mode file list, public share-info) before the wider service port.

**Architecture:** One Pages project. `frontend/dist` is the static output; a root `_worker.js` (copied into the dist at build time) is the advanced-mode entry. It routes `/api/*` through a small Express app (`cloudflare/appSlim.js`) bridged via a hand-rolled `Request/Response → req/res` adapter (`cloudflare/expressBridge.js`), and falls back to `env.ASSETS.fetch(request)` for the SPA and `/s/{token}` deep links. All state lives in the `DB` D1 binding, reached through `D1Compat` (`cloudflare/db.js`). The Node/Express tree under `backend/src` is left untouched in this plan except for runtime-agnostic `env.js` and a shared-constants module; the full wide async port happens in the next sub-project (SP-2).

**Tech Stack:** Cloudflare Pages (advanced `_worker.js`), Wrangler v3/v4, D1, Express 5 (routing layer only), `nodejs_compat` v2, `node:test` + Miniflare (direct API, via Wrangler's transitive miniflare), Vite (frontend unchanged), Node 20+ (local tooling only).

## Global Constraints

Verbatim from the approved spec (docs/superpowers/specs/2026-09-07-opencloud-cloudflare-pages-design.md):

- Single Cloudflare Pages project; frontend + API on the **same origin** (no CORS).
- `compatibility_flags = ["nodejs_compat"]`; recent `compatibility_date`.
- D1 is the only database. Schema parity with `backend/src/config/database.js` (tables: users, auth_sessions, cloud_accounts, file_metadata, user_settings, trash, share_links; all listed indexes; local-user seed row `local-default-user` / `local@omnicloud.local`, is_local=1). WAL pragma dropped; FKs are on by default in D1.
- Env vars come from Pages environment variables (surfaced as `process.env.*`); local dev uses Wrangler `.dev.vars`. `PORT` is dropped. `dotenv` must not run on the Worker runtime path.
- Otherwise: MEGA/pCloud/Telegram ported last (out of scope here); chunked >100MB upload support comes later (out of scope here); WS upload progress comes later (poll fallback documented); `FRONTEND_URL` must equal the deployed origin; `OMNICLOUD_FINGERPRINT` (new secret, value `cloudflare-pages`) replaces the machine-fingerprint half of the encryption-key derivation on the deployed runtime.

## Scope Note (plan-level finding)

The worker can mount **only** a slim app in this plan. The full `createApp` imports `healthRoutes` → `syncService` → `adapterRegistry` → all provider SDKs (megajs, googleapis, …) which are Node-native and would break the Worker bundle. SP-1 therefore defines a small `cloudflare/appSlim.js` with the three slice endpoints; the full route surface is mounted in SP-2 once the provider/upload/telegram work is done. The SP-1 slice is intentionally self-contained so the entire `backend/src` tree stays green on Node with zero async churn.

## File Structure

Created (Cloudflare world, new files):
- `wrangler.jsonc` — Pages advanced-mode config: `nodejs_compat`, build command, D1/KV/R2/DO bindings placeholders, vars.
- `migrations/0001_init.sql` — full schema parity + local-user seed.
- `.dev.vars.example` — template for local secrets (copy to `.dev.vars`).
- `cloudflare/db.js` — `envStore` (AsyncLocalStorage) + `D1Compat` async statement API + `getDb()`.
- `cloudflare/appSlim.js` — tiny Express app: `GET /api/health`, `GET /api/files`, `GET /api/share/:token/info`; injects a local user in `APP_MODE=local`.
- `cloudflare/expressBridge.js` — `BridgeRequest` / `BridgeResponse` / `runExpress(app, request, opts) → Promise<Response>`.
- `cloudflare/_worker.js` — `fetch` entry: route `/api/*` through `runExpress(appSlim)`, everything else through `env.ASSETS.fetch`; runs each request inside `envStore.run(...)`.
- `scripts/pages-build.mjs` — runs the Vite build with `VITE_API_BASE_URL=/api`, copies `cloudflare/_worker.js` → `frontend/dist/_worker.js`.
- `cloudflare/tests/*.test.mjs` — Miniflare tests (via `node:test` + Miniflare direct API).
- `docs/cloudflare.md` — deploy/env reference.

Modified:
- `package.json` — scripts: `web:build`, `web:dev`, `web:deploy`, `web:test`, `d1:apply`, `d1:create`; devDep: `wrangler` only (Miniflare is transitive); `cross-env` avoided — see scripts.
- `.gitignore` — `.wrangler/`, `.dev.vars`, `.dev.vars.local`.
- `backend/src/config/constants.js` (new) — `LOCAL_USER_ID`, `LOCAL_USER_EMAIL` (moved from `database.js`).
- `backend/src/config/database.js` — re-export constants from `constants.js` (no other change).
- `backend/src/config/env.js` — runtime-agnostic: drop `dotenv.config()` call and the `os` fingerprint in favor of an optional `process.env.OMNICLOUD_FINGERPRINT`; behavior identical on Node when unset.
- `backend/src/server.js` — add `import 'dotenv/config';` at top (dotenv now loads only in the Node server process).
- `README.md` — add a "Cloudflare Pages deployment" pointer to `docs/cloudflare.md`.

Responsibilities per file: `wrangler.jsonc` = deployment shape; `migrations/0001_init.sql` = ground truth schema; `cloudflare/db.js` = the only way worker code touches D1; `cloudflare/appSlim.js` = the slice HTTP surface; `cloudflare/expressBridge.js` = Express-on-Workers transport (spike-critical); `cloudflare/_worker.js` = request routing + env scoping; `scripts/pages-build.mjs` = deterministic CI/local build.

---

### Task 1: Runtime-agnostic env + shared constants (no behavior change on Node)

**Files:**
- Create: `backend/src/config/constants.js`
- Modify: `backend/src/config/database.js:9-10` (import + re-export), `backend/src/config/env.js:1-14`, `backend/src/server.js` (top)

**Interfaces:**
- Produces: `LOCAL_USER_ID` (`'local-default-user'`), `LOCAL_USER_EMAIL` (`'local@omnicloud.local'`) from `backend/src/config/constants.js`. `env.js` keeps exporting `env` and `redactEnv()` with the exact same field shapes; `env.syncIntervalMinutes`, `env.trashRetentionDays`, etc. unchanged.

- [ ] **Step 1: Create the constants module**

Create `backend/src/config/constants.js`:

```js
export const LOCAL_USER_ID = 'local-default-user';
export const LOCAL_USER_EMAIL = 'local@omnicloud.local';
```

- [ ] **Step 2: Point database.js at it**

In `backend/src/config/database.js`, replace the two `export const LOCAL_USER_*` lines with:

```js
export { LOCAL_USER_ID, LOCAL_USER_EMAIL } from './constants.js';
```

- [ ] **Step 3: Make env.js runtime-agnostic**

In `backend/src/config/env.js`:
- Remove `import os from 'os';` and the `import dotenv from 'dotenv';` line (and its `dotenv.config();` call).
- Replace the machine-fingerprint block (lines ~7-14) with:

```js
const fingerprint = process.env.OMNICLOUD_FINGERPRINT || 'local-machine';
const envHalf = process.env.OMNICLOUD_SECRET_HALF || 'omnicloud-dev-secret-half';
const derivedKeyMaterial = `${envHalf}:${fingerprint}`;
const encryptionKey = crypto.createHash('sha256').update(derivedKeyMaterial).digest();
```

Keep every other field identical.

- [ ] **Step 4: Load dotenv only in the Node server**

Add to the very top of `backend/src/server.js`:

```js
import 'dotenv/config';
```

- [ ] **Step 5: Verify Node behavior unchanged**

Run: `node -e "const e = await import('./src/config/env.js'); console.log(e.env.appMode, e.env.port, e.env.trashRetentionDays)"`
Expected: `local 8787 30` (whatever your local `.env` sets, as long as it matches the defaults).

Run: `npm test`
Expected: all 16 backend tests still pass (env/constants swap is behavior-neutral).

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/constants.js backend/src/config/database.js backend/src/config/env.js backend/src/server.js
git commit -m "refactor: runtime-agnostic env and shared user constants"
```

---

### Task 2: Cloudflare scaffold (wrangler config, migration, scripts, gitignore)

**Files:**
- Create: `wrangler.jsonc`, `migrations/0001_init.sql`, `.dev.vars.example`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: D1 binding named `DB`; `npm run d1:create`, `npm run d1:apply`, `npm run web:build`, `npm run web:dev`, `npm run web:deploy`, `npm run web:test`. The migration file is the seed source for both real deploys and the Miniflare tests (Task 6 reads it from disk to seed test D1).

- [ ] **Step 1: Write the D1 migration**

Create `migrations/0001_init.sql` with the full schema parity (copy the DDL from `backend/src/config/database.js`, dropping the WAL pragma; wrap the local-user seed as the last statement). It must contain, in order: `users`, `auth_sessions`, `cloud_accounts`, `file_metadata`, `user_settings`, `trash`, `share_links`, then all 11 indexes from `database.js`, then:

```sql
INSERT OR IGNORE INTO users (id, email, password_hash, is_local) VALUES ('local-default-user', 'local@omnicloud.local', '', 1);
```

Caveats: D1 uses `CURRENT_TIMESTAMP` the same way; `CHECK (status IN (...))` is fine; indexes `idx_cloud_accounts_user_provider_email` and `idx_file_account_remote_id` must be `CREATE UNIQUE INDEX`.

- [ ] **Step 2: Write wrangler.jsonc**

```jsonc
{
  "name": "opencloud",
  "compatibility_date": "2025-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "pages_build_output_dir": "frontend/dist",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "opencloud",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "APP_MODE": "local"
  }
}
```

Note: `database_id` is intentionally omitted from source control — SP-1 documents `wrangler d1 create opencloud` in `docs/cloudflare.md`; the engineer adds the returned ID locally via `wrangler d1 migrations apply` prompts or a local `.dev.vars` override. KV/R2/DO bindings are added in later sub-projects; do not add placeholders that break `wrangler deploy`.

- [ ] **Step 3: Write .dev.vars.example**

```text
# Copy to .dev.vars for `wrangler pages dev`. Same var names as Pages env vars.
APP_MODE=local
OMNICLOUD_SECRET_HALF=change-me
AUTH_SECRET=change-me
FRONTEND_URL=http://localhost:8788
```

- [ ] **Step 4: Add package scripts and devDeps**

In root `package.json` scripts add:

```json
"web:build": "node scripts/pages-build.mjs",
"web:dev": "node scripts/pages-build.mjs && wrangler pages dev frontend/dist --port 8788",
"web:deploy": "node scripts/pages-build.mjs && wrangler pages deploy frontend/dist --branch main --project-name opencloud",
"web:test": "node --test \"cloudflare/tests/*.test.mjs\"",
"d1:create": "wrangler d1 create opencloud",
"d1:apply": "wrangler d1 migrations apply opencloud",
"d1:apply:local": "wrangler d1 migrations apply opencloud --local"
```

Add devDeps: `wrangler` only (verify latest version with `npm info wrangler version` before pinning `^`). Miniflare comes in transitively via Wrangler; the harnesses use Node's built-in `node:test`. Vitest / `@cloudflare/vitest-pool-workers` are deferred to SP-2.

- [ ] **Step 5: Extend .gitignore**

Append:

```text
.dev.vars
.wrangler/
```

- [ ] **Step 6: Verify scaffold installs and migration applies locally**

Run: `npm install`
Run: `npm run d1:apply:local`
Expected: applies `migrations/0001_init.sql` to a local D1 under `.wrangler/` with no errors.

- [ ] **Step 7: Commit**

```bash
git add wrangler.jsonc migrations/0001_init.sql .dev.vars.example package.json .gitignore
git commit -m "chore: cloudflare pages scaffold with d1 migration"
```

---

### Task 3: D1Compat async statement API + env store

**Files:**
- Create: `cloudflare/db.js`

**Interfaces:**
- Produces: `envStore` (AsyncLocalStorage), `getDb()` → a `D1Compat` instance for the current request, `D1Compat` methods: `prepare(sql).run(...params) → Promise<{meta}>`, `.get(...params) → Promise<object|undefined>`, `.all(...params) → Promise<{results:object[]}>`, and `exec(sql) → Promise`. `D1Compat.run` mirrors D1 semantics: returns `{ meta, results? }`; for `count`-style introspection use `get`/`all`.

Consumers: `cloudflare/appSlim.js`, `cloudflare/_worker.js` (which calls `envStore.run(env, ...)`).

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/miniflare.test.mjs` with Miniflare directly (no Vitest pool yet — keep this dependency-light):

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { envStore, getDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('getDb() returns D1Compat bound to the request env', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x"); } }',
    d1Databases: ['DB'],
    compatibilityFlags: ['nodejs_compat'],
  });
  try {
    await mf.ready;
    const env = await mf.getBindings();
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8');
    await env.DB.exec(migrationSql);
    await envDBRoundTrip(env);
  } finally {
    await mf.dispose();
  }
  async function envDBRoundTrip(env) {
    await envStore.run(env, async () => {
      const db = getDb();
      await db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.c');
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
      assert.equal(row.email, 'a@b.c');
      const all = await db.prepare('SELECT id FROM users ORDER BY id').all();
      assert.ok(all.results.some((r) => r.id === 'local-default-user'));
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/miniflare.test.mjs`
Expected: FAIL — `Cannot find module '../db.js'` (module doesn't exist yet).

- [ ] **Step 3: Implement cloudflare/db.js**

```js
import { AsyncLocalStorage } from 'node:async_hooks';

export const envStore = new AsyncLocalStorage();

export function d1CompatFrom(d1) {
	return {
		prepare(sql) {
			const stmt = d1.prepare(sql);
			return {
				run: (...args) => stmt.bind(...args).run(),
				get: async (...args) => (await stmt.bind(...args).first()), // D1 has no .get; use first()
				all: (...args) => stmt.bind(...args).all(),
			};
		},
		exec: (sql) => d1.exec(sql),
	};
}

export function getDb() {
	const store = envStore.getStore();
	if (!store?.DB) throw new Error('D1 binding "DB" is not available in this context');
	return d1CompatFrom(store.DB);
}
```

Note: D1 `Statement` has `.bind()` then `.run()/.all()/.first()`. `.first()` returns the first row or `null` (absent row) — normalize to `undefined` in the adapter if any caller relies on `undefined`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/miniflare.test.mjs`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/db.js cloudflare/tests/miniflare.test.mjs package.json
git commit -m "feat: D1 async statement API with request-scoped env store"
```

---

### Task 4: Express bridge (Request/Response → req/res) — spike gate

**Files:**
- Create: `cloudflare/expressBridge.js`, `cloudflare/tests/bridge.test.mjs`

**Interfaces:**
- Produces: `runExpress(app, request, { user }) → Promise<Response>`. Consumed by `cloudflare/_worker.js` and tested by the slice tests.

**Spike gate:** This task validates the riskiest assumption. If the bridge cannot serve a trivial Express route under Miniflare after this task, STOP and record the fallback in the plan's risk table: use a Workers-native router in `_worker.js` (the slice functions in `cloudflare/appSlim.js` get ported to plain `fetch` handlers; D1/db layer is unaffected).

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/bridge.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import express from 'express';
import { runExpress } from '../expressBridge.js';

async function withEnv(fn) {
	const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityFlags: ['nodejs_compat'] });
	try { await mf.ready; return await fn(await mf.getBindings()); }
	finally { await mf.dispose(); }
}

test('runExpress serves an Express route', async () => {
	const app = express();
	app.get('/api/health', (req, res) => res.json({ ok: true }));
	await withEnv(async (env) => {
		const res = await runExpress(app, new Request('http://x/api/health'), {});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
	});
});

test('bridge forwards query + status codes', async () => {
	const app = express();
	app.get('/api/echo', (req, res) => res.status(201).json({ q: req.query.name }));
	await withEnv(async () => {
		const res = await runExpress(app, new Request('http://x/api/echo?name=alice'), {});
		assert.equal(res.status, 201);
		assert.deepEqual(await res.json(), { q: 'alice' });
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/bridge.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bridge**

Create `cloudflare/expressBridge.js`:

```js
class BridgeResponse {
	constructor() {
		this.statusCode = 200;
		this.headersSent = false;
		this.finished = false;
		this.writableEnded = false;
		this._headers = new Headers();
		this._chunks = [];
		this.socket = undefined;
		this.connection = undefined;
		this.locals = {};
		this._finishResolvers = [];
		this.getHeader = (n) => this._headers.get(n) ?? undefined;
		this.getHeaders = () => Object.fromEntries(this._headers.entries());
		this.setHeader = (n, v) => { this._headers.set(n, String(v)); };
		this.removeHeader = (n) => { this._headers.delete(n); };
		this.hasHeader = (n) => this._headers.has(n);
		this.append = (n, v) => { const cur = this._headers.get(n); this._headers.set(n, cur ? `${cur}, ${v}` : String(v)); };
		this.flushHeaders = () => {};
		this.getHeaderNames = () => [...this._headers.keys()];
	}
	status(code) { this.statusCode = code; return this; }
	sendStatus(code) { return this.status(code).end(String(code)); }
	send(body) { if (body !== undefined && body !== null) this._chunks.push(Buffer.from(body)); return this; }
	json(body) { this.setHeader('Content-Type', 'application/json; charset=utf-8'); return this.send(JSON.stringify(body)); }
	writeHead(code, headers) { this.statusCode = code; if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); return this; }
	write(chunk) { this._chunks.push(Buffer.from(chunk)); return true; }
	end(chunk) { if (chunk) this._chunks.push(Buffer.from(chunk)); this.headersSent = true; this.finished = true; this.writableEnded = true; for (const r of this._finishResolvers) r(); return this; }
	on(evt, fn) { if (evt === 'finish' && this.finished) queueMicrotask(fn); else if (evt === 'finish') this._finishResolvers.push(fn); return this; }
	once(evt, fn) { return this.on(evt, fn); }
	emit() { return true; }
}

function parseCookies(header = '') {
	return Object.fromEntries(String(header || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

export function createBridgeRequest(request, user) {
	const url = new URL(request.url);
	const headers = Object.fromEntries(request.headers.entries());
	return {
		method: request.method,
		url: url.pathname + url.search,
		path: url.pathname,
		query: Object.fromEntries(url.searchParams),
		headers,
		get(name) { return headers[String(name).toLowerCase()]; },
		header(name) { return this.get(name); },
		body: undefined,
		cookies: parseCookies(headers.cookie),
		user,
		_webRequest: request,
	};
}

export async function runExpress(app, request, { user } = {}) {
	const req = createBridgeRequest(request, user);
	const res = new BridgeResponse();
	try {
		app(req, res);
	} catch (err) {
		res.status(500).json({ error: err?.message || 'Internal server error' });
	}
	if (!res.finished) {
		await new Promise((resolve) => res.once('finish', resolve));
	}
	const body = res._chunks.length ? Buffer.concat(res._chunks) : null;
	return new Response(body, { status: res.statusCode, headers: res._headers });
}
```

> Engineer note: `app(req, res)` invokes Express's top-level handler. If Express 5 under Miniflare throws because it touches `res.socket`/`res.req` properties we did not stub, add the missing property as an inert stub and re-run; if it instead never calls `end`, add a 2s timeout race around the `finish` await and record the result in the risk table (spike failure → router fallback).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/bridge.test.mjs`
Expected: PASS (2 tests). Record outcome of the spike gate in the task notes: bridge works (proceed) or fallback (STOP, follow risk table).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/expressBridge.js cloudflare/tests/bridge.test.mjs
git commit -m "feat: express-to-workers bridge (spike validated)"
```

---

### Task 5: Slim app + slice services on D1

**Files:**
- Create: `cloudflare/appSlim.js`
- Test: `cloudflare/tests/splice.test.mjs`

**Interfaces:**
- Consumes: `getDb()` (Task 3), `runExpress` (Task 4), `LOCAL_USER_ID` from `backend/src/config/constants.js`.
- Produces: `createSlimApp()` exporting an Express app with routes `GET /api/health`, `GET /api/files`, `GET /api/share/:token/info`, plus `res.status(401)` when no `req.user` on `/api/files`.
- Public `share/info` shape (matches `shareService.toPublic`): `{ id, file_name, size, mime_type, is_folder, token, expires_at, download_count, url, expired }`.

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/splice.test.mjs` using Miniflare with `env.DB` seeded from the migration (mirror the Task 3 Miniflare harness, reused via a small helper in `cloudflare/tests/helpers.mjs`):

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runExpress } from '../expressBridge.js';
import { createSlimApp } from '../appSlim.js';
import { seedEnv } from './helpers.mjs';

test('health returns ok', async () => {
	await seedEnv(async (env) => {
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/health'), { user: { id: 'local-default-user' } });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).appMode, 'local');
	});
});

test('files list reads seeded rows from D1', async () => {
	await seedEnv(async (env) => {
		await env.DB.prepare(`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,size,cloud_account_id,remote_file_id)
			VALUES ('f1','local-default-user','/','hello.txt',0,5,'acc1','rm1')`).run();
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/files?path=/'), { user: { id: 'local-default-user' } });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.files));
		assert.equal(body.files[0].file_name, 'hello.txt');
	});
});

test('files list requires auth in hosted mode', async () => {
	await seedEnv(async () => {
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/files'), { user: null });
		assert.equal(res.status, 401);
	});
});

test('share info returns public metadata + expired flag', async () => {
	await seedEnv(async (env) => {
		await env.DB.prepare(`INSERT INTO share_links (id,user_id,file_id,cloud_account_id,remote_file_id,file_name,size,mime_type,is_folder,token,download_count)
			VALUES ('s1','local-default-user','f1','acc1','rm1','hello.txt',5,'text/plain',0,'tok123',0)`).run();
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/share/tok123/info'), { user: null });
		assert.equal(res.status, 200);
		const info = await res.json();
		assert.equal(info.data.file_name, 'hello.txt');
		assert.equal(info.data.expired, false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/splice.test.mjs`
Expected: FAIL — `Cannot find module '../appSlim.js'`.

- [ ] **Step 3: Implement appSlim.js**

```js
import express from 'express';
import { getDb } from './db.js';
import { env } from '../backend/src/config/env.js';

function toPublic(row) {
	return {
		id: row.id,
		file_id: row.file_id,
		file_name: row.file_name,
		size: row.size,
		mime_type: row.mime_type,
		is_folder: row.is_folder,
		token: row.token,
		expires_at: row.expires_at,
		download_count: row.download_count,
		url: `${env.frontendUrl}/s/${row.token}`,
		expired: !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now(),
	};
}

export function createSlimApp() {
	const app = express();
	app.use(express.json());

	app.get('/api/health', (_req, res) => {
		res.json({ status: 'ok', appMode: env.appMode, port: env.port });
	});

	app.get('/api/files', async (req, res) => {
		if (!req.user) return res.status(401).json({ error: 'Authentication required' });
		const db = getDb();
		const path = typeof req.query.path === 'string' ? req.query.path : '/';
		const rows = (await db.prepare(
			'SELECT * FROM file_metadata WHERE user_id = ? AND virtual_path = ? ORDER BY is_folder DESC, file_name COLLATE NOCASE',
		).all(req.user.id, normalizePath(path))).results;
		res.json({ files: rows });
	});

	app.get('/api/share/:token/info', async (req, res) => {
		const db = getDb();
		const row = await db.prepare('SELECT * FROM share_links WHERE token = ?').get(req.params.token);
		if (!row || row.is_folder || toPublic(row).expired) return res.status(404).json({ error: 'Share link not found' });
		res.json({ data: toPublic(row) });
	});

	return app;
}

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}
```

> Engineer note: `normalizePath` matches `backend/src/services/fileService.js` semantics exactly (mirror while the slice stands alone; delete once SP-2 ports the real service).

> Engineer note: `app.use(express.json())` is present for parity with the real app. Under the bridge it is inert for these GET-only routes (no `Content-Type: application/json` body ⇒ `typeis.hasBody` is false ⇒ it never reads `req`). If a POST route is added to the slice before SP-2, the bridge must provide a request-body reader (see `getRawBody` in Task 4); do not add body-reading middleware before that.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/splice.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/appSlim.js cloudflare/tests/splice.test.mjs cloudflare/tests/helpers.mjs
git commit -m "feat: slim api slice on D1 (health, files list, share info)"
```

---

### Task 6: Worker entry + ASSETS fallback + local mode

**Files:**
- Create: `cloudflare/_worker.js`
- Test: `cloudflare/tests/worker.test.mjs`

**Interfaces:**
- Consumes: `createSlimApp()` (Task 5), `envStore` (Task 3).
- Produces: the Pages advanced-mode entry. Non-`/api` requests → `env.ASSETS.fetch(request)`. `APP_MODE=local` → inject `{ id: LOCAL_USER_ID }` as `req.user`.

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/worker.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startWorker() {
	return new Miniflare({
		modules: true,
		scriptPath: path.resolve(__dirname, '_worker.js'),
		modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
		d1Databases: ['DB'],
		compatibilityFlags: ['nodejs_compat'],
		compatibilityDate: '2025-06-01',
	});
}

test('spa fallback serves a response for non-api path', async () => {
	const mf = await startWorker();
	try {
		await mf.ready;
		const env = await mf.getBindings();
		await env.DB.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8'));
		const res = await mf.dispatchFetch('http://x/');
		assert.ok(res.status < 400, `expected <400 but got ${res.status}`);
	} finally { await mf.dispose(); }
});

test('api health works through the worker', async () => {
	const mf = await startWorker();
	try {
		await mf.ready;
		const res = await mf.dispatchFetch('http://x/api/health');
		assert.equal(res.status, 200);
		assert.equal((await res.json()).status, 'ok');
	} finally { await mf.dispose(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/worker.test.mjs`
Expected: FAIL — no `_worker.js`. (Also make `scripts/pages-build.mjs` and `npm run web:test` wired — see Step 6.)

- [ ] **Step 3: Implement cloudflare/_worker.js**

```js
import { envStore } from './db.js';
import { createSlimApp } from './appSlim.js';
import { runExpress } from './expressBridge.js';
import { LOCAL_USER_ID } from '../backend/src/config/constants.js';

const app = createSlimApp();
const localUser = { id: LOCAL_USER_ID, email: 'local@omnicloud.local' };

export default {
	async fetch(request, env) {
		return envStore.run(env, async () => {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/api/')) {
				const appMode = env.APP_MODE ?? 'local';
				const user = appMode === 'local' ? localUser : null;
				return runExpress(app, request, { user });
			}
			return env.ASSETS.fetch(request);
		});
	},
};
```

> Engineer note: For the `node --test` harness the default export must be the worker module. `envStore.run(env, ...)` scopes D1 to the request (Task 3). `env.ASSETS` is provided by Pages in real deploys; in the Miniflare test we only assert the non-404 contract.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/worker.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the build/copy script**

Create `scripts/pages-build.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const env = { ...process.env, VITE_API_BASE_URL: '/api', VITE_WS_BASE_URL: '/ws/uploads' };
const run = spawnSync('npm', ['--prefix', 'frontend', 'run', 'build'], { stdio: 'inherit', env, shell: true });
if (run.status !== 0) process.exit(run.status ?? 1);

copyFileSync(path.join(root, 'cloudflare', '_worker.js'), path.join(root, 'frontend', 'dist', '_worker.js'));
console.log('copied _worker.js into frontend/dist');
```

- [ ] **Step 6: Wire the test runner script**

Keep the runner consistent with the harnesses written in Tasks 3–6 (they use `node:test` + Miniflare directly). In `package.json` set:

```json
"web:test": "node --test \"cloudflare/tests/*.test.mjs\""
```

(Vitest / `@cloudflare/vitest-pool-workers` are deferred to SP-2, where the backend Node tests migrate.)

- [ ] **Step 7: Verify build output contains the worker**

Run: `npm run web:build`
Expected: vite build succeeds, and `frontend/dist/_worker.js` exists.

Run: `npm run web:test`
Expected: bridge + slice + worker tests all pass.

- [ ] **Step 8: Commit**

```bash
git add cloudflare/_worker.js cloudflare/tests/worker.test.mjs scripts/pages-build.mjs package.json
git commit -m "feat: pages advanced-mode entry with spa fallback + build script"
```

---

### Task 7: Local `wrangler pages dev` smoke + docs

**Files:**
- Create: `docs/cloudflare.md`
- Modify: `README.md` (deployment section pointer)

**Interfaces:**
- Produces: runnable local dev flow + deployment reference (env var table, d1 create/apply, deploy command, OAuth redirect note).

- [ ] **Step 1: Write docs/cloudflare.md**

Include:
- `wrangler d1 create opencloud` → paste the returned `database_id` into the dashboard or `wrangler.jsonc` locally (never commit it).
- Env vars table (from the spec §4): APP_MODE, OMNICLOUD_SECRET_HALF, AUTH_SECRET, AUTH_COOKIE_NAME, AUTH_SESSION_TTL_HOURS, TRASH_RETENTION_DAYS, QUOTA_HARD_LIMIT_ENABLED, SYNC_INTERVAL_MINUTES, FRONTEND_URL, OMNICLOUD_FINGERPRINT=cloudflare-pages, and the OAuth/Telegram vars (empty for now, used by SP-4/SP-5).
- Local dev: `npm run d1:apply:local` then `npm run web:dev` → http://localhost:8788.
- Deploy: `npm run d1:apply` (against remote D1) then `npm run web:deploy`.
- Note: `dotenv`/`.env` do not apply on Pages; secrets are pages-workspace secrets or `vars` in the dashboard.

- [ ] **Step 2: Add a README section pointer**

Add to README.md after the Docker Setup section:

```markdown
## ☁️ Cloudflare Pages

Single-project deployment (SPA + API same origin, D1-backed). See [`docs/cloudflare.md`](docs/cloudflare.md) for env vars, local dev, and deploy steps.
```

- [ ] **Step 3: Manual smoke via wrangler pages dev**

Run: `npm run d1:apply:local`
Run: `npm run web:dev` (leave running, or spot-check then Ctrl+C)
Expected:
- `http://localhost:8788/` returns the SPA HTML.
- `http://localhost:8788/api/health` returns `{"status":"ok","appMode":"local","port":8787}`.
- `http://localhost:8788/api/files` returns `{"files":[]}` (empty D1) with 200.

Record results; if any fail, fix before continuing.

- [ ] **Step 4: Update the risk table entry (optional, only if spike failed)**

If Task 4 spike failed and the fallback was needed, append the router fallback decision to `docs/cloudflare.md` and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add docs/cloudflare.md README.md
git commit -m "docs: cloudflare pages deployment guide + smoke results"
```

---

### Task 8: Final verification pass

**Files:** (none new; verify only)

- [ ] **Step 1: Full local verification**

Run: `npm test` — expected 16/16 Node backend tests green.
Run: `npm run web:test` — expected all worker tests green.
Run: `npm run web:build` — dist produced with `_worker.js`.

- [ ] **Step 2: Confirm success criteria from the spec §8**

- [ ] `wrangler pages dev` serves the SPA at `/`.
- [ ] `GET /api/health` returns 200.
- [ ] `GET /api/files` returns seeded D1 rows (verified in Miniflare test `splice.test.mjs`).
- [ ] `GET /api/share/{token}/info` returns 200 from D1 (verified in Miniflare test).
- [ ] `APP_MODE=local` bypass works on the Workers platform.
- [ ] `npm run web:test` green locally without a real deploy.

- [ ] **Step 3: Handoff note**

Append to `docs/cloudflare.md` a "Known gaps" list: WS upload progress, >100MB uploads, full route surface (SP-2+), provider adapters (SP-4+), cron sync/Telegram (SP-5), MEGA/pCloud (SP-6).

- [ ] **Step 4: Commit**

```bash
git add docs/cloudflare.md
git commit -m "docs: handoff note for sp-1 known gaps"
```