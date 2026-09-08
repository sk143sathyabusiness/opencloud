# SP-2: Full Backend Port to Cloudflare Workers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the complete Node.js backend API surface to Cloudflare Workers — all routes, all provider adapters (except MEGA), with D1, KV, and SSE upload progress.

**Architecture:** Single Pages project (same as SP-1). Express 5 via `expressBridge.js` handles all `/api/*` routes. D1 replaces `better-sqlite3`. Workers KV stores ephemeral state (OAuth states, upload sessions, token caches). Web Crypto replaces `node:crypto`. Provider adapters use raw `fetch()` (Google Drive rewritten from `googleapis`; others already Web-native).

**Tech Stack:** Cloudflare Pages (advanced `_worker.js`), Wrangler v4, D1, Workers KV, Express 5 (bridge), `nodejs_compat`, `node:test` + Miniflare, Web Crypto API.

## Global Constraints

- Single Cloudflare Pages project; frontend + API on the same origin (no CORS).
- `compatibility_flags = ["nodejs_compat"]`; `compatibility_date = "2025-12-01"`.
- D1 is the only database. Schema parity with SP-1 migration (`migrations/0001_init.sql`).
- Env vars from Pages environment variables / `.dev.vars`. `dotenv` must not run on Worker runtime.
- MEGA provider is **dropped** from the Cloudflare version.
- Node.js backend (`npm test`) must remain green throughout SP-2.
- `express.json()` is **not** used on the bridge (incompatible with Workers IncomingMessage). Body parsing via `request.json()` / `request.formData()` in route handlers.
- All crypto operations use Web Crypto API (async). `scryptSync` replaced by PBKDF2.
- Workers KV (`STATE` binding) for ephemeral state. D1 for persistent state.
- Upload progress via SSE or polling (not WebSocket).

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `backend/src/config/crypto.js` | Async crypto functions (PBKDF2, SHA-256, randomBytes, timingSafeEqual) |
| `cloudflare/middleware.js` | CORS headers, auth context, cookie helpers, error handler |
| `cloudflare/kvStore.js` | KV wrapper (get/set/delete with JSON serialization + TTL) |
| `cloudflare/routes/auth.js` | Auth routes (me, register, login, logout) |
| `cloudflare/routes/accounts.js` | Account routes (list, connect, callback, delete, provider status) |
| `cloudflare/routes/files.js` | File routes (list, search, star, rename, delete, move, copy, trash, duplicates) |
| `cloudflare/routes/uploads.js` | Upload routes (initiate, stream, chunk, progress) |
| `cloudflare/routes/settings.js` | Settings routes (get, update) |
| `cloudflare/routes/allocation.js` | Allocation routes (get, update) |
| `cloudflare/routes/share.js` | Share routes (create, list, revoke, info, download) |
| `cloudflare/routes/health.js` | Health + manual sync trigger |
| `cloudflare/adapters/base.js` | Base adapter with Web Streams (ReadableStream) |
| `cloudflare/adapters/google.js` | Google Drive adapter (raw REST API) |
| `cloudflare/adapters/onedrive.js` | OneDrive adapter (minimal changes) |
| `cloudflare/adapters/dropbox.js` | Dropbox adapter (minimal changes) |
| `cloudflare/adapters/yandex.js` | Yandex adapter (minimal changes) |
| `cloudflare/adapters/s3.js` | S3 adapter (AWS SDK v3) |
| `cloudflare/adapters/pcloud.js` | pCloud adapter (minimal changes) |
| `cloudflare/tests/auth.test.mjs` | Auth route integration tests |
| `cloudflare/tests/accounts.test.mjs` | Account route integration tests |
| `cloudflare/tests/files.test.mjs` | File route integration tests |
| `cloudflare/tests/uploads.test.mjs` | Upload route integration tests |
| `cloudflare/tests/settings.test.mjs` | Settings/allocation integration tests |
| `cloudflare/tests/share.test.mjs` | Share route integration tests |
| `cloudflare/tests/crypto.test.mjs` | Crypto module unit tests |
| `cloudflare/tests/kv.test.mjs` | KV store unit tests |

### Modified files

