import cron from 'node-cron';
import { env } from '../config/env.js';
import { LOCAL_USER_ID } from '../config/database.js';
import { getActiveAccounts, markAccountStatus, updateAccountStorage } from './accountService.js';
import { createAdapter } from './adapterRegistry.js';
import { clearFilesForAccount, replaceFilesForAccount } from './fileService.js';
import { getExpiredTrashRows, removeTrashedRows, getTrashUserIds } from './trashService.js';
import { isAuthError, withRetry } from '../utils/providerErrors.js';

async function fetchAccountSnapshot(account) {
	return withRetry(
		async () => {
			const adapter = createAdapter(account);
			const remoteFiles = await adapter.fetchStructure();
			const storage = await adapter.getStorageSummary();
			return { remoteFiles, storage };
		},
		{
			retries: 3,
			onRetry: (error, attempt) => {
				console.warn(
					`Transient sync error for ${account.email} (attempt ${attempt}), retrying:`,
					error?.message || error,
				);
			},
		},
	);
}

function handleSyncFailure(account, error) {
	if (isAuthError(error)) {
		clearFilesForAccount(account.user_id, account.id);
		markAccountStatus(account.user_id, account.id, 'invalid_token');
		console.error(`Auth error for account ${account.email}, marked invalid_token:`, error.message);
		return;
	}

	console.error(
		`Transient sync failure for account ${account.email} (kept connected):`,
		error.message,
	);
}

let lastSyncReport = {
	lastRunAt: null,
	userId: null,
	scannedAccounts: 0,
	changesDetected: 0,
};

let activeSyncPromise = null;

export async function runDeltaSync(userId) {
	if (activeSyncPromise) {
		return activeSyncPromise;
	}

	activeSyncPromise = (async () => {
		const accounts = getActiveAccounts(userId);
		let changesDetected = 0;

		for (const account of accounts) {
			try {
				const { remoteFiles, storage } = await fetchAccountSnapshot(account);

				replaceFilesForAccount(userId, account.id, remoteFiles);
				updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);
				changesDetected += remoteFiles.length;
			} catch (error) {
				handleSyncFailure(account, error);
			}
		}

		lastSyncReport = {
			lastRunAt: new Date().toISOString(),
			userId,
			scannedAccounts: accounts.length,
			changesDetected,
		};

		return lastSyncReport;
	})();

	try {
		return await activeSyncPromise;
	} finally {
		activeSyncPromise = null;
	}
}

export function scheduleSync() {
	const interval = Math.max(1, env.syncIntervalMinutes);
	cron.schedule(`*/${interval} * * * *`, () => {
		if (env.appMode !== 'local') {
			return;
		}
		runDeltaSync(LOCAL_USER_ID).catch((error) => {
			console.error('Delta sync failed:', error);
		});
	});
	scheduleTrashPurge();
}

export async function purgeExpiredTrash(userId) {
	const cutoff = new Date(Date.now() - env.trashRetentionDays * 24 * 60 * 60 * 1000).toISOString();
	const rows = getExpiredTrashRows(userId, cutoff);
	if (!rows.length) {
		return { purged: 0, errors: [] };
	}

	const accounts = getActiveAccounts(userId);
	const adapterByAccount = new Map(accounts.map((account) => [account.id, createAdapter(account)]));
	const errors = [];
	for (const row of rows) {
		const adapter = adapterByAccount.get(row.cloud_account_id);
		try {
			if (adapter) {
				await adapter.deleteFile({
					remote_file_id: row.remote_file_id,
					file_name: row.file_name,
					is_folder: Boolean(row.is_folder),
				});
			}
		} catch (error) {
			errors.push({ id: row.id, error: error.message });
		}
	}
	removeTrashedRows(userId, rows.map((row) => row.id));
	return { purged: rows.length, errors };
}

export function scheduleTrashPurge() {
	cron.schedule('0 3 * * *', async () => {
		if (env.appMode === 'local') {
			await purgeExpiredTrash(LOCAL_USER_ID).catch((error) => {
				console.error('Trash purge failed:', error.message);
			});
			return;
		}
		const userIds = getTrashUserIds();
		for (const userId of userIds) {
			await purgeExpiredTrash(userId).catch((error) => {
				console.error(`Trash purge failed for ${userId}:`, error.message);
			});
		}
	});
}

export function getLastSyncReport() {
	return {
		...lastSyncReport,
		isRunning: Boolean(activeSyncPromise),
	};
}

export async function syncAccount(userId, account) {
	try {
		const { remoteFiles, storage } = await fetchAccountSnapshot(account);

		replaceFilesForAccount(userId, account.id, remoteFiles);
		updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);

		return {
			accountId: account.id,
			filesSynced: remoteFiles.length,
			totalSpace: storage.totalSpace,
			usedSpace: storage.usedSpace,
		};
	} catch (error) {
		handleSyncFailure(account, error);
		throw error;
	}
}
