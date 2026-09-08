import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { runExpress } from '../expressBridge.js';
import { createFilesRouter, _setAdapterOverrides, _clearAdapterOverrides } from '../routes/files.js';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { randomUUID } from 'crypto';

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
      }
    });
  }

  async createFolder({ name }) {
    return {
      remoteFileId: `mock-folder-${Date.now()}`,
      remoteParentId: null,
      fileName: name,
    };
  }

  async moveFile() {
    return true;
  }

  async copyFile() {
    return { remoteFileId: `mock-copy-${Date.now()}` };
  }
}

function makeApp() {
  const app = express();
  app.use('/api', createFilesRouter());
  return app;
}

const AUTH_USER = { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true };

async function insertTestAccount(db, userId) {
  const accountId = randomUUID();
  await db.prepare(
    'INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(accountId, userId, 'test@test.com', 'google_drive', '{}', 10000, 0, 'active');
  return accountId;
}

async function insertTestFile(db, userId, accountId, overrides = {}) {
  const id = randomUUID();
  const defaults = {
    id,
    user_id: userId,
    virtual_path: '/',
    file_name: 'test.txt',
    is_folder: 0,
    is_starred: 0,
    size: 1024,
    mime_type: 'text/plain',
    cloud_account_id: accountId,
    remote_file_id: `remote-${id}`,
    remote_parent_id: null,
    remote_created_time: null,
    remote_modified_time: null,
  };
  const file = { ...defaults, ...overrides };
  await db.prepare(`
    INSERT INTO file_metadata (
      id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
      cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file.id, file.user_id, file.virtual_path, file.file_name, file.is_folder,
    file.is_starred, file.size, file.mime_type, file.cloud_account_id,
    file.remote_file_id, file.remote_parent_id, file.remote_created_time, file.remote_modified_time
  );
  return id;
}

// --- GET /api/files ---

test('GET /api/files returns empty list for new user', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 0);
  });
});

test('GET /api/files lists files by path', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'doc.pdf', size: 2048 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'image.png', mime_type: 'image/png' });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?path=/'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.ok(body.data[0].file_name);
  });
});

test('GET /api/files returns 401 without user', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files'), {});
    assert.equal(res.status, 401);
  });
});

// --- GET /api/files?search ---

test('GET /api/files?search=term returns matching files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'report.pdf', size: 4096 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'photo.jpg', mime_type: 'image/jpeg' });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?search=report'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].file_name, 'report.pdf');
  });
});

test('GET /api/files?search= with no matches returns empty', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'doc.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?search=zzznoexist'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 0);
  });
});

// --- GET /api/files?starred ---

test('GET /api/files?starred=1 returns only starred files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'starred.txt', is_starred: 1 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'normal.txt', is_starred: 0 });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?starred=1'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].file_name, 'starred.txt');
  });
});

// --- GET /api/files?recent ---

test('GET /api/files?recent=1 returns only non-folder files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'file.txt', is_folder: 0 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'folder', is_folder: 1 });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?recent=1'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].file_name, 'file.txt');
  });
});

// --- GET /api/files/trash ---

test('GET /api/files/trash returns empty for new user', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 0);
  });
});

test('GET /api/files/trash lists trashed files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const trashId = randomUUID();
    await db.prepare(`
      INSERT INTO trash (
        id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
        virtual_path, file_name, is_folder, size, mime_type,
        remote_created_time, remote_modified_time, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trashId, AUTH_USER.id, accountId, 'remote-1', null, '/', 'deleted.txt', 0, 512, 'text/plain', null, null, new Date().toISOString());

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].file_name, 'deleted.txt');
  });
});

// --- GET /api/files/duplicates ---

test('GET /api/files/duplicates returns groups of files with same name and size', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'photo.jpg', size: 1024 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'photo.jpg', size: 1024 });
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'unique.txt', size: 2048 });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/duplicates'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].file_name, 'photo.jpg');
    assert.equal(body.data[0].count, 2);
    assert.equal(body.data[0].items.length, 2);
  });
});

