import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createHealthRouter } from '../routes/health.js';
import { seedEnv } from './helpers.mjs';

function makeApp() {
  const app = express();
  app.use('/api', createHealthRouter());
  return app;
}

test('GET /api/health returns status ok', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/health'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, true);
    assert.ok(body.timestamp);
  });
});

test('GET /api/health/detailed returns table counts', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/health/detailed'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, true);
    assert.ok(body.tableCounts);
    assert.ok('users' in body.tableCounts);
    assert.ok('file_metadata' in body.tableCounts);
    assert.ok('cloud_accounts' in body.tableCounts);
  });
});

test('POST /api/sync/:accountId returns 404 for unknown account', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/sync/nonexistent-id', {
      method: 'POST',
    }), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('POST /api/sync/:accountId returns pending for valid account', async () => {
  await seedEnv(async (env) => {
    const db = env.DB;
    await db.exec("INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES ('acc1', 'local-default-user', 'test@test.com', 'google_drive', 'enc', 1000, 500, 'active')");

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/sync/acc1', {
      method: 'POST',
    }), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'pending');
    assert.equal(body.accountId, 'acc1');
    assert.equal(body.provider, 'google_drive');
  });
});

test('GET /api/sync/:accountId/status returns sync status', async () => {
  await seedEnv(async (env) => {
    const db = env.DB;
    await db.exec("INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES ('acc2', 'local-default-user', 'test2@test.com', 'onedrive', 'enc', 2000, 1000, 'active')");

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/sync/acc2/status'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accountId, 'acc2');
    assert.equal(body.provider, 'onedrive');
    assert.equal(body.status, 'active');
    assert.ok(body.lastSyncAt);
  });
});

test('GET /api/sync/:accountId/status returns 404 for unknown account', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/sync/fake-id/status'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 404);
  });
});
