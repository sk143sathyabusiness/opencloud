import { Router } from 'express';
import { setEnv } from '../../backend/src/config/env.js';
import { envStore, getDb } from '../db.js';
import { runDeltaSync, syncAccount, getLastSyncReport } from '../services/syncService.js';

export function createSyncRouter() {
  const router = Router();

  router.post('/sync/run', async (req, res) => {
    try {
      const storeEnv = envStore.getStore();
      setEnv(storeEnv);
      const userId = req.userId || req.user?.id || 'local-default-user';
      const report = await runDeltaSync(userId, storeEnv);
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sync/status', (req, res) => {
    const report = getLastSyncReport();
    res.json(report);
  });

  router.post('/sync/:accountId', async (req, res) => {
    try {
      const storeEnv = envStore.getStore();
      setEnv(storeEnv);
      const userId = req.userId || req.user?.id || 'local-default-user';
      const db = getDb();
      const account = await db.prepare(
        'SELECT * FROM cloud_accounts WHERE id = ? AND user_id = ?'
      ).get(req.params.accountId, userId);
      if (!account) return res.status(404).json({ error: 'Account not found' });

      const result = await syncAccount(userId, account, storeEnv);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
