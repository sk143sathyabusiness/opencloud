import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { requireAppUser } from '../middleware.js';

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

  // POST /api/files/bulk/download — return 501 for now (complex streaming ZIP)
  router.post('/files/bulk/download', (req, res) => {
    res.status(501).json({ error: 'Bulk download requires streaming ZIP support, not yet implemented on Workers' });
  });

  // POST /api/files/bulk/move
  router.post('/files/bulk/move', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { ids, destinationPath } = body;
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
      if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
      return res.status(501).json({ error: 'Bulk move requires provider adapters' });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/bulk/copy
  router.post('/files/bulk/copy', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { ids, destinationPath } = body;
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids are required' });
      if (!destinationPath?.trim()) return res.status(400).json({ error: 'destinationPath is required' });
      return res.status(501).json({ error: 'Bulk copy requires provider adapters' });
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
      return res.status(501).json({ error: 'File move requires provider adapters' });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/files/:id/copy
  router.post('/files/:id/copy', async (req, res, next) => {
    try {
      return res.status(501).json({ error: 'File copy requires provider adapters' });
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

  // GET /api/files/:id/download — needs adapter
  router.get('/files/:id/download', async (req, res, next) => {
    try {
      return res.status(501).json({ error: 'File download requires provider adapters' });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/files/:id/preview — needs adapter
  router.get('/files/:id/preview', async (req, res, next) => {
    try {
      return res.status(501).json({ error: 'File preview requires provider adapters' });
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

  // POST /api/files/folders — create folder (needs adapter)
  router.post('/files/folders', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { name } = body;
      if (!name?.trim()) {
        return res.status(400).json({ error: 'Folder name is required' });
      }
      return res.status(501).json({ error: 'Folder creation requires provider adapters' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
