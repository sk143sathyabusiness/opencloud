import { env } from '../config/env.js';
import { listAllFiles } from './fileService.js';
import { createAdapter } from './adapterRegistry.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
export const TELEGRAM_MAX_FILE_SIZE = 50 * 1024 * 1024;
export const TELEGRAM_NOT_CONFIGURED =
	'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in backend/.env';

function assertConfigured() {
	if (!env.telegramBotToken || !env.telegramChatId) {
		throw new Error(TELEGRAM_NOT_CONFIGURED);
	}
}

function telegramUrl(method) {
	return `${TELEGRAM_API_BASE}${env.telegramBotToken}/${method}`;
}

function formatBytes(bytes) {
	if (Number.isFinite(bytes) && bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (Number.isFinite(bytes) && bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${bytes || 0} B`;
}

async function tgJsonCall(method, payload = {}) {
	assertConfigured();
	const response = await fetch(telegramUrl(method), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const json = await response.json().catch(() => ({
		ok: false,
		description: `Telegram API request failed (HTTP ${response.status})`,
	}));
	if (!json.ok) {
		throw new Error(json.description || `Telegram API request ${method} failed`);
	}
	return json.result;
}

async function streamToBuffer(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function sendDocument({ fileName, buffer, mimeType = 'application/octet-stream', caption = '' }) {
	assertConfigured();

	if (buffer.length > TELEGRAM_MAX_FILE_SIZE) {
		throw new Error(
			`${fileName ?? 'File'} is ${formatBytes(buffer.length)} and exceeds the Telegram 50 MB upload limit`,
		);
	}

	const form = new FormData();
	form.append('chat_id', env.telegramChatId);
	form.append('document', new Blob([buffer], { type: mimeType }), fileName);
	form.append('disable_notification', 'true');
	if (caption) form.append('caption', caption);

	const response = await fetch(telegramUrl('sendDocument'), {
		method: 'POST',
		body: form,
	});
	const json = await response.json().catch(() => ({
		ok: false,
		description: `Telegram send failed (HTTP ${response.status})`,
	}));
	if (!json.ok) {
		throw new Error(json.description || 'Telegram send failed');
	}
	return json.result;
}

export async function getTelegramStatus() {
	if (!env.telegramBotToken || !env.telegramChatId) {
		return {
			configured: false,
			connected: false,
			bot: null,
			chat: null,
			error: TELEGRAM_NOT_CONFIGURED,
		};
	}

	try {
		const me = await tgJsonCall('getMe');
		let chat = null;
		try {
			const chatResult = await tgJsonCall('getChat', { chat_id: env.telegramChatId });
			chat = {
				id: chatResult.id,
				title: chatResult.title || chatResult.username || String(env.telegramChatId),
				type: chatResult.type,
			};
		} catch (chatError) {
			throw new Error(`Channel check failed: ${chatError.message}`);
		}
		return {
			configured: true,
			connected: true,
			bot: me.username || null,
			chat,
			error: null,
		};
	} catch (error) {
		return {
			configured: true,
			connected: false,
			bot: null,
			chat: null,
			error: error.message,
		};
	}
}

export async function backupFileToTelegram(file, account) {
	if (file?.is_folder) {
		throw new Error('Folders cannot be backed up to Telegram');
	}

	const size = Number(file?.size || 0);
	if (size > TELEGRAM_MAX_FILE_SIZE) {
		throw new Error(
			`${file?.file_name ?? 'File'} is ${formatBytes(size)} and exceeds the Telegram 50 MB upload limit`,
		);
	}

	const adapter = createAdapter(account);
	const stream = await adapter.getDownloadStream(file);
	const buffer = await streamToBuffer(stream);

	const result = await sendDocument({
		fileName: file.file_name || `opencloud-backup-${Date.now()}`,
		mimeType: file.mime_type || 'application/octet-stream',
		buffer,
		caption: `OpenCloud backup: ${file.file_name || 'file'}`,
	});

	return {
		sent: true,
		fileName: file.file_name,
		size: buffer.length,
		messageId: result.message_id,
	};
}

export async function backupMetadataToTelegram(userId) {
	const files = listAllFiles(userId);
	const date = new Date().toISOString().slice(0, 10);
	const fileName = `opencloud-metadata-backup-${date}.json`;
	const snapshot = {
		app: 'OpenCloud',
		type: 'metadata-backup',
		generated_at: new Date().toISOString(),
		file_count: files.length,
		files: files.map((file) => ({
			id: file.id,
			virtual_path: file.virtual_path,
			file_name: file.file_name,
			is_folder: Boolean(file.is_folder),
			size: Number(file.size || 0),
			mime_type: file.mime_type || null,
			cloud_account_id: file.cloud_account_id,
			remote_file_id: file.remote_file_id,
		})),
	};

	const buffer = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
	const result = await sendDocument({
		fileName,
		mimeType: 'application/json',
		buffer,
		caption: `OpenCloud metadata backup · ${files.length} files`,
	});

	return {
		sent: true,
		fileName,
		fileCount: files.length,
		size: buffer.length,
		messageId: result.message_id,
	};
}