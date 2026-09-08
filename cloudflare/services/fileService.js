import { getDb } from '../db.js';

/**
 * Full replace: delete all rows for account, then bulk insert.
 * Uses db.batch() with 500-statement chunks (D1 limit).
 */
export async function replaceFilesForAccount(userId, cloudAccountId, records) {
  const db = getDb();

  // Delete existing
  await db.prepare(
    'DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?'
  ).run(userId, cloudAccountId);

  if (records.length === 0) return;

  // Batch insert (D1 limit: 500 statements per batch)
  const BATCH_SIZE = 500;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const stmts = chunk.map(record =>
      db.prepare(
        `INSERT INTO file_metadata (id, user_id, cloud_account_id, virtual_path, file_name, is_folder, is_starred, size, mime_type, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        record.id || crypto.randomUUID(),
        userId,
        cloudAccountId,
        record.virtualPath || record.virtual_path,
        record.fileName || record.file_name,
        record.isFolder || record.is_folder ? 1 : 0,
        record.isStarred || record.is_starred ? 1 : 0,
        record.size || 0,
        record.mimeType || record.mime_type || 'application/octet-stream',
        record.remoteFileId || record.remote_file_id,
        record.remoteParentId || record.remote_parent_id || null,
        record.remoteCreatedTime || record.remote_created_time || null,
        record.remoteModifiedTime || record.remote_modified_time || null
      )
    );
    await db.batch(stmts);
  }
}

export async function getTrashedRemoteIds(userId, cloudAccountId) {
  const db = getDb();
  const result = await db.prepare(
    'SELECT remote_file_id FROM trash WHERE user_id = ? AND cloud_account_id = ?'
  ).all(userId, cloudAccountId);
  const rows = result.results || result;
  return new Set(rows.map(r => r.remote_file_id));
}
