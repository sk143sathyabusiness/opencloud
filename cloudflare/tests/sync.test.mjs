import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedEnv } from './helpers.mjs';
import { getDb } from '../db.js';
import { randomUUID } from 'crypto';
import { getActiveAccounts, updateAccountStorage, markAccountStatus } from '../services/accountService.js';
import { replaceFilesForAccount, getTrashedRemoteIds } from '../services/fileService.js';
import { getExpiredTrashRows, removeTrashedRows } from '../services/trashService.js';
import { getLastSyncReport, syncAccount, runDeltaSync } from '../services/syncService.js';

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

async function insertTestTrash(db, accountId, overrides = {}) {
  const id = randomUUID();
  const defaults = {
    id,
    user_id: USER_ID,
    cloud_account_id: accountId,
    remote_file_id: `remote-${id}`,
    remote_parent_id: null,
    virtual_path: '/',
    file_name: 'deleted.txt',
    is_folder: 0,
    size: 100,
    mime_type: 'text/plain',
    remote_created_time: null,
    remote_modified_time: null,
    deleted_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  await db.prepare(`
    INSERT INTO trash (id, user_id, cloud_account_id, remote_file_id, remote_parent_id, virtual_path, file_name, is_folder, size, mime_type, remote_created_time, remote_modified_time, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.user_id, row.cloud_account_id, row.remote_file_id, row.remote_parent_id, row.virtual_path, row.file_name, row.is_folder, row.size, row.mime_type, row.remote_created_time, row.remote_modified_time, row.deleted_at);
  return row;
}

function makeAdapterFactory(MockClass) {
  return async () => new MockClass();
}

// --- accountService tests ---

test('getActiveAccounts returns only active accounts', async () => {
  await seedEnv(async () => {
    const db = getDb();
    await insertTestAccount(db, { email: 'active@test.com', status: 'active' });
    await insertTestAccount(db, { email: 'suspended@test.com', status: 'suspended' });
    await insertTestAccount(db, { email: 'invalid@test.com', status: 'invalid_token' });

    const accounts = await getActiveAccounts(USER_ID);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, 'active@test.com');
  });
});

test('getActiveAccounts returns empty for user with no accounts', async () => {
  await seedEnv(async () => {
    const accounts = await getActiveAccounts('nonexistent-user');
    assert.equal(accounts.length, 0);
  });
});

test('updateAccountStorage updates total_space and used_space', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db, { total_space: 5000, used_space: 1000 });

    await updateAccountStorage(USER_ID, acct.id, 20000, 5000);

    const updated = await db.prepare('SELECT total_space, used_space FROM cloud_accounts WHERE id = ?').get(acct.id);
    assert.equal(updated.total_space, 20000);
    assert.equal(updated.used_space, 5000);
  });
});

test('markAccountStatus updates status', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db, { status: 'active' });

    await markAccountStatus(USER_ID, acct.id, 'invalid_token');

    const updated = await db.prepare('SELECT status FROM cloud_accounts WHERE id = ?').get(acct.id);
    assert.equal(updated.status, 'invalid_token');
  });
});

// --- fileService tests ---

test('replaceFilesForAccount inserts records correctly', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);
    const records = [
      { virtual_path: '/', file_name: 'doc.pdf', is_folder: 0, size: 2048, mime_type: 'application/pdf', remote_file_id: 'r1' },
      { virtual_path: '/', file_name: 'folder', is_folder: 1, size: 0, remote_file_id: 'r2' },
      { virtual_path: '/folder/', file_name: 'nested.txt', is_folder: 0, size: 512, mime_type: 'text/plain', remote_file_id: 'r3' },
    ];

    await replaceFilesForAccount(USER_ID, acct.id, records);

    const result = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').all(USER_ID, acct.id);
    const rows = result.results || result;
    assert.equal(rows.length, 3);

    const names = rows.map(r => r.file_name).sort();
    assert.deepEqual(names, ['doc.pdf', 'folder', 'nested.txt']);

    const folder = rows.find(r => r.file_name === 'folder');
    assert.equal(folder.is_folder, 1);

    const nested = rows.find(r => r.file_name === 'nested.txt');
    assert.equal(nested.virtual_path, '/folder/');
  });
});

test('replaceFilesForAccount handles empty records', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    // Insert a file first
    await replaceFilesForAccount(USER_ID, acct.id, [
      { virtual_path: '/', file_name: 'existing.txt', is_folder: 0, size: 100, remote_file_id: 'r1' },
    ]);
    const before = await db.prepare('SELECT COUNT(*) as cnt FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').get(USER_ID, acct.id);
    assert.equal(before.cnt, 1);

    // Replace with empty
    await replaceFilesForAccount(USER_ID, acct.id, []);

    const after = await db.prepare('SELECT COUNT(*) as cnt FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').get(USER_ID, acct.id);
    assert.equal(after.cnt, 0);
  });
});

test('replaceFilesForAccount deletes existing records before inserting', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    await replaceFilesForAccount(USER_ID, acct.id, [
      { virtual_path: '/', file_name: 'old.txt', is_folder: 0, size: 100, remote_file_id: 'r1' },
    ]);

    await replaceFilesForAccount(USER_ID, acct.id, [
      { virtual_path: '/', file_name: 'new.txt', is_folder: 0, size: 200, remote_file_id: 'r2' },
    ]);

    const rows = await db.prepare('SELECT file_name FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').all(USER_ID, acct.id);
    const results = rows.results || rows;
    assert.equal(results.length, 1);
    assert.equal(results[0].file_name, 'new.txt');
  });
});

test('getTrashedRemoteIds returns set of remote file ids', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);
    await insertTestTrash(db, acct.id, { remote_file_id: 'trash-r1' });
    await insertTestTrash(db, acct.id, { remote_file_id: 'trash-r2' });

    const ids = await getTrashedRemoteIds(USER_ID, acct.id);
    assert.ok(ids instanceof Set);
    assert.equal(ids.size, 2);
    assert.ok(ids.has('trash-r1'));
    assert.ok(ids.has('trash-r2'));
  });
});

test('getTrashedRemoteIds returns empty set when no trash', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    const ids = await getTrashedRemoteIds(USER_ID, acct.id);
    assert.ok(ids instanceof Set);
    assert.equal(ids.size, 0);
  });
});

// --- trashService tests ---

test('getExpiredTrashRows respects retention period', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    // Old trash (40 days ago)
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
    await insertTestTrash(db, acct.id, { file_name: 'old.txt', deleted_at: oldDate });

    // Recent trash (5 days ago)
    const recentDate = new Date(Date.now() - 5 * 86400000).toISOString();
    await insertTestTrash(db, acct.id, { file_name: 'recent.txt', deleted_at: recentDate });

    const expired = await getExpiredTrashRows(USER_ID, 30);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].file_name, 'old.txt');
  });
});

test('getExpiredTrashRows returns empty when nothing expired', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);
    const recentDate = new Date(Date.now() - 5 * 86400000).toISOString();
    await insertTestTrash(db, acct.id, { file_name: 'recent.txt', deleted_at: recentDate });

    const expired = await getExpiredTrashRows(USER_ID, 30);
    assert.equal(expired.length, 0);
  });
});

test('removeTrashedRows deletes specified rows', async () => {
  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);
    const row1 = await insertTestTrash(db, acct.id, { file_name: 'a.txt' });
    const row2 = await insertTestTrash(db, acct.id, { file_name: 'b.txt' });

    await removeTrashedRows([row1]);

    const remaining = await db.prepare('SELECT * FROM trash WHERE user_id = ?').all(USER_ID);
    const results = remaining.results || remaining;
    assert.equal(results.length, 1);
    assert.equal(results[0].file_name, 'b.txt');
  });
});

test('removeTrashedRows handles empty array', async () => {
  await seedEnv(async () => {
    await removeTrashedRows([]);
  });
});

// --- syncService tests ---

test('getLastSyncReport returns initial state', async () => {
  const report = getLastSyncReport();
  assert.equal(report.lastRunAt, null);
  assert.equal(report.userId, null);
  assert.equal(report.scannedAccounts, 0);
  assert.equal(report.changesDetected, 0);
});

class MockSyncAdapter {
  constructor() {}
  async fetchStructure() {
    return [
      { virtual_path: '/', file_name: 'mock.txt', is_folder: 0, size: 100, mime_type: 'text/plain', remote_file_id: 'mock-r1' },
    ];
  }
  async getStorageSummary() {
    return { totalSpace: 50000, usedSpace: 10000 };
  }
}

class MockAuthErrorAdapter {
  constructor() {}
  async fetchStructure() {
    const err = new Error('invalid_token');
    err.status = 401;
    throw err;
  }
  async getStorageSummary() {
    return { totalSpace: 0, usedSpace: 0 };
  }
}

class MockTransientErrorAdapter {
  constructor() {}
  async fetchStructure() {
    const err = new Error('Server Error');
    err.status = 500;
    throw err;
  }
  async getStorageSummary() {
    return { totalSpace: 0, usedSpace: 0 };
  }
}

class MockWithTrashAdapter {
  constructor() {}
  async fetchStructure() {
    return [
      { virtual_path: '/', file_name: 'keep.txt', is_folder: 0, size: 100, remote_file_id: 'r-keep' },
      { virtual_path: '/', file_name: 'trashed.txt', is_folder: 0, size: 50, remote_file_id: 'r-trashed' },
    ];
  }
  async getStorageSummary() {
    return { totalSpace: 1000, usedSpace: 100 };
  }
}

test('syncAccount fetches structure and replaces files', async () => {
  const factory = makeAdapterFactory(MockSyncAdapter);

  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    const result = await syncAccount(USER_ID, acct, {}, factory);
    assert.equal(result.filesCount, 1);
    assert.equal(result.storage.totalSpace, 50000);

    const rows = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').all(USER_ID, acct.id);
    const files = rows.results || rows;
    assert.equal(files.length, 1);
    assert.equal(files[0].file_name, 'mock.txt');

    const updatedAcct = await db.prepare('SELECT total_space, used_space FROM cloud_accounts WHERE id = ?').get(acct.id);
    assert.equal(updatedAcct.total_space, 50000);
    assert.equal(updatedAcct.used_space, 10000);
  });
});

test('syncAccount filters out trashed remote ids', async () => {
  const factory = makeAdapterFactory(MockWithTrashAdapter);

  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db);

    // Pre-populate trash
    await insertTestTrash(db, acct.id, { remote_file_id: 'r-trashed', file_name: 'trashed.txt' });

    const result = await syncAccount(USER_ID, acct, {}, factory);
    assert.equal(result.filesCount, 1);

    const rows = await db.prepare('SELECT file_name FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').all(USER_ID, acct.id);
    const files = rows.results || rows;
    assert.equal(files.length, 1);
    assert.equal(files[0].file_name, 'keep.txt');
  });
});

test('runDeltaSync processes all active accounts', async () => {
  const factory = makeAdapterFactory(MockSyncAdapter);

  await seedEnv(async () => {
    const db = getDb();
    await insertTestAccount(db, { email: 'a@test.com' });
    await insertTestAccount(db, { email: 'b@test.com' });

    const report = await runDeltaSync(USER_ID, {}, factory);
    assert.equal(report.scannedAccounts, 2);
    assert.equal(report.changesDetected, 2);
    assert.ok(report.lastRunAt);
    assert.equal(report.userId, USER_ID);
  });
});

test('runDeltaSync marks account invalid on auth error', async () => {
  const factory = makeAdapterFactory(MockAuthErrorAdapter);

  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db, { status: 'active' });

    const report = await runDeltaSync(USER_ID, {}, factory);
    assert.equal(report.scannedAccounts, 1);

    const updated = await db.prepare('SELECT status FROM cloud_accounts WHERE id = ?').get(acct.id);
    assert.equal(updated.status, 'invalid_token');
  });
});

test('runDeltaSync continues on transient errors', async () => {
  const factory = makeAdapterFactory(MockTransientErrorAdapter);

  await seedEnv(async () => {
    const db = getDb();
    const acct = await insertTestAccount(db, { status: 'active' });

    const report = await runDeltaSync(USER_ID, {}, factory);
    assert.equal(report.scannedAccounts, 1);

    // Account should still be active
    const updated = await db.prepare('SELECT status FROM cloud_accounts WHERE id = ?').get(acct.id);
    assert.equal(updated.status, 'active');
  });
});

test('getLastSyncReport reflects last sync run', async () => {
  const factory = makeAdapterFactory(MockSyncAdapter);

  await seedEnv(async () => {
    const db = getDb();
    await insertTestAccount(db);

    const report = await runDeltaSync(USER_ID, {}, factory);
    const stored = getLastSyncReport();
    assert.equal(stored.lastRunAt, report.lastRunAt);
    assert.equal(stored.userId, USER_ID);
    assert.equal(stored.scannedAccounts, 1);
    assert.equal(stored.changesDetected, 1);
  });
});
