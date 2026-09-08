import { getDb } from '../db.js';

export async function getActiveAccounts(userId) {
  const db = getDb();
  const result = await db.prepare(
    'SELECT * FROM cloud_accounts WHERE user_id = ? AND status = ?'
  ).all(userId, 'active');
  return result.results || result;
}

export async function updateAccountStorage(userId, accountId, totalSpace, usedSpace) {
  const db = getDb();
  await db.prepare(
    'UPDATE cloud_accounts SET total_space = ?, used_space = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  ).run(totalSpace, usedSpace, accountId, userId);
}

export async function markAccountStatus(userId, accountId, status) {
  const db = getDb();
  await db.prepare(
    'UPDATE cloud_accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  ).run(status, accountId, userId);
}
