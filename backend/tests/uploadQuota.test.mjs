import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.QUOTA_HARD_LIMIT_ENABLED = 'true';

const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { selectBestAccount, toFreeSpaceView, isAlmostFull, isFull } = await import('../src/services/spaceAllocator.js');

const seedAccount = db.prepare(`
	INSERT OR REPLACE INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
	VALUES (@id, @userId, @email, 's3', '', @total, @used, 'active')
`);
seedAccount.run({ id: 'acc-full', userId: LOCAL_USER_ID, email: 'full@x', total: 100, used: 100 });
seedAccount.run({ id: 'acc-roomy', userId: LOCAL_USER_ID, email: 'roomy@x', total: 1000, used: 100 });

test('toFreeSpaceView computes freeSpace and usedRatio', () => {
	const view = toFreeSpaceView({ total_space: 1000, used_space: 850 });
	assert.equal(view.freeSpace, 150);
	assert.equal(view.usedRatio, 0.85);
});

test('isAlmostFull flags high but not exhausted accounts', () => {
	assert.equal(isAlmostFull({ total_space: 1000, used_space: 900 }), true);
	assert.equal(isAlmostFull({ total_space: 1000, used_space: 100 }), false);
	assert.equal(isFull({ total_space: 1000, used_space: 900 }), false);
});

test('isFull flags exhausted accounts only', () => {
	assert.equal(isFull({ total_space: 100, used_space: 100 }), true);
	assert.equal(isFull({ total_space: 100, used_space: 150 }), true);
	assert.equal(isFull({ total_space: 100, used_space: 90 }), false);
});

test('selectBestAccount with requiredBytes returns a view with freeSpace', () => {
	const { selected } = selectBestAccount(LOCAL_USER_ID, 1);
	assert.equal(typeof selected.freeSpace, 'number');
});