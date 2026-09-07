import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/config/database.js');
const {
	listAllFiles,
	createFileMetadata,
	replaceFilesForAccount,
	getFileById,
	getTrashedRemoteIds,
} = await import('../src/services/fileService.js');
const trash = await import('../src/services/trashService.js');

const USER = 'u-trash-test';
const ACCOUNT = 'acc-trash-test';

db.prepare(
	'INSERT OR IGNORE INTO users (id, email, password_hash, is_local) VALUES (?, ?, ?, 1)'
).run(USER, 'trash@test.local', '');
db.prepare(`
	INSERT OR IGNORE INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(ACCOUNT, USER, 'trash-acc@test.local', 'google_drive', 'test-creds', 1024, 0, 'active');

const ROW = (fileName, virtualPath, isFolder = 0) => ({
	user_id: USER,
	virtual_path: virtualPath,
	file_name: fileName,
	is_folder: isFolder,
	is_starred: 0,
	size: isFolder ? 0 : 100,
	mime_type: isFolder ? null : 'text/plain',
	cloud_account_id: ACCOUNT,
	remote_file_id: `${fileName}-remote`,
	remote_parent_id: null,
	remote_created_time: null,
	remote_modified_time: null,
});

const project = createFileMetadata(ROW('Project', '/', 1));
const a = createFileMetadata(ROW('a.txt', '/Project/', 0));
const b = createFileMetadata(ROW('b.txt', '/Project/', 0));
const keep = createFileMetadata(ROW('keep.txt', '/', 0));

test('softDelete snapshots folder subtree and removes mirror rows', () => {
	const { trashed, skipped } = trash.softDeleteFilesByIds(USER, [project.id]);
	assert.equal(trashed, 3);
	assert.equal(skipped, 0);

	const remaining = listAllFiles(USER).map((f) => f.id);
	assert.deepEqual(remaining, [keep.id]);

	const listed = trash.listTrashedFiles(USER);
	assert.equal(listed.length, 3);
	assert.equal(listed[0].remote_file_id, 'a.txt-remote');
	assert.equal(listed[0].provider, 'google_drive');
});

test('trashed files are excluded from replaceFilesForAccount (sync)', () => {
	replaceFilesForAccount(USER, ACCOUNT, [
		ROW('a.txt', '/Project/'),
		ROW('keep.txt', '/'),
	]);
	const ids = listAllFiles(USER).map((f) => f.file_name).sort();
	assert.deepEqual(ids, ['keep.txt']);
});

test('restore re-inserts mirror rows and clears trash', () => {
	const target = trash.listTrashedFiles(USER).find((f) => f.file_name === 'a.txt');
	assert.ok(target, 'a.txt in trash');

	const { restored } = trash.restoreTrashedFiles(USER, [target.id]);
	assert.equal(restored, 1);
	assert.ok(
		!trash.listTrashedFiles(USER).some((f) => f.file_name === 'a.txt'),
		'a.txt cleared from trash'
	);

	const restoredFile = listAllFiles(USER).find((f) => f.file_name === 'a.txt');
	assert.ok(restoredFile, 'a.txt restored');
	assert.equal(restoredFile.virtual_path, '/Project/');
	assert.equal(restoredFile.remote_file_id, 'a.txt-remote');
});

test('permanent delete removes trash rows and returns them for provider calls', () => {
	const keepRow = listAllFiles(USER).find((f) => f.file_name === 'keep.txt');
	assert.ok(keepRow, 'keep.txt still in mirror');
	trash.softDeleteFilesByIds(USER, [keepRow.id]);

	const targets = trash.listTrashedFiles(USER);
	const got = trash.getTrashedRowsByIds(USER, targets.map((f) => f.id));
	assert.equal(got.length, 3);
	trash.removeTrashedRows(USER, got.map((f) => f.id));
	assert.equal(trash.listTrashedFiles(USER).length, 0);
});

test('getTrashedRemoteIds returns a Set', () => {
	const aRow = listAllFiles(USER).find((f) => f.file_name === 'a.txt');
	assert.ok(aRow, 'a.txt in mirror');
	trash.softDeleteFilesByIds(USER, [aRow.id]);

	const set = getTrashedRemoteIds(USER, ACCOUNT);
	assert.ok(set instanceof Set);
	assert.ok(set.has('a.txt-remote'));
});