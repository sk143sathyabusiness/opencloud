import { Router } from 'express';
import { envStore, getDb } from '../db.js';
import { getTelegramStatus, backupFileToTelegram, backupMetadataToTelegram } from '../services/telegramService.js';
import { createAdapter as defaultCreateAdapter } from '../adapters/registry.js';

export function createTelegramRouter(adapterFactory) {
  const router = Router();
  const createAdapterFn = adapterFactory || defaultCreateAdapter;

  router.get('/telegram/status', async (req, res) => {
    try {
      const env = envStore.getStore();
      const status = await getTelegramStatus(env);
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/telegram/backup-file', async (req, res) => {
    try {
      const env = envStore.getStore();
      const body = await req._webRequest.json();
      const { fileId } = body;

      const db = getDb();
      const file = await db.prepare('SELECT * FROM file_metadata WHERE id = ?').get(fileId);
      if (!file) return res.status(404).json({ error: 'File not found' });

      const account = await db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(file.cloud_account_id);
      if (!account) return res.status(404).json({ error: 'Account not found' });

      const adapter = await createAdapterFn(account.provider, account, env);
      const result = await backupFileToTelegram(file, adapter, env);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/telegram/backup-metadata', async (req, res) => {
    try {
      const env = envStore.getStore();
      const userId = req.userId || req.user?.id || 'local-default-user';
      const result = await backupMetadataToTelegram(userId, env);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
