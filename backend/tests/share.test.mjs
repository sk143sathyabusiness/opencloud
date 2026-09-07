import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const { db } = await import('../src/config/database.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');
const { createFileMetadata, listAllFiles } = await import('../src/services/fileService.js');
const share = await import('../src/services/shareService.js');

db.prepare(`INSERT OR REPLACE INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,?,?,?,?, 'active')`)
	.run('acc-share', LOCAL_USER_ID, 'share@x', 'google_drive', '', 1000, 10);

createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 'f.txt', is_folder: 0, size: 10, mime_type: 'text/plain', cloud_account_id: 'acc-share', remote_file_id: 'f1' });
createFileMetadata({ user_id: LOCAL_USER_ID, virtual_path: '/', file_name: 'Folder', is_folder: 1, size: 0, mime_type: null, cloud_account_id: 'acc-share', remote_file_id: 'f2' });

function requireFileId(fileName = 'f.txt') {
	return listAllFiles(LOCAL_USER_ID).find((row) => row.file_name === fileName).id;
}

test('createShareLink throws for folders and missing files', () => {
	const folder = requireFileId('Folder');
	assert.throws(() => share.createShareLink({ userId: LOCAL_USER_ID, fileId: folder }), /not shareable/);
	assert.throws(() => share.createShareLink({ userId: LOCAL_USER_ID, fileId: 'nope' }), /not found/);
});

test('create, list, touch, revoke round-trip', () => {
	const fileId = requireFileId();
	const link = share.createShareLink({ userId: LOCAL_USER_ID, fileId, expiresInDays: 7 });
	assert.ok(link.token.length >= 32);
	assert.equal(share.listShareLinks(LOCAL_USER_ID).length, 1);

	share.touchShareLink(link.token);
	const again = share.getShareLinkByToken(link.token);
	assert.equal(again.download_count, 1);
	assert.ok(!again.expired);

	const revoke = share.revokeShareLink(LOCAL_USER_ID, link.token);
	assert.equal(revoke.revoked, 1);
	assert.equal(share.getShareLinkByToken(link.token), null);
});