| File | Changes |
|------|---------|
| `cloudflare/db.js` | Add `transaction()`, `batch()` methods |
| `cloudflare/expressBridge.js` | Add `res.req` stub, finish timeout, body reader support |
| `cloudflare/_worker.js` | Mount full app, add CORS, cron handler, remove slim-only routing |
| `cloudflare/appSlim.js` | Rename to `cloudflare/app.js`, mount all route groups |
| `wrangler.jsonc` | Add KV binding, cron triggers |
| `package.json` | Add any new devDeps if needed |

### Removed files

| File | Reason |
|------|--------|
| `cloudflare/tests/miniflare.test.mjs` | Replaced by route-specific test files |
| `cloudflare/tests/bridge.test.mjs` | Kept — bridge tests still valid |
| `cloudflare/tests/splice.test.mjs` | Replaced by `files.test.mjs` and `share.test.mjs` |
| `cloudflare/tests/helpers.mjs` | Extended with full-app helper |

---

## Tasks

### Task 1: D1 Adapter Extension

**Files:**
- Modify: `cloudflare/db.js`
- Test: `cloudflare/tests/db.test.mjs`

**Interfaces:**
- Produces: `D1Compat.transaction(fn)`, `D1Compat.batch(queries)`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/db.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { envStore, getDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8').replace(/\r?\n/g, ' ');

async function withDb(fn) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x"); } }',
    d1Databases: ['DB'],
    compatibilityFlags: ['nodejs_compat'],
  });
  try {
    await mf.ready;
    const env = await mf.getBindings();
    await env.DB.exec(migrationSql);
    await envStore.run(env, async () => fn(getDb()));
  } finally {
    await mf.dispose();
  }
}

test('transaction commits on success', async () => {
  await withDb(async (db) => {
    await db.transaction(async (tx) => {
      await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.c');
      await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u2', 'b@c.d');
    });
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
    assert.equal(row.email, 'a@b.c');
  });
});

test('transaction rolls back on error', async () => {
  await withDb(async (db) => {
    try {
      await db.transaction(async (tx) => {
        await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u3', 'c@d.e');
        throw new Error('boom');
      });
    } catch (e) {
      // expected
    }
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u3');
    assert.equal(row, undefined);
  });
});

