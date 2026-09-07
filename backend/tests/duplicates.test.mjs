import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { replaceFilesForAccount, findDuplicateGroups } = await import('../src/services/fileService.js');

const ACCOUNT = 'acc-dup';
db.prepare(`INSERT OR REPLACE INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,?,?,?,?, 'active')`)
	.run(ACCOUNT, LOCAL_USER_ID, 'dup@x', 'google_drive', '', 1000, 10);

test('findDuplicateGroups groups by (file_name,size)', () => {
	replaceFilesForAccount(LOCAL_USER_ID, ACCOUNT, [
		{ file_name: 'report.pdf', size: 500, is_folder: 0, remote_file_id: 'r1', virtual_path: '/' },
		{ file_name: 'report.pdf', size: 500, is_folder: 0, remote_file_id: 'r2', virtual_path: '/Sub/' },
		{ file_name: 'report.pdf', size: 300, is_folder: 0, remote_file_id: 'r3', virtual_path: '/' },
		{ file_name: 'unique.txt', size: 700, is_folder: 0, remote_file_id: 'u1', virtual_path: '/' },
		{ file_name: 'folder', size: 0, is_folder: 1, remote_file_id: 'f1', virtual_path: '/' },
	]);

	const groups = findDuplicateGroups(LOCAL_USER_ID);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].file_name, 'report.pdf');
	assert.equal(groups[0].count, 2);
	assert.equal(groups[0].size, 500);
	assert.equal(groups[0].totalBytes, 1000);
	assert.equal(groups[0].items.length, 2);
});