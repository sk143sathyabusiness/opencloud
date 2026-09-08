import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createUploadsRouter } from '../routes/uploads.js';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';

function makeApp() {
  const app = express();
  app.use('/api', createUploadsRouter());
  return app;
}

const AUTH_USER = { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true };

// --- POST /api/upload/init ---

test('POST /api/upload/init returns 400 without file_name', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 1024 }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('file_name'));
  });
});

test('POST /api/upload/init returns 507 without cloud accounts', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'test.txt', size: 1024 }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 507);
    const body = await res.json();
    assert.ok(body.error.includes('cloud accounts'));
  });
});

test('POST /api/upload/init creates session with cloud account', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: 'photo.jpg',
        size: 2048,
        mime_type: 'image/jpeg',
        virtual_path: '/photos/',
      }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.data.upload_id);
    assert.ok(body.data.session_token);
    assert.equal(body.data.target_account.id, 'ca-1');
    assert.equal(body.data.target_account.provider, 'google_drive');

    // Verify session in D1
    const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(body.data.upload_id);
    assert.equal(session.file_name, 'photo.jpg');
    assert.equal(session.file_size, 2048);
    assert.equal(session.mime_type, 'image/jpeg');
    assert.equal(session.virtual_path, '/photos/');
    assert.equal(session.status, 'initialized');
  });
});

// --- POST /api/upload/complete ---

test('POST /api/upload/complete returns 400 without upload_id', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

test('POST /api/upload/complete returns 404 for nonexistent session', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: 'nonexistent' }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('POST /api/upload/complete returns 400 with no chunks', async () => {
  await seedEnv(async () => {
    const db = getDb();
    // Create session directly
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-session-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'test.txt', 10, 'text/plain', '/', 'ca-1', 'uploading', 'tok', 0);

    const app = makeApp();
    const req = new Request('http://x/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: sessionId }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('No chunks'));
  });
});

test('POST /api/upload/complete assembles chunks and marks completed', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const encoder = new TextEncoder();
    const chunk1 = encoder.encode('hello');
    const chunk2 = encoder.encode(' world');
    const totalSize = chunk1.byteLength + chunk2.byteLength;

    const sessionId = 'test-session-2';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'test.txt', totalSize, 'text/plain', '/', 'ca-1', 'uploading', 'tok', totalSize);

    await db.prepare(
      'INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?, ?)'
    ).run('c1', sessionId, 0, chunk1, chunk1.byteLength);
    await db.prepare(
      'INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?, ?)'
    ).run('c2', sessionId, 1, chunk2, chunk2.byteLength);

    const app = makeApp();
    const req = new Request('http://x/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: sessionId }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'completed');
    assert.equal(body.data.bytes_assembled, 11);
    assert.equal(body.data.chunk_count, 2);

    // Verify session is completed
    const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(sessionId);
    assert.equal(session.status, 'completed');

    // Verify chunks are cleaned up
    const { results: chunks } = await db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ?').all(sessionId);
    assert.equal(chunks.length, 0);
  });
});

// --- DELETE /api/upload/:uploadId ---

test('DELETE /api/upload/:uploadId returns 404 for nonexistent session', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/nonexistent', { method: 'DELETE' });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('DELETE /api/upload/:uploadId cancels upload and cleans up chunks', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-cancel-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'cancel.txt', 100, 'text/plain', '/', 'ca-1', 'uploading', 'tok', 50);

    const encoder = new TextEncoder();
    const chunkData = encoder.encode('partial');
    await db.prepare(
      'INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?, ?)'
    ).run('c-cancel', sessionId, 0, chunkData, chunkData.byteLength);

    const app = makeApp();
    const req = new Request(`http://x/api/upload/${sessionId}`, { method: 'DELETE' });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.success, true);

    // Verify status changed to cancelled
    const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(sessionId);
    assert.equal(session.status, 'cancelled');

    // Verify chunks cleaned up
    const { results: chunks } = await db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ?').all(sessionId);
    assert.equal(chunks.length, 0);
  });
});

// --- GET /api/upload/:uploadId/progress ---

test('GET /api/upload/:uploadId/progress returns SSE headers', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-sse-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'sse.txt', 1000, 'text/plain', '/', 'ca-1', 'completed', 'tok', 1000);

    const app = makeApp();
    const req = new Request(`http://x/api/upload/${sessionId}/progress`);
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/event-stream');
    assert.equal(res.headers.get('Cache-Control'), 'no-cache');
    assert.equal(res.headers.get('Connection'), 'keep-alive');

    // Should close immediately since status is completed
    const text = await res.text();
    assert.ok(text.includes('"status":"completed"'));
    assert.ok(text.includes('"percent":100'));
  });
});

test('GET /api/upload/:uploadId/progress returns 404 for nonexistent session', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const req = new Request('http://x/api/upload/nonexistent/progress');
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

// --- POST /api/upload/assemble ---

test('POST /api/upload/assemble assembles chunks into final file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const encoder = new TextEncoder();
    const chunk1 = encoder.encode('AAAAAAAAAAAA');
    const chunk2 = encoder.encode('BBBBBBBBBBBB');
    const totalSize = chunk1.byteLength + chunk2.byteLength;

    const sessionId = 'test-assemble-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'big.bin', totalSize, 'application/octet-stream', '/', 'ca-1', 'uploading', 'tok', totalSize);

    await db.prepare(
      'INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?, ?)'
    ).run('c-a1', sessionId, 0, chunk1, chunk1.byteLength);
    await db.prepare(
      'INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?, ?)'
    ).run('c-a2', sessionId, 1, chunk2, chunk2.byteLength);

    const app = makeApp();
    const req = new Request('http://x/api/upload/assemble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: sessionId }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'completed');
    assert.equal(body.data.bytes_assembled, 24);
    assert.equal(body.data.chunk_count, 2);

    // Verify session is completed
    const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(sessionId);
    assert.equal(session.status, 'completed');

    // Verify chunks cleaned up
    const { results: chunks } = await db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ?').all(sessionId);
    assert.equal(chunks.length, 0);
  });
});

