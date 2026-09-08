import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createShareRouter, _setAdapterOverrides, _clearAdapterOverrides } from '../routes/share.js';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { hashPassword, hashToken } from '../../backend/src/config/crypto.js';

class MockAdapter {
  constructor(account) {
    this.account = account;
  }

  async getDownloadStream(fileRecord) {
    const encoder = new TextEncoder();
    const data = encoder.encode(`content-of-${fileRecord.file_name}`);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
}

function makeShareApp() {
  const app = express();
  app.use('/api', createShareRouter());
  return app;
}

async function insertTestAccount(db, userId, provider = 'google_drive') {
  const id = `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db.prepare(`
    INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
    VALUES (?, ?, ?, ?, '', 1073741824, 0, 'active')
  `).run(id, userId, `${provider}@test.com`, provider);
  return id;
}

async function createShareLinkAndGetToken(app, userId, overrides = {}) {
  const body = { ...SHARE_BODY, ...overrides };
  const res = await runExpress(app, new Request('http://x/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { user: { id: userId } });
  const { data } = await res.json();
  return data.token;
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

test('GET /api/share/:token/download succeeds with mock adapter (no password)', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        accountId,
        fileId: `file-${Date.now()}`,
      });

      const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('application/pdf'));
      assert.ok(res.headers.get('content-disposition')?.includes('attachment'));
      assert.ok(res.headers.get('content-disposition')?.includes('test.pdf'));
      const text = await res.text();
      assert.equal(text, 'content-of-test.pdf');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/download returns 401 with wrong password', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        accountId,
        fileId: `file-${Date.now()}`,
        password: 'correct-password',
      });

      const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`, {
        headers: { 'x-link-password': 'wrong-password' },
      }), {});
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'Wrong or missing link password');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/download returns 401 without password when required', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        accountId,
        fileId: `file-${Date.now()}`,
        password: 'secret123',
      });

      const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});
      assert.equal(res.status, 401);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/download succeeds with correct password', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        accountId,
        fileId: `file-${Date.now()}`,
        password: 'correct-password',
      });

      const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`, {
        headers: { 'x-link-password': 'correct-password' },
      }), {});
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(text, 'content-of-test.pdf');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/download returns 404 for expired link', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        fileId: `file-${Date.now()}`,
        expiresInDays: 1,
      });

      // Manually expire the link
      const tokenHash = await hashToken(token);
      await db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?')
        .run(new Date(Date.now() - 86400000).toISOString(), tokenHash);

      const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});
      assert.equal(res.status, 404);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/download returns 404 for nonexistent token', async () => {
  await seedEnv(async () => {
    const app = makeShareApp();
    const res = await runExpress(app, new Request('http://x/api/share/nonexistent/download'), {});
    assert.equal(res.status, 404);
  });
});

test('GET /api/share/:token/download increments download_count', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const token = await createShareLinkAndGetToken(app, 'local-default-user', {
        accountId,
        fileId: `file-${Date.now()}`,
      });

      // Download twice
      await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});
      await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});

      const tokenHash = await hashToken(token);
      const link = await db.prepare('SELECT download_count, last_used_at FROM share_links WHERE token = ?')
        .get(tokenHash);
      assert.equal(link.download_count, 2);
      assert.ok(link.last_used_at);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/share/:token/info returns public info without password_hash', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user');
    const app = makeShareApp();

    const token = await createShareLinkAndGetToken(app, 'local-default-user', {
      accountId,
      fileId: `file-${Date.now()}`,
      password: 'secret',
    });

    const res = await runExpress(app, new Request(`http://x/api/share/${token}/info`), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.file_name, 'test.pdf');
    assert.equal(body.data.size, 1024);
    assert.equal(body.data.mime_type, 'application/pdf');
    assert.equal(body.data.has_password, true);
    assert.equal(body.data.download_count, 0);
    assert.equal(Object.keys(body.data).includes('password_hash'), false);
  });
});

test('GET /api/share/:token/info returns 404 for expired link', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const app = makeShareApp();

    const token = await createShareLinkAndGetToken(app, 'local-default-user', {
      fileId: `file-${Date.now()}`,
      expiresInDays: 1,
    });

    // Manually expire the link
    const tokenHash = await hashToken(token);
    await db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 86400000).toISOString(), tokenHash);

    const res = await runExpress(app, new Request(`http://x/api/share/${token}/info`), {});
    assert.equal(res.status, 404);
  });
});

test('GET /api/share/:token/download returns 502 when adapter is unavailable', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, 'local-default-user', 'unsupported_provider');
    const app = makeShareApp();

    const token = await createShareLinkAndGetToken(app, 'local-default-user', {
      accountId,
      fileId: `file-${Date.now()}`,
    });

    const res = await runExpress(app, new Request(`http://x/api/share/${token}/download`), {});
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error);
  });
});
