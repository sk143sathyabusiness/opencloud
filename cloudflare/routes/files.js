import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, envStore } from '../db.js';
import { requireAppUser } from '../middleware.js';
import { createZipStreamWriter } from '../zipWriter.js';

// --- Adapter override mechanism (for testing) ---
let _adapterOverrides = null;
export function _setAdapterOverrides(map) { _adapterOverrides = map; }
export function _clearAdapterOverrides() { _adapterOverrides = null; }

const ADAPTER_IMPORTERS = {
  google_drive: () => import('../adapters/google.js'),
  onedrive: () => import('../adapters/onedrive.js'),
  dropbox: () => import('../adapters/dropbox.js'),
  yandex: () => import('../adapters/yandex.js'),
  s3: () => import('../adapters/s3.js'),
  pcloud: () => import('../adapters/pcloud.js'),
};

const ADAPTER_CLASS_NAMES = {
  google_drive: 'GoogleDriveAdapter',
  onedrive: 'OneDriveAdapter',
  dropbox: 'DropboxAdapter',
  yandex: 'YandexAdapter',
  s3: 'S3Adapter',
  pcloud: 'PCloudAdapter',
};

async function getAdapterForAccount(accountId) {
  const db = getDb();
  const account = await db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(accountId);
  if (!account) return null;

  if (_adapterOverrides && _adapterOverrides[account.provider]) {
    const AdapterClass = _adapterOverrides[account.provider];
    return new AdapterClass(account);
  }

  const importer = ADAPTER_IMPORTERS[account.provider];
  if (!importer) return null;

  const mod = await importer();
  const AdapterClass = mod[ADAPTER_CLASS_NAMES[account.provider]];
  if (!AdapterClass) return null;

  const env = envStore.getStore();
  return new AdapterClass(account, env);
}

async function resolveDestinationFolder(db, userId, destinationPath, cloudAccountId) {
  const normalized = normalizePath(destinationPath);
  if (normalized === '/') {
    return { remoteFileId: null, virtualPath: '/' };
  }

  const trimmed = normalized.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const folderName = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  const parentPath = lastSlash === -1 ? '/' : trimmed.slice(0, lastSlash + 1);

  const where = ['fm.user_id = ?', 'fm.virtual_path = ?', 'fm.file_name = ?', 'fm.is_folder = 1'];
  const params = [userId, parentPath, folderName];
  if (cloudAccountId) {
    where.push('fm.cloud_account_id = ?');
    params.push(cloudAccountId);
  }

  const { results } = await db.prepare(`
    SELECT fm.* FROM file_metadata fm
    WHERE ${where.join(' AND ')}
    LIMIT 1
  `).all(...params);

  if (!results.length) return null;

  return {
    remoteFileId: results[0].remote_file_id,
    virtualPath: normalized,
    row: results[0],
  };
}

async function collectStream(stream) {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const PREVIEWABLE_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];
const PREVIEWABLE_TYPES = ['application/pdf'];

function isPreviewable(mimeType) {
  if (!mimeType) return false;
  if (PREVIEWABLE_TYPES.includes(mimeType)) return true;
  return PREVIEWABLE_PREFIXES.some((p) => mimeType.startsWith(p));
}

async function readJsonBody(req) {
  try {
    return await req._webRequest.json();
  } catch {
    return {};
  }
}

function buildDisplayNames(rows) {
  return rows.map((row) => ({
    ...row,
    createdTime: row.remote_created_time || null,
    modifiedTime: row.remote_modified_time || null,
    capabilities: {
      starred: row.provider === 'google_drive',
      rename: true,
      delete: true,
    },
  }));
}

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const cleaned = input.startsWith('/') ? input : `/${input}`;
  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

function joinPath(parentPath, name) {
  const base = parentPath === '/' || !parentPath ? '/' : parentPath;
  const clean = base.endsWith('/') ? base : `${base}/`;
  return `${clean}${String(name).replace(/^\/+/, '')}`;
}