// --- POST /api/upload/chunk ---

test('POST /api/upload/chunk returns 400 without file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const formData = new FormData();
    formData.set('upload_id', 'nonexistent');
    formData.set('chunk_index', '0');
    const req = new Request('http://x/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

test('POST /api/upload/chunk stores chunk and updates bytes', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-chunk-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'upload.bin', 100, 'application/octet-stream', '/', 'ca-1', 'uploading', 'tok', 0);

    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'chunk.bin', { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.set('upload_id', sessionId);
    formData.set('chunk_index', '0');
    formData.set('file', file);

    const req = new Request('http://x/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });
    const app = makeApp();
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.chunk_id);
    assert.equal(body.data.chunk_index, 0);
    assert.equal(body.data.bytes_received, 5);
    assert.equal(body.data.total_bytes_received, 5);

    // Verify chunk in D1
    const { results: chunks } = await db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ?').all(sessionId);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].chunk_index, 0);
    assert.equal(chunks[0].chunk_size, 5);

    // Verify session bytes updated
    const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(sessionId);
    assert.equal(session.bytes_uploaded, 5);
  });
});

// --- Size cap enforcement ---

test('POST /api/upload/init returns 413 when file size exceeds UPLOAD_MAX_BYTES', async () => {
  const maxBytes = 1000;
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'huge.bin', size: maxBytes + 1 }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.error.includes('exceeds limit'));
    assert.equal(body.data.maxBytes, maxBytes);
    assert.equal(body.data.requestedBytes, maxBytes + 1);
  }, { UPLOAD_MAX_BYTES: String(maxBytes) });
});

test('POST /api/upload/init accepts file size at UPLOAD_MAX_BYTES', async () => {
  const maxBytes = 1000;
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'exact.bin', size: maxBytes }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 201);
  }, { UPLOAD_MAX_BYTES: String(maxBytes) });
});

test('POST /api/upload/init uses default limit when env var not set', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const app = makeApp();
    const req = new Request('http://x/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'default.bin', size: 104857601 }),
    });
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.data.maxBytes, 104857600);
  });
});

test('POST /api/upload/chunk returns 413 when chunk exceeds MAX_CHUNK_BYTES', async () => {
  const maxChunk = 100;
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-chunk-cap-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'upload.bin', 1000, 'application/octet-stream', '/', 'ca-1', 'uploading', 'tok', 0);

    // Create a chunk that exceeds the limit
    const oversized = new Uint8Array(maxChunk + 1);
    oversized.fill(0x42);
    const file = new File([oversized], 'chunk.bin', { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.set('upload_id', sessionId);
    formData.set('chunk_index', '0');
    formData.set('file', file);

    const req = new Request('http://x/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });
    const app = makeApp();
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.error.includes('exceeds limit'));
    assert.equal(body.data.maxBytes, maxChunk);
    assert.equal(body.data.requestedBytes, maxChunk + 1);
  }, { MAX_CHUNK_BYTES: String(maxChunk) });
});

test('POST /api/upload/chunk accepts chunk at MAX_CHUNK_BYTES', async () => {
  const maxChunk = 100;
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-chunk-exact-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'upload.bin', 1000, 'application/octet-stream', '/', 'ca-1', 'uploading', 'tok', 0);

    const exactChunk = new Uint8Array(maxChunk);
    exactChunk.fill(0x42);
    const file = new File([exactChunk], 'chunk.bin', { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.set('upload_id', sessionId);
    formData.set('chunk_index', '0');
    formData.set('file', file);

    const req = new Request('http://x/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });
    const app = makeApp();
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 200);
  }, { MAX_CHUNK_BYTES: String(maxChunk) });
});

test('POST /api/upload/chunk uses default limit when env var not set', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await db.prepare(
      'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ca-1', AUTH_USER.id, 'test@google.com', 'google_drive', '{}', 1000000, 0, 'active');

    const sessionId = 'test-chunk-default-1';
    await db.prepare(`
      INSERT INTO upload_sessions (
        id, user_id, file_name, file_size, mime_type, virtual_path,
        cloud_account_id, status, session_token, bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, AUTH_USER.id, 'upload.bin', 100000000, 'application/octet-stream', '/', 'ca-1', 'uploading', 'tok', 0);

    // 26214401 bytes = default MAX_CHUNK_BYTES + 1
    const oversized = new Uint8Array(26214401);
    oversized.fill(0x42);
    const file = new File([oversized], 'chunk.bin', { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.set('upload_id', sessionId);
    formData.set('chunk_index', '0');
    formData.set('file', file);

    const req = new Request('http://x/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });
    const app = makeApp();
    const res = await runExpress(app, req, { user: AUTH_USER });
    assert.equal(res.status, 413);
  });
});
