import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createAuthRouter } from '../routes/auth.js';
import { seedEnv } from './helpers.mjs';

function makeApp() {
  const app = express();
  app.use('/api', createAuthRouter());
  return app;
}

test('GET /api/auth/me returns local user in local mode', async () => {
  await seedEnv(async (env) => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/auth/me'), {
      user: { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, 'local-default-user');
  });
});

test('POST /api/auth/register creates user', async () => {
  await seedEnv(async (env) => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@test.com', password: 'pass12345' }),
    }), {});
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.user);
    assert.equal(body.user.email, 'new@test.com');
  });
});

test('POST /api/auth/login returns user with correct password', async () => {
  await seedEnv(async (env) => {
    const app = makeApp();
    // First register
    await runExpress(app, new Request('http://x/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@test.com', password: 'pass12345' }),
    }), {});
    // Then login
    const res = await runExpress(app, new Request('http://x/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@test.com', password: 'pass12345' }),
    }), {});
    assert.equal(res.status, 200);
  });
});

test('POST /api/auth/logout destroys session', async () => {
  await seedEnv(async (env) => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/auth/logout', {
      method: 'POST',
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 200);
  });
});
