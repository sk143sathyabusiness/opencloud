import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAppUser } from '../middleware.js';

export function createHealthRouter() {
  const router = Router();

  router.get('/health', async (req, res, next) => {
    try {
      const db = getDb();
      const row = await db.prepare('SELECT 1').get();
      res.json({
        status: 'ok',
        db: Boolean(row),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'error',
        db: false,
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  });

  router.get('/health/detailed', async (req, res, next) => {
    try {
      const db = getDb();
      const row = await db.prepare('SELECT 1').get();
      const dbOk = Boolean(row);

      const tableNames = [
        'users',
        'auth_sessions',
        'cloud_accounts',
        'file_metadata',
        'user_settings',
        'trash',
        'share_links',
        'upload_sessions',
        'upload_chunks',
      ];

      const tableCounts = {};
      for (const table of tableNames) {
        try {
          const countRow = await db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get();
          tableCounts[table] = countRow?.cnt ?? 0;
        } catch {
          tableCounts[table] = -1;
        }
      }

      res.json({
        status: dbOk ? 'ok' : 'error',
        db: dbOk,
        tableCounts,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'error',
        db: false,
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  });

  router.post('/sync/:accountId', requireAppUser, async (req, res, next) => {
    try {
      const db = getDb();
      const { accountId } = req.params;
      const userId = req.user.id;

      const account = await db.prepare(
        'SELECT * FROM cloud_accounts WHERE id = ? AND user_id = ?'
      ).get(accountId, userId);

      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }

      res.json({
        status: 'pending',
        accountId: account.id,
        provider: account.provider,
        message: 'Sync queued — full adapter integration pending (SP-5)',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sync/:accountId/status', requireAppUser, async (req, res, next) => {
    try {
      const db = getDb();
      const { accountId } = req.params;
      const userId = req.user.id;

      const account = await db.prepare(
        'SELECT id, provider, status, updated_at FROM cloud_accounts WHERE id = ? AND user_id = ?'
      ).get(accountId, userId);

      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }

      res.json({
        accountId: account.id,
        provider: account.provider,
        status: account.status,
        lastSyncAt: account.updated_at,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
