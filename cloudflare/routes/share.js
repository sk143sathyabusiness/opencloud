import { Router } from 'express';
import { getDb } from '../db.js';
import { generateToken, hashToken, verifyPassword as cryptoVerifyPassword, hashPassword as cryptoHashPassword } from '../../backend/src/config/crypto.js';
import { requireAppUser } from '../middleware.js';

function linkUrl(token) {
  return `/s/${token}`;
}

async function createShareLink({ userId, fileId, accountId, remoteFileId, fileName, size, mimeType, isFolder, expiresInDays = 7, password }) {
  const token = await generateToken();
  const tokenHash = await hashToken(token);
  const days = Number(expiresInDays);
  const expiresAt = days === 0
    ? null
    : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  let passwordHash = null;
  if (password) {
    const { hash, salt } = await cryptoHashPassword(password);
    passwordHash = `${salt}:${hash}`;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO share_links (
      id, user_id, file_id, cloud_account_id, remote_file_id,
      file_name, size, mime_type, is_folder,
      token, password_hash, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, fileId, accountId, remoteFileId, fileName, Number(size || 0), mimeType || null, isFolder ? 1 : 0, tokenHash, passwordHash, expiresAt);

  return { token, url: linkUrl(token), expiresAt };
}

async function listShareLinks(userId) {
  const db = getDb();
  const rows = await db.prepare('SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const results = rows.results || rows;
  return results.map((row) => ({
    ...row,
    url: `/s/${row.token}`,
    expired: Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now()),
  }));
}

async function revokeShareLink(userId, token) {
  const db = getDb();
  const tokenHash = await hashToken(token);
  const result = await db.prepare('DELETE FROM share_links WHERE user_id = ? AND token = ?').run(userId, tokenHash);
  return { revoked: result.meta?.changes ?? result.changes ?? 0 };
}

async function getShareLinkByToken(token) {
  const db = getDb();
  const tokenHash = await hashToken(token);
  const row = await db.prepare('SELECT * FROM share_links WHERE token = ?').get(tokenHash);
  if (!row) return null;
  return {
    ...row,
    token,
    expired: Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now()),
  };
}

async function touchShareLink(token) {
  const db = getDb();
  const tokenHash = await hashToken(token);
  await db.prepare(`
    UPDATE share_links
    SET download_count = download_count + 1, last_used_at = CURRENT_TIMESTAMP
    WHERE token = ?
  `).run(tokenHash);
}

export function createShareRouter() {
  const router = Router();

  router.post('/share', requireAppUser, async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const { fileId, accountId, remoteFileId, fileName, size, mimeType, isFolder, expiresInDays, password } = body;

      if (!fileId) {
        return res.status(400).json({ error: 'fileId is required' });
      }

      if (isFolder) {
        return res.status(400).json({ error: 'Folders are not shareable' });
      }

      const link = await createShareLink({
        userId: req.user.id,
        fileId,
        accountId,
        remoteFileId,
        fileName,
        size,
        mimeType,
        isFolder,
        expiresInDays,
        password,
      });

      return res.status(201).json({ data: link });
    } catch (error) {
      next(error);
    }
  });

  router.get('/share', requireAppUser, async (req, res, next) => {
    try {
      const links = await listShareLinks(req.user.id);
      return res.json({ data: links });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/share/:token', requireAppUser, async (req, res, next) => {
    try {
      const result = await revokeShareLink(req.user.id, req.params.token);
      return res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/share/:token/info', async (req, res, next) => {
    try {
      const link = await getShareLinkByToken(req.params.token);
      if (!link || link.expired || link.is_folder) {
        return res.status(404).json({ error: 'Link not found' });
      }
      return res.json({
        data: {
          file_name: link.file_name,
          size: link.size,
          mime_type: link.mime_type,
          expires_at: link.expires_at,
          created_at: link.created_at,
          download_count: link.download_count,
          has_password: Boolean(link.password_hash),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/share/:token/download', async (req, res, next) => {
    try {
      const link = await getShareLinkByToken(req.params.token);
      if (!link || link.expired || link.is_folder) {
        return res.status(404).json({ error: 'Link not found' });
      }

      if (link.password_hash) {
        const provided = req.get('x-link-password') || '';
        const [salt, storedHash] = link.password_hash.split(':');
        const valid = await cryptoVerifyPassword(provided, storedHash, salt);
        if (!valid) {
          return res.status(401).json({ error: 'Wrong or missing link password' });
        }
      }

      // Provider adapters not yet ported — return 501
      return res.status(501).json({ error: 'Download not yet supported — provider adapters not implemented' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