test('GET /api/files/duplicates returns empty when no duplicates', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'solo.txt', size: 100 });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/duplicates'), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 0);
  });
});

// --- POST /api/files/trash/restore ---

test('POST /api/files/trash/restore restores files from trash', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const trashId = randomUUID();
    await db.prepare(`
      INSERT INTO trash (
        id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
        virtual_path, file_name, is_folder, size, mime_type,
        remote_created_time, remote_modified_time, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trashId, AUTH_USER.id, accountId, 'remote-r1', null, '/', 'restore-me.txt', 0, 100, 'text/plain', null, null, new Date().toISOString());

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [trashId] }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.restored, 1);

    // Verify file is back in file_metadata
    const { results } = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND file_name = ?').all(AUTH_USER.id, 'restore-me.txt');
    assert.equal(results.length, 1);

    // Verify trash entry is gone
    const { results: trashRows } = await db.prepare('SELECT * FROM trash WHERE id = ?').all(trashId);
    assert.equal(trashRows.length, 0);
  });
});

test('POST /api/files/trash/restore returns 400 without ids', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- DELETE /api/files/trash ---

test('DELETE /api/files/trash permanently deletes by ids', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const trashId = randomUUID();
    await db.prepare(`
      INSERT INTO trash (
        id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
        virtual_path, file_name, is_folder, size, mime_type,
        remote_created_time, remote_modified_time, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trashId, AUTH_USER.id, accountId, 'remote-d1', null, '/', 'perm-delete.txt', 0, 100, 'text/plain', null, null, new Date().toISOString());

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [trashId] }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.permanentlyDeleted, 1);

    const { results } = await db.prepare('SELECT * FROM trash WHERE id = ?').all(trashId);
    assert.equal(results.length, 0);
  });
});

test('DELETE /api/files/trash returns 400 without ids', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- DELETE /api/files/trash/all ---

test('DELETE /api/files/trash/all permanently deletes all trash', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    for (let i = 0; i < 3; i++) {
      await db.prepare(`
        INSERT INTO trash (
          id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
          virtual_path, file_name, is_folder, size, mime_type,
          remote_created_time, remote_modified_time, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), AUTH_USER.id, accountId, `remote-${i}`, null, '/', `trash${i}.txt`, 0, 100, 'text/plain', null, null, new Date().toISOString());
    }

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/trash/all', {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.permanentlyDeleted, 3);

    const { results } = await db.prepare('SELECT * FROM trash WHERE user_id = ?').all(AUTH_USER.id);
    assert.equal(results.length, 0);
  });
});

// --- POST /api/files/bulk/delete ---

test('POST /api/files/bulk/delete soft deletes files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId1 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'del1.txt' });
    const fileId2 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'del2.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/bulk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [fileId1, fileId2] }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.success, true);
    assert.ok(body.data.deleted >= 2);

    // Files should be in trash now
    const { results: trashRows } = await db.prepare('SELECT * FROM trash WHERE user_id = ?').all(AUTH_USER.id);
    assert.ok(trashRows.length >= 2);

    // Files should be removed from file_metadata
    const { results: metaRows } = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').all(AUTH_USER.id);
    assert.equal(metaRows.length, 0);
  });
});

test('POST /api/files/bulk/delete returns 400 with empty ids', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/bulk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- PATCH /api/files/:id/star ---

test('PATCH /api/files/:id/star stars a file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'star.txt', is_starred: 0 });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/star`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_starred: true }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.is_starred, true);

    const { results } = await db.prepare('SELECT is_starred FROM file_metadata WHERE id = ?').all(fileId);
    assert.equal(results[0].is_starred, 1);
  });
});

