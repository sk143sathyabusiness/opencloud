import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata } = await import('../src/services/fileService.js');
const share = await import('../src/services/shareService.js');

const { listAllFiles } = await import('../src/services/fileService.js');
const fileId = () => listAllFiles(LOCAL_USER_ID).find((row) => row.file_name === 's.txt').id;

db.prepare(`INSERT OR REPLACE INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,?,?,?,?, 'active')`)
	.run('acc-share', LOCAL_USER_ID, 'share@x', 'google_drive', '', 1000, 10);

test('getShareLinkByToken flags expiry', () => {
	createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 's.txt', is_folder: 0, size: 1, mime_type: 'text/plain', cloud_account_id: 'acc-share', remote_file_id: 's1' });
	const link = share.createShareLink({ userId: LOCAL_USER_ID, fileId: fileId(), expiresInDays: -1 });
	assert.equal(share.getShareLinkByToken(link.token).expired, true);
});