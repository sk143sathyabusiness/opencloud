import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAppUser } from '../middleware.js';

const VALID_KEYS = ['language', 'theme'];

export function createSettingsRouter() {
  const router = Router();
  router.use(requireAppUser);

  router.get('/settings', async (req, res, next) => {
    try {
      const db = getDb();
      const rows = await db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id);
      const settings = {};
      for (const row of rows.results || rows) {
        settings[row.key] = row.value;
      }
      res.json({ settings });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/settings', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const db = getDb();
      const updated = {};

      for (const [key, value] of Object.entries(body)) {
        if (VALID_KEYS.includes(key)) {
          await db.prepare(`
            INSERT INTO user_settings (id, user_id, key, value, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, key) DO UPDATE SET
              value = excluded.value,
              updated_at = CURRENT_TIMESTAMP
          `).run(crypto.randomUUID(), req.user.id, key, value);
          updated[key] = value;
        }
      }

      res.json({ data: updated });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