test('PATCH /api/files/:id/star returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/star`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_starred: true }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

// --- PATCH /api/files/:id/rename ---

test('PATCH /api/files/:id/rename renames a file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'old-name.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-name.txt' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.success, true);

    const { results } = await db.prepare('SELECT file_name FROM file_metadata WHERE id = ?').all(fileId);
    assert.equal(results[0].file_name, 'new-name.txt');
  });
});

test('PATCH /api/files/:id/rename returns 400 without name', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'x.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

test('PATCH /api/files/:id/rename returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

// --- DELETE /api/files/:id ---

test('DELETE /api/files/:id soft deletes a single file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'delete-me.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}`, {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.success, true);

    // File should be in trash
    const { results: trashRows } = await db.prepare('SELECT * FROM trash WHERE user_id = ? AND file_name = ?').all(AUTH_USER.id, 'delete-me.txt');
    assert.equal(trashRows.length, 1);

    // File should be removed from file_metadata
    const { results: metaRows } = await db.prepare('SELECT * FROM file_metadata WHERE id = ?').all(fileId);
    assert.equal(metaRows.length, 0);
  });
});

test('DELETE /api/files/:id returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}`, {
      method: 'DELETE',
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

// --- GET /api/files/:id ---

test('GET /api/files/:id returns file details', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'details.txt', size: 999 });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}`), { user: AUTH_USER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.file_name, 'details.txt');
    assert.equal(body.data.size, 999);
  });
});

test('GET /api/files/:id returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}`), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

// --- POST /api/files/bulk/download ---

test('POST /api/files/bulk/download returns 501', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/bulk/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 501);
  });
});

// --- POST /api/files/bulk/move ---

test('POST /api/files/bulk/move moves multiple files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'target-folder', is_folder: 1, virtual_path: '/' });
    const fileId1 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'bulk-move1.txt', virtual_path: '/' });
    const fileId2 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'bulk-move2.txt', virtual_path: '/' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request('http://x/api/files/bulk/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [fileId1, fileId2], destinationPath: '/target-folder/' }),
      }), { user: AUTH_USER });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.success, true);
      assert.equal(body.data.moved, 2);
      assert.equal(body.data.errors.length, 0);

      const { results } = await db.prepare('SELECT virtual_path FROM file_metadata WHERE id IN (?, ?)').all(fileId1, fileId2);
      for (const row of results) {
        assert.equal(row.virtual_path, '/target-folder/');
      }
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/bulk/move returns 400 without ids', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/bulk/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- POST /api/files/bulk/copy ---

test('POST /api/files/bulk/copy copies multiple files', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'target-folder', is_folder: 1, virtual_path: '/' });
    const fileId1 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'bulk-copy1.txt', virtual_path: '/' });
    const fileId2 = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'bulk-copy2.txt', virtual_path: '/' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request('http://x/api/files/bulk/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [fileId1, fileId2], destinationPath: '/target-folder/' }),
      }), { user: AUTH_USER });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.success, true);
      assert.equal(body.data.copied, 2);
      assert.equal(body.data.errors.length, 0);

      const { results } = await db.prepare('SELECT virtual_path FROM file_metadata WHERE user_id = ? AND is_folder = 0 AND virtual_path = ?').all(AUTH_USER.id, '/target-folder/');
      assert.ok(results.length >= 2);
      for (const row of results) {
        assert.equal(row.virtual_path, '/target-folder/');
      }
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/bulk/copy returns 400 without ids', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/bulk/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- Adapter-dependent routes return 501 ---

