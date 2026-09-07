import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { getFileById } from '../services/fileService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { getTelegramStatus, backupFileToTelegram, backupMetadataToTelegram } from '../services/telegramService.js';

const router = Router();

router.use(requireAppUser);

function decodeSharedFileId(fileId) {
	if (!fileId?.startsWith('shared:')) return null;
	const [, accountId, encodedRemoteFileId] = fileId.split(':');
	if (!accountId || !encodedRemoteFileId) return null;
	return {
		accountId,
		remoteFileId: Buffer.from(encodedRemoteFileId, 'base64url').toString('utf8'),
	};
}

async function getFileContext(userId, fileId) {
	const file = getFileById(userId, fileId);
	if (file) {
		const account = getAccountById(userId, file.cloud_account_id);
		return { file, account, adapter: account ? createAdapter(account) : null };
	}

	const parsed = decodeSharedFileId(fileId);
	if (!parsed) {
		return { file: null, account: null, adapter: null };
	}

	const account = getAccountById(userId, parsed.accountId);
	if (!account) {
		return { file: null, account: null, adapter: null };
	}

	const adapter = createAdapter(account);
	let sharedFile = null;
	try {
		const details = await adapter.getFileDetails({ remote_file_id: parsed.remoteFileId });
		if (details?.remote_file_id) {
			sharedFile = {
				file_name: details.file_name || details.name || 'file',
				is_folder: Boolean(details.is_folder),
				size: Number(details.size || 0),
				mime_type: details.mime_type || details.mimeType || null,
				remote_file_id: details.remote_file_id,
				remote_parent_id: details.remote_parent_id || null,
				remote_drive_id: details.remote_drive_id || null,
				cloud_account_id: account.id,
			};
		}
	} catch {
		sharedFile = null;
	}

	return { file: sharedFile, account, adapter };
}

function ensureFileContext(context, res) {
	if (!context.file) {
		res.status(404).json({ error: 'File not found' });
		return false;
	}

	if (!context.account || context.account.status !== 'active' || !context.adapter) {
		res.status(409).json({ error: 'The file account is no longer connected' });
		return false;
	}

	return true;
}

router.get('/telegram/status', async (req, res, next) => {
	try {
		res.json({ data: await getTelegramStatus() });
	} catch (error) {
		next(error);
	}
});

router.post('/telegram/backup-file', async (req, res, next) => {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).json({ error: 'fileId is required' });
		}

		const context = await getFileContext(req.user.id, fileId);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (context.file.is_folder) {
			return res.status(400).json({ error: 'Folders cannot be backed up to Telegram' });
		}

		const data = await backupFileToTelegram(context.file, context.account);
		return res.json({ data });
	} catch (error) {
		next(error);
	}
});

router.post('/telegram/backup-metadata', async (req, res, next) => {
	try {
		res.json({ data: await backupMetadataToTelegram(req.user.id) });
	} catch (error) {
		next(error);
	}
});

export default router;