export function createFilesRouter() {
  const router = Router();

  router.use(requireAppUser);

  // GET /api/files — list files by path, or search, or starred/recent/shared
  router.get('/files', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const { path, search, starred, recent, shared, limit } = req.query;

      if (search) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        const escapeLike = (value) => String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const tokens = String(search).trim().split(/\s+/).filter(Boolean).slice(0, 8);
        if (!tokens.length) return res.json({ data: [] });

        const where = ['fm.user_id = ?', "ca.status = 'active'"];
        const params = [userId];

        const tokenClauses = tokens.map(() => `(
          fm.file_name LIKE ? ESCAPE '\\'
          OR fm.mime_type LIKE ? ESCAPE '\\'
          OR fm.virtual_path LIKE ? ESCAPE '\\'
          OR ca.provider LIKE ? ESCAPE '\\'
          OR ca.email LIKE ? ESCAPE '\\'
        )`);
        for (const token of tokens) {
          const pattern = `%${escapeLike(token)}%`;
          params.push(pattern, pattern, pattern, pattern, pattern);
        }

        const firstPattern = `%${escapeLike(tokens[0])}%`;
        const { results } = await db.prepare(`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE ${where.join(' AND ')}
            AND ${tokenClauses.join(' AND ')}
          ORDER BY
            CASE WHEN fm.file_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
            fm.is_folder DESC,
            COALESCE(fm.remote_modified_time, fm.remote_created_time, fm.updated_at) DESC,
            fm.file_name COLLATE NOCASE ASC
          LIMIT ?
        `).all(...params, firstPattern, safeLimit);

        return res.json({ data: buildDisplayNames(results) });
      }

      if (starred === '1') {
        const { results } = await db.prepare(`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ? AND COALESCE(fm.is_starred, 0) = 1 AND ca.status = 'active'
          ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
            fm.updated_at DESC,
            fm.file_name COLLATE NOCASE ASC
        `).all(userId);
        return res.json({ data: buildDisplayNames(results) });
      }

      if (recent === '1') {
        const { results } = await db.prepare(`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ? AND fm.is_folder = 0 AND ca.status = 'active'
          ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
            fm.updated_at DESC,
            fm.file_name COLLATE NOCASE ASC
        `).all(userId);
        return res.json({ data: buildDisplayNames(results) });
      }

      if (shared === '1') {
        return res.status(501).json({ error: 'Shared files listing requires provider adapters' });
      }

      const virtualPath = normalizePath(path || '/');
      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.virtual_path = ? AND ca.status = 'active'
        ORDER BY fm.is_folder DESC, fm.file_name COLLATE NOCASE ASC
      `).all(userId, virtualPath);

      return res.json({ data: buildDisplayNames(results) });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/trash
  router.get('/files/trash', async (req, res, next) => {
    try {
      const db = getDb();
      const { results } = await db.prepare(`
        SELECT t.*, ca.provider
        FROM trash t
        LEFT JOIN cloud_accounts ca ON ca.id = t.cloud_account_id
        WHERE t.user_id = ?
        ORDER BY t.deleted_at DESC, t.file_name COLLATE NOCASE
      `).all(req.user.id);

      return res.json({ data: results });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/duplicates
  router.get('/files/duplicates', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;

      const { results: groups } = await db.prepare(`
        SELECT fm.file_name, fm.size, COUNT(*) AS count, SUM(fm.size) AS totalBytes
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.is_folder = 0 AND fm.size > 0 AND ca.status = 'active'
        GROUP BY fm.file_name, fm.size
        HAVING COUNT(*) >= 2
        ORDER BY totalBytes DESC, fm.file_name COLLATE NOCASE
      `).all(userId);

      const { results: items } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.is_folder = 0 AND fm.size > 0 AND ca.status = 'active'
        ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time, fm.updated_at) DESC, fm.file_name COLLATE NOCASE
      `).all(userId);

      const byKey = (name, size) => `${name}|${size}`;
      const itemGroups = new Map();
      for (const item of items) {
        const key = byKey(item.file_name, item.size);
        if (!itemGroups.has(key)) itemGroups.set(key, []);
        itemGroups.get(key).push(buildDisplayNames([item])[0]);
      }

      const result = groups
        .map((group) => ({
          key: byKey(group.file_name, group.size),
          file_name: group.file_name,
          size: Number(group.size),
          count: Number(group.count),
          totalBytes: Number(group.totalBytes),
          items: itemGroups.get(byKey(group.file_name, group.size)) || [],
        }))
        .filter((group) => group.items.length >= 2);

      return res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/trash/restore
  router.post('/files/trash/restore', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { ids } = body;

      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids are required' });
      }

      const placeholders = ids.map(() => '?').join(', ');
      const { results: rows } = await db.prepare(
        `SELECT * FROM trash WHERE user_id = ? AND id IN (${placeholders})`
      ).all(userId, ...ids);

      let restored = 0;
      for (const row of rows) {
        await db.prepare(`
          INSERT INTO file_metadata (
            id, user_id, virtual_path, file_name, is_folder, size, mime_type,
            cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), userId, row.virtual_path, row.file_name, row.is_folder,
          row.size, row.mime_type, row.cloud_account_id, row.remote_file_id,
          row.remote_parent_id, row.remote_created_time, row.remote_modified_time
        );
        await db.prepare('DELETE FROM trash WHERE user_id = ? AND id = ?').run(userId, row.id);
        restored += 1;
      }

      return res.json({ data: { restored } });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/files/trash — permanent delete by IDs
  router.delete('/files/trash', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { ids } = body;

      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids are required' });
      }

      const placeholders = ids.map(() => '?').join(', ');
      const { results: rows } = await db.prepare(
        `SELECT * FROM trash WHERE user_id = ? AND id IN (${placeholders})`
      ).all(userId, ...ids);

      let permanentlyDeleted = 0;
      for (const row of rows) {
        await db.prepare('DELETE FROM trash WHERE user_id = ? AND id = ?').run(userId, row.id);
        permanentlyDeleted += 1;
      }

      return res.json({ data: { success: true, permanentlyDeleted, errors: [] } });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/files/trash/all — permanent delete all trash
  router.delete('/files/trash/all', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;

      const { results: rows } = await db.prepare(
        'SELECT * FROM trash WHERE user_id = ?'
      ).all(userId);

      let permanentlyDeleted = 0;
      for (const row of rows) {
        await db.prepare('DELETE FROM trash WHERE user_id = ? AND id = ?').run(userId, row.id);
        permanentlyDeleted += 1;
      }

      return res.json({ data: { success: true, permanentlyDeleted, errors: [] } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/bulk/delete — soft delete
  router.post('/files/bulk/delete', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(Boolean))] : [];

      if (!ids.length) {
        return res.status(400).json({ error: 'At least one file id is required' });
      }

      const { results: allFiles } = await db.prepare(
        'SELECT * FROM file_metadata WHERE user_id = ?'
      ).all(userId);
      const byId = new Map(allFiles.map((row) => [row.id, row]));

      let trashed = 0;
      const removeIds = [];
      const deletedAt = new Date().toISOString();

      for (const rawId of ids) {
        const root = byId.get(rawId);
        if (!root) continue;

        const folderPath = root.is_folder ? joinPath(root.virtual_path, root.file_name) : null;
        const targets = [root];
        if (folderPath) {
          for (const row of allFiles) {
            if (row.virtual_path.startsWith(folderPath)) targets.push(row);
          }
        }

        for (const target of targets) {
          if (!byId.has(target.id)) continue;
          await db.prepare(`
            INSERT OR IGNORE INTO trash (
              id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
              virtual_path, file_name, is_folder, size, mime_type,
              remote_created_time, remote_modified_time, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(), userId, target.cloud_account_id, target.remote_file_id,
            target.remote_parent_id, target.virtual_path, target.file_name,
            target.is_folder, target.size, target.mime_type,
            target.remote_created_time, target.remote_modified_time, deletedAt
          );
          byId.delete(target.id);
          removeIds.push(target.id);
          trashed += 1;
        }
      }

      if (removeIds.length) {
        for (const id of removeIds) {
          await db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?').run(userId, id);
        }
      }

      return res.json({ data: { success: true, deleted: trashed } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/bulk/download — streaming ZIP archive
  router.post('/files/bulk/download', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];

      if (!ids.length) {
        return res.status(400).json({ error: 'At least one file id is required' });
      }

      // Resolve all IDs to leaf files (expand folders recursively)
      const leafFiles = [];
      const errors = [];

      async function expandId(id) {
        const { results } = await db.prepare(`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
        `).all(userId, id);

        if (!results.length) {
          errors.push(`File not found: ${id}`);
          return;
        }

        const file = results[0];
        if (file.is_folder) {
          // Recursively expand folder contents
          const folderPath = joinPath(file.virtual_path, file.file_name);
          const { results: children } = await db.prepare(`
            SELECT fm.*, ca.provider, ca.email
            FROM file_metadata fm
            INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
            WHERE fm.user_id = ? AND fm.virtual_path = ? AND ca.status = 'active'
          `).all(userId, folderPath);

          for (const child of children) {
            if (child.is_folder) {
              await expandId(child.id);
            } else {
              leafFiles.push(child);
            }
          }
        } else {
          leafFiles.push(file);
        }
      }

      for (const id of ids) {
        await expandId(id);
      }

      // Build ZIP stream
      const zipWriter = createZipStreamWriter();

      // Track used names to avoid collisions across adapters
      const seenNames = new Map();

      function uniqueZipName(baseName) {
        if (!seenNames.has(baseName)) {
          seenNames.set(baseName, 0);
          return baseName;
        }
        const count = seenNames.get(baseName) + 1;
        seenNames.set(baseName, count);
        const dotIdx = baseName.lastIndexOf('.');
        const name = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
        const ext = dotIdx > 0 ? baseName.slice(dotIdx) : '';
        return `${name}_${count}${ext}`;
      }

      // Write each file to ZIP
      for (const file of leafFiles) {
        try {
          const adapter = await getAdapterForAccount(file.cloud_account_id);
          if (!adapter) {
            errors.push(`Provider not available for: ${file.file_name}`);
            continue;
          }
          if (typeof adapter.getDownloadStream !== 'function') {
            errors.push(`Download not supported for: ${file.file_name}`);
            continue;
          }

          const stream = await adapter.getDownloadStream(file);
          const zipName = uniqueZipName(file.file_name);
          await zipWriter.writeEntry(zipName, stream, file.size);
        } catch (e) {
          errors.push(`Failed to download ${file.file_name}: ${e.message}`);
        }
      }

      // Write errors.txt if there were any errors
      if (errors.length > 0) {
        const encoder = new TextEncoder();
        const errorText = encoder.encode(errors.join('\n') + '\n');
        const errorStream = new ReadableStream({
          start(controller) {
            controller.enqueue(errorText);
            controller.close();
          }
        });
        await zipWriter.writeEntry('errors.txt', errorStream, errorText.byteLength);
      }

      const zipStream = zipWriter.finalize();

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="omnicloud-download.zip"');

      // Pipe the ReadableStream to Express response
      const reader = zipStream.getReader();
      async function pump() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      }
      await pump();
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/bulk/move
  router.post('/files/bulk/move', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { ids, destinationPath } = body;

      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
      if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });

      const placeholders = ids.map(() => '?').join(', ');
      const { results: files } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id IN (${placeholders}) AND ca.status = 'active'
      `).all(userId, ...ids);

      if (!files.length) {
        return res.status(404).json({ error: 'No files found' });
      }

      const byAccount = new Map();
      for (const file of files) {
        if (!byAccount.has(file.cloud_account_id)) byAccount.set(file.cloud_account_id, []);
        byAccount.get(file.cloud_account_id).push(file);
      }

      const results = [];
      const errors = [];

      for (const [accountId, accountFiles] of byAccount) {
        const dest = await resolveDestinationFolder(db, userId, destinationPath, accountId);
        if (!dest && destinationPath !== '/') {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Destination folder not found' });
          }
          continue;
        }

        let adapter;
        try {
          adapter = await getAdapterForAccount(accountId);
        } catch (e) {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Failed to initialize provider adapter' });
          }
          continue;
        }
        if (!adapter) {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Provider adapter not available' });
          }
          continue;
        }

        if (typeof adapter.moveFile !== 'function') {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Move not supported by this provider' });
          }
          continue;
        }

        for (const file of accountFiles) {
          try {
            await adapter.moveFile(file, dest?.remoteFileId || null);
            const newVirtualPath = dest ? dest.virtualPath : '/';
            const newRemoteParentId = dest?.remoteFileId || null;
            await db.prepare(`
              UPDATE file_metadata SET virtual_path = ?, remote_parent_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ? AND id = ?
            `).run(newVirtualPath, newRemoteParentId, userId, file.id);
            results.push({ id: file.id, success: true });
          } catch (e) {
            errors.push({ id: file.id, error: e.message });
          }
        }
      }

      return res.json({ data: { success: true, moved: results.length, errors } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/bulk/copy
  router.post('/files/bulk/copy', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { ids, destinationPath } = body;

      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
      if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });

      const placeholders = ids.map(() => '?').join(', ');
      const { results: files } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id IN (${placeholders}) AND ca.status = 'active'
      `).all(userId, ...ids);

      if (!files.length) {
        return res.status(404).json({ error: 'No files found' });
      }

      const byAccount = new Map();
      for (const file of files) {
        if (!byAccount.has(file.cloud_account_id)) byAccount.set(file.cloud_account_id, []);
        byAccount.get(file.cloud_account_id).push(file);
      }

      const results = [];
      const errors = [];

      for (const [accountId, accountFiles] of byAccount) {
        const dest = await resolveDestinationFolder(db, userId, destinationPath, accountId);
        if (!dest && destinationPath !== '/') {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Destination folder not found' });
          }
          continue;
        }

        let adapter;
        try {
          adapter = await getAdapterForAccount(accountId);
        } catch (e) {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Failed to initialize provider adapter' });
          }
          continue;
        }
        if (!adapter) {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Provider adapter not available' });
          }
          continue;
        }

        if (typeof adapter.copyFile !== 'function') {
          for (const file of accountFiles) {
            errors.push({ id: file.id, error: 'Copy not supported by this provider' });
          }
          continue;
        }

        for (const file of accountFiles) {
          try {
            const copyResult = await adapter.copyFile(file, dest?.remoteFileId || null);
            const newVirtualPath = dest ? dest.virtualPath : '/';
            const newRemoteParentId = dest?.remoteFileId || null;
            const newId = randomUUID();
            await db.prepare(`
              INSERT INTO file_metadata (
                id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
                cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
              ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(
              newId, userId, newVirtualPath, file.file_name, file.is_folder,
              file.size, file.mime_type, file.cloud_account_id,
              copyResult?.remoteFileId || `copy-${randomUUID()}`, newRemoteParentId
            );
            results.push({ id: newId, success: true });
          } catch (e) {
            errors.push({ id: file.id, error: e.message });
          }
        }
      }

      return res.json({ data: { success: true, copied: results.length, errors } });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/:id/shared-children — needs adapter
  router.get('/files/:id/shared-children', async (req, res, next) => {
    try {
      return res.status(501).json({ error: 'Shared folder children requires provider adapters' });
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/files/:id/star
  router.patch('/files/:id/star', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const fileId = req.params.id;
      const body = await readJsonBody(req);
      const isStarred = Boolean(body.is_starred ?? body.isStarred ?? true);

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, fileId);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      await db.prepare(`
        UPDATE file_metadata SET is_starred = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id = ?
      `).run(isStarred ? 1 : 0, userId, fileId);

      return res.json({ data: { success: true, is_starred: isStarred, provider_sync: false } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/:id/move
  router.post('/files/:id/move', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const fileId = req.params.id;
      const body = await readJsonBody(req);
      const { destinationPath } = body;

      if (!destinationPath?.trim()) {
        return res.status(400).json({ error: 'destinationPath is required' });
      }

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, fileId);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = results[0];

      const dest = await resolveDestinationFolder(db, userId, destinationPath, file.cloud_account_id);
      if (!dest && destinationPath !== '/') {
        return res.status(404).json({ error: 'Destination folder not found' });
      }

      let adapter;
      try {
        adapter = await getAdapterForAccount(file.cloud_account_id);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to initialize provider adapter' });
      }
      if (!adapter) {
        return res.status(502).json({ error: 'Provider adapter not available' });
      }

      if (typeof adapter.moveFile !== 'function') {
        return res.status(501).json({ error: 'Move not supported by this provider' });
      }

      try {
        await adapter.moveFile(file, dest?.remoteFileId || null);
      } catch (e) {
        return res.status(502).json({ error: `Move failed: ${e.message}` });
      }

      const newVirtualPath = dest ? dest.virtualPath : '/';
      const newRemoteParentId = dest?.remoteFileId || null;
      await db.prepare(`
        UPDATE file_metadata SET virtual_path = ?, remote_parent_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id = ?
      `).run(newVirtualPath, newRemoteParentId, userId, fileId);

      return res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/:id/copy
  router.post('/files/:id/copy', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const fileId = req.params.id;
      const body = await readJsonBody(req);
      const { destinationPath } = body;

      if (!destinationPath?.trim()) {
        return res.status(400).json({ error: 'destinationPath is required' });
      }

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, fileId);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = results[0];

      const dest = await resolveDestinationFolder(db, userId, destinationPath, file.cloud_account_id);
      if (!dest && destinationPath !== '/') {
        return res.status(404).json({ error: 'Destination folder not found' });
      }

      let adapter;
      try {
        adapter = await getAdapterForAccount(file.cloud_account_id);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to initialize provider adapter' });
      }
      if (!adapter) {
        return res.status(502).json({ error: 'Provider adapter not available' });
      }

      if (typeof adapter.copyFile !== 'function') {
        return res.status(501).json({ error: 'Copy not supported by this provider' });
      }

      let copyResult;
      try {
        copyResult = await adapter.copyFile(file, dest?.remoteFileId || null);
      } catch (e) {
        return res.status(502).json({ error: `Copy failed: ${e.message}` });
      }

      const newVirtualPath = dest ? dest.virtualPath : '/';
      const newRemoteParentId = dest?.remoteFileId || null;
      const newId = randomUUID();
      await db.prepare(`
        INSERT INTO file_metadata (
          id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
          cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        newId, userId, newVirtualPath, file.file_name, file.is_folder,
        file.size, file.mime_type, file.cloud_account_id,
        copyResult?.remoteFileId || `copy-${randomUUID()}`, newRemoteParentId
      );

      return res.json({ data: { success: true, id: newId } });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/:id
  router.get('/files/:id', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, req.params.id);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      return res.json({ data: buildDisplayNames(results)[0] });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/:id/download
  router.get('/files/:id/download', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const fileId = req.params.id;

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, fileId);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = results[0];
      if (file.is_folder) {
        return res.status(400).json({ error: 'Cannot download a folder' });
      }

      let adapter;
      try {
        adapter = await getAdapterForAccount(file.cloud_account_id);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to initialize provider adapter' });
      }
      if (!adapter) {
        return res.status(502).json({ error: 'Provider adapter not available' });
      }

      let stream;
      try {
        stream = await adapter.getDownloadStream(file);
      } catch (e) {
        return res.status(502).json({ error: `Provider download failed: ${e.message}` });
      }

      const buffer = await collectStream(stream);
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/:id/preview
  router.get('/files/:id/preview', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const fileId = req.params.id;

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, fileId);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = results[0];
      if (file.is_folder) {
        return res.status(400).json({ error: 'Cannot preview a folder' });
      }

      if (!isPreviewable(file.mime_type)) {
        return res.status(415).json({ error: 'File type not previewable' });
      }

      let adapter;
      try {
        adapter = await getAdapterForAccount(file.cloud_account_id);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to initialize provider adapter' });
      }
      if (!adapter) {
        return res.status(502).json({ error: 'Provider adapter not available' });
      }

      let stream;
      try {
        stream = await adapter.getDownloadStream(file);
      } catch (e) {
        return res.status(502).json({ error: `Provider download failed: ${e.message}` });
      }

      const buffer = await collectStream(stream);
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/files/:id/rename
  router.patch('/files/:id/rename', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { name } = body;

      if (!name?.trim()) {
        return res.status(400).json({ error: 'New name is required' });
      }

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, req.params.id);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      await db.prepare(`
        UPDATE file_metadata SET file_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id = ?
      `).run(name.trim(), userId, req.params.id);

      return res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/files/:id — soft delete single file
  router.delete('/files/:id', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;

      const { results } = await db.prepare(`
        SELECT fm.*, ca.provider, ca.email
        FROM file_metadata fm
        INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
      `).all(userId, req.params.id);

      if (!results.length) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = results[0];
      const deletedAt = new Date().toISOString();

      await db.prepare(`
        INSERT OR IGNORE INTO trash (
          id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
          virtual_path, file_name, is_folder, size, mime_type,
          remote_created_time, remote_modified_time, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), userId, file.cloud_account_id, file.remote_file_id,
        file.remote_parent_id, file.virtual_path, file.file_name,
        file.is_folder, file.size, file.mime_type,
        file.remote_created_time, file.remote_modified_time, deletedAt
      );

      await db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?').run(userId, req.params.id);

      return res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/folders — create folder
  router.post('/files/folders', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const body = await readJsonBody(req);
      const { name, path: parentPath, cloudAccountId } = body;

      if (!name?.trim()) {
        return res.status(400).json({ error: 'Folder name is required' });
      }

      const normalizedParent = normalizePath(parentPath || '/');

      let account;
      if (cloudAccountId) {
        account = await db.prepare(
          'SELECT * FROM cloud_accounts WHERE id = ? AND user_id = ? AND status = ?'
        ).get(cloudAccountId, userId, 'active');
      } else {
        const { results: siblings } = await db.prepare(`
          SELECT ca.* FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ? AND fm.virtual_path = ? AND ca.status = 'active'
          LIMIT 1
        `).all(userId, normalizedParent);
        account = siblings[0] || null;
        if (!account) {
          account = await db.prepare(
            'SELECT * FROM cloud_accounts WHERE user_id = ? AND status = ? LIMIT 1'
          ).get(userId, 'active');
        }
      }

      if (!account) {
        return res.status(400).json({ error: 'No active cloud account found' });
      }

      let adapter;
      try {
        adapter = await getAdapterForAccount(account.id);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to initialize provider adapter' });
      }
      if (!adapter) {
        return res.status(502).json({ error: 'Provider not supported' });
      }

      let remoteParentId = null;
      if (normalizedParent !== '/') {
        const dest = await resolveDestinationFolder(db, userId, normalizedParent, account.id);
        if (dest) remoteParentId = dest.remoteFileId;
      }

      let result;
      try {
        result = await adapter.createFolder({ name: name.trim(), virtualPath: normalizedParent, remoteParentId });
      } catch (e) {
        return res.status(502).json({ error: `Folder creation failed: ${e.message}` });
      }

      const newId = randomUUID();
      await db.prepare(`
        INSERT INTO file_metadata (
          id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
          cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
        ) VALUES (?, ?, ?, ?, 1, 0, 0, NULL, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        newId, userId, normalizedParent, name.trim(), account.id,
        result.remoteFileId, result.remoteParentId || remoteParentId
      );

      return res.json({ data: { id: newId, file_name: name.trim(), virtual_path: normalizedParent } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
