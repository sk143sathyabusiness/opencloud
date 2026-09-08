import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createAccountsRouter } from '../routes/accounts.js';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { randomUUID } from 'crypto';

function makeApp() {
  const app = express();
  app.use('/api', createAccountsRouter());
  return app;
}

const AUTH_USER = { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true };

test('GET /api/accounts returns empty list for new user', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 0);
  });
});

test('GET /api/accounts/google/status returns configured status', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/google/status'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('configured' in body.data);
  });
});

test('GET /api/accounts/onedrive/status returns configured status', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/onedrive/status'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('configured' in body.data);
  });
});

test('GET /api/accounts/dropbox/status returns configured status', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/dropbox/status'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('configured' in body.data);
  });
});

test('GET /api/accounts/yandex/status returns configured status', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/yandex/status'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('configured' in body.data);
  });
});

test('GET /api/accounts/mega/status returns 410', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/mega/status'), { user: AUTH_USER });
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.error, 'MEGA support removed');
  });
});

test('POST /api/accounts/mega/connect returns 410', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/mega/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@mega.nz', password: 'pass' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.error, 'MEGA support removed');
  });
});

test('DELETE /api/accounts/:id returns 404 for nonexistent account', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/nonexistent-id', {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('DELETE /api/accounts/:id deletes existing account', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const userId = AUTH_USER.id;
    const accountId = randomUUID();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(accountId, userId, 'test@test.com', 'google_drive', '{}', 1000, 0, 'active');

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/accounts/${accountId}`, {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.success, true);

    const remaining = await db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(accountId);
    assert.equal(remaining, undefined);
  });
});

test('DELETE /api/accounts/:id does not delete other user\'s account', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, is_local) VALUES (?, ?, ?, ?)').run('other-user', 'other@test.com', '', 0);
    const accountId = randomUUID();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(accountId, 'other-user', 'other@test.com', 's3', '{}', 5000, 0, 'active');

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/accounts/${accountId}`, {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);

    const remaining = await db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(accountId);
    assert.ok(remaining);
  });
});

test('POST /api/accounts/s3/connect requires credentials', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/s3/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('accessKeyId'));
  });
});

test('POST /api/accounts/pcloud/connect requires credentials', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts/pcloud/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('username'));
  });
});

test('GET /api/accounts returns accounts with free_space computed', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const userId = AUTH_USER.id;
    const accountId = randomUUID();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(accountId, userId, 'g@test.com', 'google_drive', '{}', 10000, 3000, 'active');

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].free_space, 7000);
  });
});

test('GET /api/accounts returns 401 without user', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/accounts'), {});
    assert.equal(res.status, 401);
  });
});
