import { getDb } from '../db.js';
import { createAdapter as defaultCreateAdapter } from '../adapters/registry.js';
import { withRetry, isAuthError } from '../utils/providerErrors.js';
import { getActiveAccounts, updateAccountStorage, markAccountStatus } from './accountService.js';
import { replaceFilesForAccount, getTrashedRemoteIds } from './fileService.js';

let lastSyncReport = { lastRunAt: null, userId: null, scannedAccounts: 0, changesDetected: 0 };

export function getLastSyncReport() {
  return lastSyncReport;
}

export async function syncAccount(userId, account, env, adapterFactory) {
  const createAdapterFn = adapterFactory || defaultCreateAdapter;
  const adapter = await createAdapterFn(account.provider, account, env);

  const [structure, storage] = await Promise.all([
    withRetry(() => adapter.fetchStructure()),
    withRetry(() => adapter.getStorageSummary()),
  ]);

  // Filter out trashed items
  const trashedIds = await getTrashedRemoteIds(userId, account.id);
  const remoteFiles = structure.filter(f => !trashedIds.has(f.remoteFileId || f.remote_file_id));

  // Replace files for this account
  await replaceFilesForAccount(userId, account.id, remoteFiles);

  // Update storage
  if (storage) {
    await updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);
  }

  return { accountId: account.id, filesCount: remoteFiles.length, storage };
}

export async function runDeltaSync(userId, env, adapterFactory) {
  const createAdapterFn = adapterFactory || defaultCreateAdapter;
  const accounts = await getActiveAccounts(userId);
  let scannedAccounts = 0;
  let changesDetected = 0;

  for (const account of accounts) {
    try {
      await syncAccount(userId, account, env, createAdapterFn);
      scannedAccounts++;
      changesDetected++;
    } catch (error) {
      if (isAuthError(error)) {
        await markAccountStatus(userId, account.id, 'invalid_token');
        // Clear files for this account
        const db = getDb();
        await db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?')
          .run(userId, account.id);
      }
      // Transient errors: log and continue
      scannedAccounts++;
    }
  }

  lastSyncReport = {
    lastRunAt: new Date().toISOString(),
    userId,
    scannedAccounts,
    changesDetected,
  };

  return lastSyncReport;
}
