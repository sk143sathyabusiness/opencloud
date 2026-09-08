import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createSettingsRouter } from '../routes/settings.js';
import { createAllocationRouter } from '../routes/allocation.js';
import { seedEnv } from './helpers.mjs';

function makeSettingsApp() {
  const app = express();
  app.use('/api', createSettingsRouter());
  return app;
}

function makeAllocationApp() {
  const app = express();
  app.use('/api', createAllocationRouter());
  return app;
}

test('GET /api/settings returns defaults', async () => {
  await seedEnv(async () => {
    const app = makeSettingsApp();
    const res = await runExpress(app, new Request('http://x/api/settings'), {
      user: { id: 'local-default-user' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.settings);
  });
});

test('PATCH /api/settings updates a setting', async () => {
  await seedEnv(async () => {
    const app = makeSettingsApp();
    const res = await runExpress(app, new Request('http://x/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: 'dark' }),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});

test('GET /api/allocation returns config', async () => {
  await seedEnv(async () => {
    const app = makeAllocationApp();
    const res = await runExpress(app, new Request('http://x/api/allocation'), {
      user: { id: 'local-default-user' },
    });
    assert.equal(res.status, 200);
  });
});

test('PATCH /api/allocation updates config', async () => {
  await seedEnv(async () => {
    const app = makeAllocationApp();
    const res = await runExpress(app, new Request('http://x/api/allocation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'least_used' }),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});
