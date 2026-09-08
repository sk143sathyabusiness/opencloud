import { encryptJson } from '../../backend/src/utils/crypto.js';
import { getDb as defaultGetDb } from '../db.js';

export async function updateAccountCredentials(accountId, newCredentials, getDbFn = defaultGetDb) {
  try {
    const db = getDbFn();
    const encrypted = encryptJson(newCredentials);
    await db.prepare(`
      UPDATE cloud_accounts
      SET encrypted_credentials = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(encrypted, accountId);
  } catch (e) {
    console.error('Failed to persist credentials:', e.message);
  }
}
