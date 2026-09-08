import { Router } from 'express';
import { getDb, envStore } from '../db.js';

export function createHealthRouter() {
  const router = Router();

  router.get('/health', async (req, res, next) => {
    try {
      const db = getDb();
      const row = await db.prepare('SELECT 1').get();
      const dbOk = Boolean(row);
      const env = envStore.getStore();

      let accountCount = 0;
      try {
        accountCount = (await db.prepare(
          "SELECT COUNT(*) as cnt FROM cloud_accounts WHERE user_id = ? AND status = 'active'"
        ).get(req.user?.id || 'local'))?.cnt ?? 0;
      } catch {}

      let syncEnabled = true;
      try {
        const syncRows = await db.prepare(
          "SELECT value FROM user_settings WHERE user_id = ? AND key = 'sync_enabled'"
        ).all(req.user?.id || 'local');
        if (syncRows.results?.length) syncEnabled = syncRows.results[0].value === 'true';
      } catch {}

      res.json({
        status: dbOk ? 'ok' : 'error',
        service: 'omnicloud',
        config: {
          appMode: env?.APP_MODE || 'unknown',
          providers: ['google_drive', 'onedrive', 'dropbox', 'yandex', 's3', 'pcloud'],
        },
        auth: { authenticated: Boolean(req.user) },
        sync: {
          enabled: syncEnabled,
          intervalMinutes: env?.SYNC_INTERVAL_MINUTES ? Number(env.SYNC_INTERVAL_MINUTES) : 5,
        },
        db: dbOk,
        accounts: accountCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'error',
        service: 'omnicloud',
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
