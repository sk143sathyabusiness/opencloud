import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createShareRouter } from '../routes/share.js';
import { seedEnv } from './helpers.mjs';

function makeShareApp() {
  const app = express();
  app.use('/api', createShareRouter());
  return app;
}

const SHARE_BODY = {
  fileId: 'file-001',
  accountId: 'acc-001',
  remoteFileId: 'remote-001',
  fileName: 'test.pdf',
  size: 1024,
  mimeType: 'application/pdf',
  isFolder: false,
};

test('POST /api/share creates a share link', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.data);
    assert.ok(body.data.token);
    assert.ok(body.data.url);
  });
});

test('POST /api/share returns 400 without fileId', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: { id: 'local-default-user' } });
    assert.equal(res.status, 400);
  });
});

test('POST /api/share returns 401 without auth', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), {});
    assert.equal(res.status, 401);
  });
});

test('GET /api/share lists user share links', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    // Create a link first
    await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), { user: { id: 'local-default-user' } });

    const res = await runExpress(app, new Request('http://x/api/share'), {
      user: { id: 'local-default-user' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 1);
    assert.equal(body.data[0].file_name, 'test.pdf');
  });
});

test('DELETE /api/share/:token revokes a link', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    // Create a link
    const createRes = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), { user: { id: 'local-default-user' } });
    const { data } = await createRes.json();

    // Revoke it
    const delRes = await runExpress(app, new Request(`http://x/api/share/${data.token}`, {
      method: 'DELETE',
    }), { user: { id: 'local-default-user' } });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.data.revoked, 1);
  });
});

test('DELETE /api/share/:token returns 401 without auth', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share/fake-token', {
      method: 'DELETE',
    }), {});
    assert.equal(res.status, 401);
  });
});

test('GET /api/share/:token/info returns public info', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    // Create a link
    const createRes = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), { user: { id: 'local-default-user' } });
    const { data } = await createRes.json();

    const res = await runExpress(app, new Request(`http://x/api/share/${data.token}/info`), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.file_name, 'test.pdf');
    assert.equal(body.data.size, 1024);
    assert.equal(body.data.mime_type, 'application/pdf');
    assert.equal(body.data.download_count, 0);
  });
});

test('GET /api/share/:token/info returns 404 for missing token', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share/nonexistent/info'), {});
    assert.equal(res.status, 404);
  });
});

test('GET /api/share/:token/download returns 501 (adapter not implemented)', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    // Create a link
    const createRes = await runExpress(app, new Request('http://x/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SHARE_BODY),
    }), { user: { id: 'local-default-user' } });
    const { data } = await createRes.json();

    const res = await runExpress(app, new Request(`http://x/api/share/${data.token}/download`), {});
    assert.equal(res.status, 501);
  });
});
