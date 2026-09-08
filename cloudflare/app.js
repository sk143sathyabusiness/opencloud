import express from 'express';
import { attachAuthContext, requireAppUser, corsHeaders } from './middleware.js';

let _env = {};
try {
  const envMod = await import('../backend/src/config/env.js');
  _env = envMod.env || {};
} catch {}
import { createAuthRouter } from './routes/auth.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createFilesRouter } from './routes/files.js';
import { createUploadsRouter } from './routes/uploads.js';
import { createSettingsRouter } from './routes/settings.js';
import { createAllocationRouter } from './routes/allocation.js';
import { createShareRouter } from './routes/share.js';
import { createHealthRouter } from './routes/health.js';
import { createSyncRouter } from './routes/sync.js';
import { createTelegramRouter } from './routes/telegram.js';

export function createApp() {
  const app = express();

  app.use(attachAuthContext);

  // CORS middleware
  app.use((req, res, next) => {
    const origin = _env.corsOrigin || '*';
    const headers = corsHeaders(origin);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use('/api', createHealthRouter());
  app.use('/api', createAuthRouter());
  app.use('/api', createAccountsRouter());
  app.use('/api', createFilesRouter());
  app.use('/api', createUploadsRouter());
  app.use('/api', createSettingsRouter());
  app.use('/api', createAllocationRouter());
  app.use('/api', createShareRouter());
  app.use('/api', createSyncRouter());
  app.use('/api', createTelegramRouter());

  // Global error handler
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}
