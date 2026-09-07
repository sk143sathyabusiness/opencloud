import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/config/database.js');
const { createFileMetadata, listAllFiles, getFolderByPath, getDescendants } = await import('../src/services/fileService.js');
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');

const USER = 'u-move';
const ACCOUNT = 'acc-move';

db.prepare(
	'INSERT OR IGNORE INTO users (id, email, password_hash, is_local) VALUES (?, ?, ?, 1)'
).run(USER, 'move@test.local', '');
db.prepare(`
	INSERT OR IGNORE INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(ACCOUNT, USER, 'move-acc@test.local', 's3', 'test-creds', 1000, 10, 'active');

const acc = { id: ACCOUNT, provider: 's3', email: 'a@a', total_space: 1000, used_space: 10 };
const adapter = new BaseCloudAdapter(acc);

test('getFolderByPath resolves normalized folder paths', () => {
	createFileMetadata({ user_id: USER, virtual_path: '/', file_name: 'Docs', is_folder: 1, size: 0, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'docs-remote' });
	const folder = getFolderByPath(USER, '/Docs');
	assert.equal(folder.file_name, 'Docs');
	assert.equal(getFolderByPath(USER, '/'), null);
});

test('getDescendants collects subtree rows', () => {
	createFileMetadata({ user_id: USER, virtual_path: '/Docs/', file_name: 'a.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'a-remote' });
	createFileMetadata({ user_id: USER, virtual_path: '/Docs/Sub/', file_name: 'b.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'b-remote' });
	createFileMetadata({ user_id: USER, virtual_path: '/', file_name: 'top.txt', is_folder: 0, size: 1, mime_type: null, cloud_account_id: ACCOUNT, remote_file_id: 'top-remote' });
	const rows = listAllFiles(USER);
	const docs = getFolderByPath(USER, '/Docs');
	const descendants = getDescendants(rows, docs);
	assert.equal(descendants.length, 2);
	assert.ok(descendants.every((row) => row.file_name !== 'top.txt'));
});

test('BaseCloudAdapter copyFile streams through uploadStream', async () => {
	const out = await adapter.copyFile({ remote_file_id: 'r', file_name: 'x.txt', mime_type: 'text/plain', size: 3, virtual_path: '/' }, null);
	assert.ok(out.remoteFileId);
	assert.equal(out.fileName, 'x.txt');
});