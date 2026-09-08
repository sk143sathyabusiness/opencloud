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