test('batch executes multiple queries', async () => {
  await withDb(async (db) => {
    const results = await db.batch([
      db.prepare('SELECT COUNT(*) as cnt FROM users'),
      db.prepare('SELECT COUNT(*) as cnt FROM file_metadata'),
    ]);
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/db.test.mjs`
Expected: FAIL — `transaction` is not a function.

- [ ] **Step 3: Implement transaction and batch**

In `cloudflare/db.js`, add to the `D1Compat` object returned by `d1CompatFrom`:

```js
transaction: async (fn) => {
  await d1.exec('BEGIN');
  try {
    await fn(d1CompatFrom(d1));
    await d1.exec('COMMIT');
  } catch (err) {
    await d1.exec('ROLLBACK');
    throw err;
  }
},
batch: (queries) => d1.batch(queries.map((q) => q._stmt || q)),
```

Note: D1 `batch()` takes an array of `Statement` objects. The `prepare()` method needs to expose the raw D1 statement for batch. Adjust the adapter to store `_stmt` on each statement wrapper.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/db.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/db.js cloudflare/tests/db.test.mjs
git commit -m "feat: D1 transaction and batch support"
```

---

### Task 2: Crypto Module

**Files:**
- Create: `backend/src/config/crypto.js`
- Test: `cloudflare/tests/crypto.test.mjs`

**Interfaces:**
- Produces: `hashPassword(password, salt?)`, `verifyPassword(password, hash, salt)`, `generateToken()`, `hashToken(token)`, `constantTimeEqual(a, b)`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/crypto.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword, generateToken, hashToken, constantTimeEqual } from '../../backend/src/config/crypto.js';

test('hashPassword produces a hash and salt', async () => {
  const { hash, salt } = await hashPassword('mypassword');
  assert.ok(hash);
  assert.ok(salt);
  assert.ok(hash.length > 0);
});

test('verifyPassword returns true for correct password', async () => {
  const { hash, salt } = await hashPassword('test123');
  const result = await verifyPassword('test123', hash, salt);
  assert.equal(result, true);
});

test('verifyPassword returns false for wrong password', async () => {
  const { hash, salt } = await hashPassword('test123');
  const result = await verifyPassword('wrong', hash, salt);
  assert.equal(result, false);
});

test('generateToken returns a random hex string', async () => {
  const t1 = await generateToken();
  const t2 = await generateToken();
  assert.ok(t1.length > 0);
  assert.notEqual(t1, t2);
});

test('hashToken produces consistent SHA-256', async () => {
  const h1 = await hashToken('hello');
  const h2 = await hashToken('hello');
  assert.equal(h1, h2);
});

test('constantTimeEqual compares buffers', async () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  const c = new Uint8Array([1, 2, 4]);
  assert.equal(constantTimeEqual(a, b), true);
  assert.equal(constantTimeEqual(a, c), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/crypto.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement crypto.js**

Create `backend/src/config/crypto.js`:

```js
const ITERATIONS = 100000;
const KEY_LENGTH = 64;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function deriveKey(password, salt, iterations, keyLength) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, keyLength * 8);
}

export async function hashPassword(password, existingSalt) {
  const salt = existingSalt ? fromHex(existingSalt) : generateSalt();
  const hash = await deriveKey(password, salt, ITERATIONS, KEY_LENGTH);
  return { hash: toHex(hash), salt: toHex(salt) };
}

export async function verifyPassword(password, storedHash, salt) {
  const { hash } = await hashPassword(password, salt);
  return constantTimeEqual(fromHex(hash), fromHex(storedHash));
}

export async function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(bytes);
}

export async function hashToken(token) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toHex(hash);
}

export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/crypto.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify Node backend still green**

Run: `node --test backend/tests/*.test.mjs`
Expected: 16/16 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/crypto.js cloudflare/tests/crypto.test.mjs
git commit -m "feat: async crypto module (PBKDF2, SHA-256, timing-safe compare)"
```

---

### Task 3: KV Store Wrapper

**Files:**
- Create: `cloudflare/kvStore.js`
- Test: `cloudflare/tests/kv.test.mjs`

**Interfaces:**
- Produces: `kvGet(kv, key)`, `kvSet(kv, key, value, ttlSeconds?)`, `kvDelete(kv, key)`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/kv.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { kvGet, kvSet, kvDelete } from '../kvStore.js';

test('set and get a value', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x"); } }',
    kvNamespaces: ['STATE'],
  });
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    await kvSet(STATE, 'test-key', { foo: 'bar' });
    const val = await kvGet(STATE, 'test-key');
    assert.deepEqual(val, { foo: 'bar' });
  } finally {
    await mf.dispose();
  }
});

test('get returns null for missing key', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x"); } }',
    kvNamespaces: ['STATE'],
  });
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    const val = await kvGet(STATE, 'nonexistent');
    assert.equal(val, null);
  } finally {
    await mf.dispose();
  }
});

test('delete removes a value', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x"); } }',
    kvNamespaces: ['STATE'],
  });
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    await kvSet(STATE, 'del-key', 'hello');
    await kvDelete(STATE, 'del-key');
    const val = await kvGet(STATE, 'del-key');
    assert.equal(val, null);
  } finally {
    await mf.dispose();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/kv.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement kvStore.js**

Create `cloudflare/kvStore.js`:

```js
export async function kvGet(kv, key) {
  const val = await kv.get(key, { type: 'json' });
  return val;
}

export async function kvSet(kv, key, value, ttlSeconds) {
  const opts = { value: JSON.stringify(value) };
  if (ttlSeconds) opts.expirationTtl = ttlSeconds;
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

export async function kvDelete(kv, key) {
  await kv.delete(key);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/kv.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/kvStore.js cloudflare/tests/kv.test.mjs
git commit -m "feat: Workers KV store wrapper for ephemeral state"
```

---

### Task 4: Middleware (CORS, Auth Context, Cookies)

**Files:**
- Create: `cloudflare/middleware.js`
- Modify: `cloudflare/expressBridge.js`
- Test: `cloudflare/tests/middleware.test.mjs`

**Interfaces:**
- Produces: `corsHeaders(origin)`, `attachAuthContext(req, res, next)`, `requireAppUser(req, res, next)`, `parseCookies(header)`, `setCookie(res, name, value, opts)`, `clearCookie(res, name)`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/middleware.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corsHeaders, parseCookies, setCookie, clearCookie } from '../middleware.js';

test('corsHeaders returns Access-Control headers', () => {
  const h = corsHeaders('http://localhost:5173');
  assert.equal(h['Access-Control-Allow-Origin'], 'http://localhost:5173');
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
  assert.ok(h['Access-Control-Allow-Methods']);
});

test('parseCookies parses cookie header', () => {
  const cookies = parseCookies('session=abc123; theme=dark');
  assert.equal(cookies.session, 'abc123');
  assert.equal(cookies.theme, 'dark');
});

test('parseCookies handles empty header', () => {
  const cookies = parseCookies('');
  assert.deepEqual(cookies, {});
});

test('setCookie builds Set-Cookie header', () => {
  const res = { _headers: new Headers(), setHeader(n, v) { this._headers.set(n, v); } };
  setCookie(res, 'session', 'abc', { httpOnly: true, maxAge: 3600 });
  const cookie = res._headers.get('Set-Cookie');
  assert.ok(cookie.includes('session=abc'));
  assert.ok(cookie.includes('HttpOnly'));
});

test('clearCookie sets expired cookie', () => {
  const res = { _headers: new Headers(), setHeader(n, v) { this._headers.set(n, v); } };
  clearCookie(res, 'session');
  const cookie = res._headers.get('Set-Cookie');
  assert.ok(cookie.includes('session='));
  assert.ok(cookie.includes('Max-Age=0'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/middleware.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement middleware.js**

Create `cloudflare/middleware.js`:

```js
import { getDb } from './db.js';
import { constantTimeEqual, hashToken } from '../backend/src/config/crypto.js';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '../backend/src/config/constants.js';
import { env } from '../backend/src/config/env.js';

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );
}

export function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.secure) cookie += '; Secure';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? `${existing}, ${cookie}` : cookie);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0, path: '/' });
}

export async function attachAuthContext(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[env.authCookieName];

  if (token) {
    try {
      const tokenHash = await hashToken(token);
      const db = getDb();
      const session = await db.prepare(
        'SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > datetime("now")',
      ).get(tokenHash);
      if (session) {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        if (user) {
          req.user = { id: user.id, email: user.email, is_local: user.is_local === 1 };
          return next();
        }
      }
    } catch (e) {
      // session lookup failed, fall through
    }
  }

  // Local mode: auto-inject local user
  if (env.appMode === 'local') {
    req.user = { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL, is_local: true };
  }

  next();
}

export function requireAppUser(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/middleware.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Add `res.req` stub and finish timeout to bridge**

In `cloudflare/expressBridge.js`, in `createBridgeRequest`, add:

```js
// Inside the returned object:
get req() { return this; },  // Express 5 internal reference
```

In `runExpress`, add a timeout around the finish await:

```js
if (!res.finished) {
  await Promise.race([
    new Promise((resolve) => res.once('finish', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Response timeout')), 30000)),
  ]);
}
```

- [ ] **Step 6: Run all cloudflare tests**

Run: `node --test "cloudflare/tests/*.test.mjs"`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/middleware.js cloudflare/expressBridge.js cloudflare/tests/middleware.test.mjs
git commit -m "feat: CORS, auth context, cookie middleware + bridge improvements"
```

---

### Task 5: Auth Routes

**Files:**
- Create: `cloudflare/routes/auth.js`
- Test: `cloudflare/tests/auth.test.mjs`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `attachAuthContext`, `requireAppUser` (Task 4), crypto functions (Task 2)
- Produces: Express router with `GET /api/auth/me`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/auth.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runExpress } from '../expressBridge.js';
import { createAuthRouter } from '../routes/auth.js';
import { seedEnv } from './helpers.mjs';

test('GET /api/auth/me returns local user in local mode', async () => {
  await seedEnv(async (env) => {
    const router = createAuthRouter();
    const res = await runExpress(router, new Request('http://x/api/auth/me'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, 'local-default-user');
  });
});

test('POST /api/auth/register creates user', async () => {
  await seedEnv(async (env) => {
    const router = createAuthRouter();
    const res = await runExpress(router, new Request('http://x/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@test.com', password: 'pass123' }),
    }), {});
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.user);
    assert.equal(body.user.email, 'new@test.com');
  });
});

test('POST /api/auth/login returns user with correct password', async () => {
  await seedEnv(async (env) => {
    // First register
    const router = createAuthRouter();
    await runExpress(router, new Request('http://x/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@test.com', password: 'pass123' }),
    }), {});
    // Then login
    const res = await runExpress(router, new Request('http://x/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@test.com', password: 'pass123' }),
    }), {});
    assert.equal(res.status, 200);
  });
});

test('POST /api/auth/logout destroys session', async () => {
  await seedEnv(async (env) => {
    const router = createAuthRouter();
    const res = await runExpress(router, new Request('http://x/api/auth/logout', {
      method: 'POST',
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/auth.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement auth routes**

Create `cloudflare/routes/auth.js` with Express Router. Port logic from `backend/src/routes/authRoutes.js` and `backend/src/services/authService.js`. Key changes:
- `scryptSync` → `hashPassword` / `verifyPassword` from `crypto.js`
- `randomBytes` → `generateToken` from `crypto.js`
- `db.prepare(...).run(...)` → `await db.prepare(...).bind(...).run()`
- Session token cookie via `setCookie` from middleware

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/auth.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify Node backend still green**

Run: `node --test backend/tests/*.test.mjs`
Expected: 16/16 pass.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/routes/auth.js cloudflare/tests/auth.test.mjs
git commit -m "feat: auth routes on Workers (me, register, login, logout)"
```

---

### Task 6: Settings + Allocation Routes

**Files:**
- Create: `cloudflare/routes/settings.js`, `cloudflare/routes/allocation.js`
- Test: `cloudflare/tests/settings.test.mjs`

**Interfaces:**
- Produces: Express routers for settings and allocation

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/settings.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runExpress } from '../expressBridge.js';
import { createSettingsRouter } from '../routes/settings.js';
import { createAllocationRouter } from '../routes/allocation.js';
import { seedEnv } from './helpers.mjs';

test('GET /api/settings returns defaults', async () => {
  await seedEnv(async () => {
    const router = createSettingsRouter();
    const res = await runExpress(router, new Request('http://x/api/settings'), {
      user: { id: 'local-default-user' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.settings);
  });
});

test('PATCH /api/settings updates a setting', async () => {
  await seedEnv(async () => {
    const router = createSettingsRouter();
    const res = await runExpress(router, new Request('http://x/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: 'dark' }),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});

test('GET /api/allocation returns config', async () => {
  await seedEnv(async () => {
    const router = createAllocationRouter();
    const res = await runExpress(router, new Request('http://x/api/allocation'), {
      user: { id: 'local-default-user' },
    });
    assert.equal(res.status, 200);
  });
});

test('PATCH /api/allocation updates config', async () => {
  await seedEnv(async () => {
    const router = createAllocationRouter();
    const res = await runExpress(router, new Request('http://x/api/allocation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'least_used' }),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test cloudflare/tests/settings.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement settings + allocation routes**

Port from `backend/src/routes/settingsRoutes.js`, `backend/src/routes/allocationRoutes.js`, and their services. Pure D1 CRUD — straightforward async migration.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test cloudflare/tests/settings.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/settings.js cloudflare/routes/allocation.js cloudflare/tests/settings.test.mjs
git commit -m "feat: settings and allocation routes on Workers"
```

---

### Task 7: Share Routes (Full)

**Files:**
- Create: `cloudflare/routes/share.js`
- Test: `cloudflare/tests/share.test.mjs`

**Interfaces:**
- Consumes: `getDb()`, crypto functions, adapter registry
- Produces: Express router with create, list, revoke, info, download

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/share.test.mjs` with tests for:
- `POST /api/share` — creates link, returns token
- `GET /api/share` — lists user's links
- `DELETE /api/share/:token` — revokes link
- `GET /api/share/:token/info` — public info (already tested in SP-1, extend)
- `GET /api/share/:token/download` — returns 404 without adapter (provider not connected)

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement share routes**

Port from `backend/src/routes/shareRoutes.js` and `backend/src/services/shareService.js`.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/share.js cloudflare/tests/share.test.mjs
git commit -m "feat: share routes on Workers (create, list, revoke, info, download)"
```

---

### Task 8: Account Routes + OAuth

**Files:**
- Create: `cloudflare/routes/accounts.js`, `cloudflare/adapters/base.js`
- Test: `cloudflare/tests/accounts.test.mjs`

**Interfaces:**
- Consumes: `getDb()`, `kvGet/kvSet/kvDelete` (Task 3), crypto functions (Task 2)
- Produces: Express router with list, status, connect, callback, delete

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/accounts.test.mjs` with tests for:
- `GET /api/accounts` — lists accounts (empty for new user)
- `GET /api/accounts/google/status` — returns configured status
- `DELETE /api/accounts/:id` — deletes account

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement base adapter + account routes**

Create `cloudflare/adapters/base.js` — abstract adapter with Web Streams. Port `accountRoutes.js`. Store OAuth states in KV.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/accounts.js cloudflare/adapters/base.js cloudflare/tests/accounts.test.mjs
git commit -m "feat: account routes + base adapter on Workers"
```

---

### Task 9: Provider Adapters (Google, OneDrive, Dropbox, Yandex, S3, pCloud)

**Files:**
- Create: `cloudflare/adapters/google.js`, `onedrive.js`, `dropbox.js`, `yandex.js`, `s3.js`, `pcloud.js`
- Test: `cloudflare/tests/adapters.test.mjs`

**Interfaces:**
- Consumes: base adapter (Task 8), `kvGet/kvSet` for token caching
- Produces: adapter instances for each provider

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/adapters.test.mjs` — test each adapter's `listFiles`, `getFileDetails`, `getDownloadStream` against mocked fetch responses.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement adapters**

Port each adapter:
- **Google Drive:** Replace `googleapis` with raw REST API (`https://www.googleapis.com/drive/v3/files`)
- **OneDrive, Dropbox, Yandex, pCloud:** Minimal changes — already `fetch`-based
- **S3:** `@aws-sdk/client-s3` v3 (works in Workers)

All adapters return `ReadableStream` from `getDownloadStream()`.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/adapters/
git commit -m "feat: provider adapters on Workers (Google, OneDrive, Dropbox, Yandex, S3, pCloud)"
```

---

### Task 10: File Routes

**Files:**
- Create: `cloudflare/routes/files.js`
- Test: `cloudflare/tests/files.test.mjs`

**Interfaces:**
- Consumes: `getDb()`, adapter registry, share service
- Produces: Express router with all file endpoints

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/files.test.mjs` with tests for:
- `GET /api/files` — lists files (empty for new user)
- `GET /api/files?search=term` — search returns empty
- `GET /api/files/trash` — trash listing
- `GET /api/files/duplicates` — duplicate detection
- `POST /api/files/folders` — create folder (needs adapter mock)

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement file routes**

Port from `backend/src/routes/fileRoutes.js`. Most listing/search/star/trash operations are pure D1 queries. File operations (rename, move, copy, download) need adapter calls.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/files.js cloudflare/tests/files.test.mjs
git commit -m "feat: file routes on Workers (list, search, star, trash, move, copy)"
```

---

### Task 11: Upload Pipeline

**Files:**
- Create: `cloudflare/routes/uploads.js`
- Test: `cloudflare/tests/uploads.test.mjs`

**Interfaces:**
- Consumes: `getDb()`, `kvSet/kvGet`, adapter registry, allocation service
- Produces: Express router with initiate, stream, chunk, progress

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/uploads.test.mjs` with tests for:
- `POST /api/uploads/initiate` — creates session, returns uploadId
- `GET /api/uploads/:id/progress` — returns progress from KV
- `POST /api/uploads/:id/stream` — accepts FormData upload (mock adapter)

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement upload routes**

Replace `busboy` with `request.formData()`. Store session in KV. Support chunked uploads for >100MB.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/uploads.js cloudflare/tests/uploads.test.mjs
git commit -m "feat: upload pipeline on Workers (FormData, chunked, progress)"
```

---

### Task 12: Health + Sync Route

**Files:**
- Create: `cloudflare/routes/health.js`
- Test: `cloudflare/tests/health.test.mjs`

**Interfaces:**
- Consumes: `getDb()`, `env`
- Produces: Express router with `GET /api/health`, `POST /api/sync/run`

- [ ] **Step 1: Write the failing test**

Create `cloudflare/tests/health.test.mjs`:
- `GET /api/health` — returns status, appMode
- `POST /api/sync/run` — returns 200 (sync is a no-op placeholder in SP-2)

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement health routes**

Port from `backend/src/routes/healthRoutes.js`. `runDeltaSync` becomes a placeholder until SP-5 cron triggers.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add cloudflare/routes/health.js cloudflare/tests/health.test.mjs
git commit -m "feat: health + sync trigger routes on Workers"
```

---

### Task 13: Full App Assembly

**Files:**
- Modify: `cloudflare/appSlim.js` → rename to `cloudflare/app.js`
- Modify: `cloudflare/_worker.js`
- Test: full integration test

**Interfaces:**
- Consumes: all route modules (Tasks 5-12), middleware (Task 4)
- Produces: complete Express app mounted in worker

- [ ] **Step 1: Create the full app**

Rename `cloudflare/appSlim.js` to `cloudflare/app.js`. Mount all routers:

```js
import express from 'express';
import { attachAuthContext } from './middleware.js';
import { createAuthRouter } from './routes/auth.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createFilesRouter } from './routes/files.js';
import { createUploadsRouter } from './routes/uploads.js';
import { createSettingsRouter } from './routes/settings.js';
import { createAllocationRouter } from './routes/allocation.js';
import { createShareRouter } from './routes/share.js';
import { createHealthRouter } from './routes/health.js';

export function createApp() {
  const app = express();
  app.use(attachAuthContext);
  app.use('/api', createHealthRouter());
  app.use('/api', createAuthRouter());
  app.use('/api', createAccountsRouter());
  app.use('/api', createFilesRouter());
  app.use('/api', createUploadsRouter());
  app.use('/api', createSettingsRouter());
  app.use('/api', createAllocationRouter());
  app.use('/api', createShareRouter());
  return app;
}
```

- [ ] **Step 2: Update _worker.js**

Update `cloudflare/_worker.js` to import `createApp` (not `createSlimApp`):

```js
import { createApp } from './app.js';
// ... mount full app
```

- [ ] **Step 3: Run all tests**

Run: `node --test "cloudflare/tests/*.test.mjs"`
Run: `node --test backend/tests/*.test.mjs`
Expected: All pass.

- [ ] **Step 4: Update wrangler.jsonc**

Add KV binding and cron triggers:

```jsonc
"kv_namespaces": [
  { "binding": "STATE", "id": "..." }
],
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

- [ ] **Step 5: Verify web:build**

Run: `npm run web:build`
Expected: Vite builds, `_worker.js` copied to dist.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/app.js cloudflare/_worker.js wrangler.jsonc
git commit -m "feat: full app assembly — all routes mounted in worker"
```

---

### Task 14: Cleanup + Final Verification

**Files:**
- Remove: old test files replaced by new ones
- Modify: `docs/cloudflare.md` — update with full API reference

**Interfaces:**
- Final state: all tests green, build works, docs complete

- [ ] **Step 1: Remove old test files**

Remove `cloudflare/tests/miniflare.test.mjs` and `cloudflare/tests/splice.test.mjs` (replaced by route-specific tests). Keep `bridge.test.mjs` and `db.test.mjs`.

- [ ] **Step 2: Update docs/cloudflare.md**

Update the "File Structure" table and add full API endpoint reference.

- [ ] **Step 3: Final verification**

Run: `npm test` — 16/16 Node tests
Run: `npm run web:test` — all Workers tests
Run: `npm run web:build` — build succeeds

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: SP-2 cleanup and final verification"
```
