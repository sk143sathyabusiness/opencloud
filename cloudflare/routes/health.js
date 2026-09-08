import { Router } from 'express';
import { getDb } from '../db.js';

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

  return router;
}
