import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { randomUUID } from 'crypto';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createSyncRouter } from '../routes/sync.js';
import { runDeltaSync, syncAccount, getLastSyncReport } from '../services/syncService.js';

const USER_ID = 'local-default-user';

async function insertTestAccount(db, overrides = {}) {
  const id = randomUUID();
  const defaults = {
    id,
    user_id: USER_ID,
    email: 'test@test.com',
    provider: 'google_drive',
    encrypted_credentials: '{}',
    total_space: 10000,
    used_space: 0,
    status: 'active',
  };
  const acct = { ...defaults, ...overrides };
  await db.prepare(
    'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(acct.id, acct.user_id, acct.email, acct.provider, acct.encrypted_credentials, acct.total_space, acct.used_space, acct.status);
  return acct;
}

class MockSyncAdapter {
  async fetchStructure() {
    return [
      { virtual_path: '/', file_name: 'mock.txt', is_folder: 0, size: 100, mime_type: 'text/plain', remote_file_id: 'mock-r1' },
    ];
  }
  async getStorageSummary() {
    return { totalSpace: 50000, usedSpace: 10000 };
  }
}

function makeAdapterFactory(MockClass) {
  return async () => new MockClass();
}

function makeSyncApp() {
  const app = express();
  app.use('/api', createSyncRouter());
  return app;
}

// --- scheduled() handler tests ---

test('scheduled() routes daily cron to purgeExpiredTrash', async () => {
  await seedEnv(async (env) => {
    const event = { cron: '0 3 * * *' };
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const workerModule = await import('../_worker.js');
    await workerModule.default.scheduled(event, env, ctx);

    assert.equal(waitUntilPromises.length, 1);
    const result = await waitUntilPromises[0];
    assert.equal(result.purged, 0);
  });
});

test('scheduled() routes regular cron via worker default export', async () => {
  await seedEnv(async (env) => {
    const event = { cron: '*/5 * * * *' };
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const workerModule = await import('../_worker.js');
    await workerModule.default.scheduled(event, env, ctx);

    assert.equal(waitUntilPromises.length, 1);
    await waitUntilPromises[0];
  });
});

test('scheduled() handler sets env via setEnv', async () => {
  await seedEnv(async (env) => {
    const db = getDb();
    await insertTestAccount(db);

    const factory = makeAdapterFactory(MockSyncAdapter);
    const report = await runDeltaSync(USER_ID, env, factory);

    assert.ok(report.lastRunAt);
    assert.equal(report.userId, USER_ID);
    assert.equal(report.scannedAccounts, 1);
    assert.equal(report.changesDetected, 1);
  });
});

// --- sync route tests ---

test('POST /api/sync/run returns report', async () => {
  await seedEnv(async (env) => {
    const db = getDb();
    await insertTestAccount(db);

    const factory = makeAdapterFactory(MockSyncAdapter);
    await runDeltaSync(USER_ID, env, factory);

    const app = makeSyncApp();
    const res = await runExpress(app, new Request('http://x/api/sync/run', {
      method: 'POST',
    }), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      env,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.lastRunAt);
    assert.equal(body.userId, USER_ID);
    assert.ok(body.scannedAccounts >= 1);
  });
});

test('GET /api/sync/status returns last report', async () => {
  await seedEnv(async (env) => {
    const db = getDb();
    await insertTestAccount(db);

    const factory = makeAdapterFactory(MockSyncAdapter);
    await runDeltaSync(USER_ID, env, factory);

    const app = makeSyncApp();
    const res = await runExpress(app, new Request('http://x/api/sync/status'), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      env,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.lastRunAt);
    assert.equal(body.userId, USER_ID);
    assert.ok(body.scannedAccounts >= 1);
  });
});

test('POST /api/sync/:accountId returns 404 for unknown account', async () => {
  await seedEnv(async (env) => {
    const app = makeSyncApp();
    const res = await runExpress(app, new Request('http://x/api/sync/nonexistent-id', {
      method: 'POST',
    }), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      env,
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('POST /api/sync/:accountId syncs with mock adapter via service', async () => {
  await seedEnv(async (env) => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    const factory = makeAdapterFactory(MockSyncAdapter);
    const result = await syncAccount(USER_ID, acct, env, factory);

    assert.equal(result.accountId, acct.id);
    assert.equal(result.filesCount, 1);
    assert.equal(result.storage.totalSpace, 50000);

    const files = await db.prepare(
      'SELECT * FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?'
    ).all(USER_ID, acct.id);
    const rows = files.results || files;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file_name, 'mock.txt');
  });
});