test('GET /api/files/:id/download streams file content', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'download.txt', mime_type: 'text/plain' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/download`), { user: AUTH_USER });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="download.txt"');
      assert.equal(res.headers.get('content-type'), 'text/plain');
      const text = await res.text();
      assert.equal(text, 'content-of-download.txt');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/files/:id/download returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/download`), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('GET /api/files/:id/download returns 400 for folder', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const folderId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'myfolder', is_folder: 1 });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${folderId}/download`), { user: AUTH_USER });
      assert.equal(res.status, 400);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/files/:id/preview returns inline content for previewable type', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'preview.txt', mime_type: 'text/plain' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/preview`), { user: AUTH_USER });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-disposition'), 'inline');
      assert.equal(res.headers.get('content-type'), 'text/plain');
      const text = await res.text();
      assert.equal(text, 'content-of-preview.txt');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('GET /api/files/:id/preview returns 415 for non-previewable type', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'app.exe', mime_type: 'application/x-msdownload' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/preview`), { user: AUTH_USER });
    assert.equal(res.status, 415);
  });
});

test('GET /api/files/:id/preview returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/preview`), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('GET /api/files/:id/preview returns 400 for folder', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const folderId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'myfolder', is_folder: 1, mime_type: null });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${folderId}/preview`), { user: AUTH_USER });
      assert.equal(res.status, 400);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/:id/move moves a file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'target-folder', is_folder: 1, virtual_path: '/' });
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'move-me.txt', virtual_path: '/' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationPath: '/target-folder/' }),
      }), { user: AUTH_USER });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.success, true);

      const { results } = await db.prepare('SELECT virtual_path, remote_parent_id FROM file_metadata WHERE id = ?').all(fileId);
      assert.equal(results[0].virtual_path, '/target-folder/');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/:id/move returns 400 without destinationPath', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'move.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

test('POST /api/files/:id/move returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('POST /api/files/:id/move returns 501 when adapter lacks moveFile', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'move.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 501);
  });
});

test('POST /api/files/:id/copy copies a file', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'target-folder', is_folder: 1, virtual_path: '/' });
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'copy-me.txt', virtual_path: '/' });

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationPath: '/target-folder/' }),
      }), { user: AUTH_USER });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.success, true);
      assert.ok(body.data.id);

      const { results } = await db.prepare('SELECT * FROM file_metadata WHERE id = ?').all(body.data.id);
      assert.equal(results.length, 1);
      assert.equal(results[0].virtual_path, '/target-folder/');
      assert.equal(results[0].file_name, 'copy-me.txt');
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/:id/copy returns 400 without destinationPath', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'copy.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

test('POST /api/files/:id/copy returns 404 for nonexistent file', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${randomUUID()}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 404);
  });
});

test('POST /api/files/:id/copy returns 501 when adapter lacks copyFile', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'copy.txt' });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: '/' }),
    }), { user: AUTH_USER });
    assert.equal(res.status, 501);
  });
});

test('GET /api/files/:id/shared-children returns 501', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);
    const fileId = await insertTestFile(db, AUTH_USER.id, accountId, { file_name: 'shared', is_folder: 1 });

    const app = makeApp();
    const res = await runExpress(app, new Request(`http://x/api/files/${fileId}/shared-children`), { user: AUTH_USER });
    assert.equal(res.status, 501);
  });
});

test('POST /api/files/folders creates a folder', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const accountId = await insertTestAccount(db, AUTH_USER.id);

    _setAdapterOverrides({ google_drive: MockAdapter });
    try {
      const app = makeApp();
      const res = await runExpress(app, new Request('http://x/api/files/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Folder', path: '/' }),
      }), { user: AUTH_USER });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.file_name, 'New Folder');
      assert.equal(body.data.virtual_path, '/');

      const { results } = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND file_name = ?').all(AUTH_USER.id, 'New Folder');
      assert.equal(results.length, 1);
      assert.equal(results[0].is_folder, 1);
    } finally {
      _clearAdapterOverrides();
    }
  });
});

test('POST /api/files/folders returns 400 without name', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { user: AUTH_USER });
    assert.equal(res.status, 400);
  });
});

// --- GET /api/files?shared ---

test('GET /api/files?shared=1 returns 501', async () => {
  await seedEnv(async () => {
    const app = makeApp();
    const res = await runExpress(app, new Request('http://x/api/files?shared=1'), { user: AUTH_USER });
    assert.equal(res.status, 501);
  });
});
