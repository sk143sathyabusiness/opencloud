import { getDb } from '../db.js';
import { createAdapter } from '../adapters/registry.js';
import { withRetry } from '../utils/providerErrors.js';

export async function getExpiredTrashRows(userId, retentionDays = 30) {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const result = await db.prepare(
    'SELECT * FROM trash WHERE user_id = ? AND deleted_at < ?'
  ).all(userId, cutoff);
  return result.results || result;
}

export async function removeTrashedRows(rows) {
  const db = getDb();
  if (rows.length === 0) return;
  const stmts = rows.map(r =>
    db.prepare('DELETE FROM trash WHERE id = ?').bind(r.id)
  );
  await db.batch(stmts);
}

export async function purgeExpiredTrash(userId, env) {
  const rows = await getExpiredTrashRows(userId);
  if (rows.length === 0) return { purged: 0 };

  // Group by account
  const byAccount = {};
  for (const row of rows) {
    if (!byAccount[row.cloud_account_id]) byAccount[row.cloud_account_id] = [];
    byAccount[row.cloud_account_id].push(row);
  }

  let purged = 0;
  for (const [accountId, accountRows] of Object.entries(byAccount)) {
    try {
      const db = getDb();
      const account = await db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(accountId);
      if (!account) continue;

      const adapter = await createAdapter(account.provider, account, env);
      for (const row of accountRows) {
        try {
          await withRetry(() => adapter.deleteFile(row));
          purged++;
        } catch (e) {
          // Log but continue — some files may already be deleted
        }
      }
    } catch (e) {
      // Account-level failure — skip
    }
  }

  await removeTrashedRows(rows);
  return { purged };
}
