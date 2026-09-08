import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { randomUUID } from 'crypto';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { getTelegramStatus, backupFileToTelegram, backupMetadataToTelegram, sendDocument, TELEGRAM_NOT_CONFIGURED } from '../services/telegramService.js';
import { createTelegramRouter } from '../routes/telegram.js';

const USER_ID = 'local-default-user';
const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_CHAT_ID: '123456789' };

function makeTelegramApp(adapterFactory) {
  const app = express();
  app.use('/api', createTelegramRouter(adapterFactory));
  return app;
}

// --- getTelegramStatus tests ---

test('getTelegramStatus returns not configured when no token', async () => {
  const status = await getTelegramStatus({});
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.bot, null);
  assert.equal(status.chat, null);
  assert.equal(status.error, TELEGRAM_NOT_CONFIGURED);
});

test('getTelegramStatus returns connected status on success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { username: 'TestBot', id: 999 } }), { status: 200 });
    }
    if (u.includes('getChat')) {
      return new Response(JSON.stringify({ ok: true, result: { id: 123456789, title: 'Test Chat', type: 'group' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, description: 'Not found' }), { status: 404 });
  };

  try {
    const status = await getTelegramStatus(TELEGRAM_ENV);
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.equal(status.bot, 'TestBot');
    assert.equal(status.chat.title, 'Test Chat');
    assert.equal(status.chat.type, 'group');
    assert.equal(status.error, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getTelegramStatus returns error on API failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
  };

  try {
    const status = await getTelegramStatus(TELEGRAM_ENV);
    assert.equal(status.configured, true);
    assert.equal(status.connected, false);
    assert.equal(status.bot, null);
    assert.equal(status.chat, null);
    assert.equal(status.error, 'Unauthorized');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- sendDocument tests ---

test('sendDocument sends correct multipart form', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    assert.ok(u.includes('sendDocument'));
    assert.equal(opts.method, 'POST');
    const body = opts.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get('chat_id'), '123456789');
    assert.equal(body.get('disable_notification'), 'true');
    assert.equal(body.get('caption'), 'test caption');
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  };

  try {
    const buffer = new Uint8Array([72, 101, 108, 108, 111]);
    const result = await sendDocument({ fileName: 'test.txt', buffer, mimeType: 'text/plain', caption: 'test caption' }, TELEGRAM_ENV);
    assert.equal(result.message_id, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendDocument throws on oversized file', async () => {
  const largeBuffer = new Uint8Array(50 * 1024 * 1024 + 1);
  await assert.rejects(
    () => sendDocument({ fileName: 'large.bin', buffer: largeBuffer }, TELEGRAM_ENV),
    /exceeds the Telegram 50 MB upload limit/,
  );
});

test('sendDocument throws when not configured', async () => {
  const buffer = new Uint8Array([1]);
  await assert.rejects(
    () => sendDocument({ fileName: 'test.txt', buffer }, {}),
    /not configured/,
  );
});

// --- backupFileToTelegram tests ---

test('backupFileToTelegram throws for folders', async () => {
  await assert.rejects(
    () => backupFileToTelegram({ is_folder: true, file_name: 'folder' }, {}, TELEGRAM_ENV),
    /Folders cannot be backed up/,
  );
});

test('backupFileToTelegram throws for oversized files', async () => {
  const largeFile = { is_folder: false, size: 50 * 1024 * 1024 + 1, file_name: 'huge.bin' };
  await assert.rejects(
    () => backupFileToTelegram(largeFile, {}, TELEGRAM_ENV),
    /exceeds the Telegram 50 MB upload limit/,
  );
});

test('backupFileToTelegram downloads and sends file via adapter', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('sendDocument')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };

  const mockAdapter = {
    async getDownloadStream() {
      return [new Uint8Array([1, 2, 3])];
    },
  };

  const file = { is_folder: false, size: 3, file_name: 'backup.pdf', mime_type: 'application/pdf' };

  try {
    const result = await backupFileToTelegram(file, mockAdapter, TELEGRAM_ENV);
    assert.equal(result.sent, true);
    assert.equal(result.fileName, 'backup.pdf');
    assert.equal(result.size, 3);
    assert.equal(result.messageId, 77);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- backupMetadataToTelegram tests ---

test('backupMetadataToTelegram exports file metadata as JSON', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBuffer = null;

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('sendDocument')) {
      capturedBuffer = opts.body.get('document');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };

  try {
    await seedEnv(async () => {
      const db = getDb();
      const acctId = randomUUID();
      await db.prepare(
        'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(acctId, USER_ID, 'test@test.com', 'google_drive', '{}', 10000, 0, 'active');

      await db.prepare(
        `INSERT INTO file_metadata (id, user_id, cloud_account_id, virtual_path, file_name, is_folder, is_starred, size, mime_type, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), USER_ID, acctId, '/', 'doc.pdf', 0, 0, 1024, 'application/pdf', 'remote-1', null, null, null);

      const result = await backupMetadataToTelegram(USER_ID, TELEGRAM_ENV);
      assert.equal(result.sent, true);
      assert.ok(result.fileName.startsWith('opencloud-metadata-backup-'));
      assert.ok(result.fileName.endsWith('.json'));
      assert.equal(result.fileCount, 1);
      assert.equal(result.messageId, 88);
      assert.ok(result.size > 0);
      assert.ok(capturedBuffer);

      const text = await capturedBuffer.text();
      const snapshot = JSON.parse(text);
      assert.equal(snapshot.app, 'OpenCloud');
      assert.equal(snapshot.type, 'metadata-backup');
      assert.equal(snapshot.file_count, 1);
      assert.equal(snapshot.files[0].file_name, 'doc.pdf');
    }, TELEGRAM_ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Route tests ---

test('GET /api/telegram/status returns not configured when no env', async () => {
  await seedEnv(async () => {
    const app = makeTelegramApp();
    const res = await runExpress(app, new Request('http://x/api/telegram/status'), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, false);
    assert.equal(body.connected, false);
  });
});

test('GET /api/telegram/status returns connected when env set', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { username: 'TestBot', id: 999 } }), { status: 200 });
    }
    if (u.includes('getChat')) {
      return new Response(JSON.stringify({ ok: true, result: { id: 123456789, title: 'Test Chat', type: 'group' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };

  try {
    await seedEnv(async () => {
      const app = makeTelegramApp();
      const res = await runExpress(app, new Request('http://x/api/telegram/status'), {
        user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.configured, true);
      assert.equal(body.connected, true);
      assert.equal(body.bot, 'TestBot');
    }, TELEGRAM_ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/telegram/backup-file returns 404 for missing file', async () => {
  await seedEnv(async () => {
    const app = makeTelegramApp();
    const res = await runExpress(app, new Request('http://x/api/telegram/backup-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'nonexistent' }),
    }), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'File not found');
  }, TELEGRAM_ENV);
});

test('POST /api/telegram/backup-file sends file via adapter', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('sendDocument')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };

  try {
    await seedEnv(async () => {
      const db = getDb();
      const acctId = randomUUID();
      await db.prepare(
        'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(acctId, USER_ID, 'test@test.com', 'google_drive', '{}', 10000, 0, 'active');

      const fileId = randomUUID();
      await db.prepare(
        `INSERT INTO file_metadata (id, user_id, cloud_account_id, virtual_path, file_name, is_folder, is_starred, size, mime_type, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(fileId, USER_ID, acctId, '/', 'test.pdf', 0, 0, 1024, 'application/pdf', 'remote-1', null, null, null);

      const mockAdapter = {
        async getDownloadStream() {
          return [new Uint8Array([1, 2, 3])];
        },
      };
      const mockAdapterFactory = async () => mockAdapter;

      const app = makeTelegramApp(mockAdapterFactory);
      const res = await runExpress(app, new Request('http://x/api/telegram/backup-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      }), {
        user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.sent, true);
      assert.equal(body.fileName, 'test.pdf');
      assert.equal(body.messageId, 55);
    }, TELEGRAM_ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/telegram/backup-metadata exports metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('sendDocument')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 66 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };

  try {
    await seedEnv(async () => {
      const app = makeTelegramApp();
      const res = await runExpress(app, new Request('http://x/api/telegram/backup-metadata', {
        method: 'POST',
      }), {
        user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.sent, true);
      assert.ok(body.fileName.startsWith('opencloud-metadata-backup-'));
      assert.equal(body.fileCount, 0);
      assert.equal(body.messageId, 66);
    }, TELEGRAM_ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/telegram/backup-metadata returns 500 when env missing', async () => {
  await seedEnv(async () => {
    const app = makeTelegramApp();
    const res = await runExpress(app, new Request('http://x/api/telegram/backup-metadata', {
      method: 'POST',
    }), {
      user: { id: USER_ID, email: 'local@omnicloud.local', is_local: true },
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error);
  });
});
