import express from 'express';
import { attachAuthContext, requireAppUser } from './middleware.js';
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

  return app;
}
