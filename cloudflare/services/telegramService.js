import { getDb } from '../db.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
export const TELEGRAM_MAX_FILE_SIZE = 50 * 1024 * 1024;
export const TELEGRAM_NOT_CONFIGURED =
  'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment variables';

function assertConfigured(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error(TELEGRAM_NOT_CONFIGURED);
  }
}

function telegramUrl(method, env) {
  return `${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/${method}`;
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

async function tgJsonCall(method, env, payload = {}) {
  assertConfigured(env);
  const response = await fetch(telegramUrl(method, env), {
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

export async function sendDocument({ fileName, buffer, mimeType = 'application/octet-stream', caption = '' }, env) {
  assertConfigured(env);

  if (buffer.byteLength > TELEGRAM_MAX_FILE_SIZE) {
    throw new Error(
      `${fileName ?? 'File'} is ${formatBytes(buffer.byteLength)} and exceeds the Telegram 50 MB upload limit`,
    );
  }

  const form = new FormData();
  form.append('chat_id', env.TELEGRAM_CHAT_ID);
  form.append('document', new Blob([buffer], { type: mimeType }), fileName);
  form.append('disable_notification', 'true');
  if (caption) form.append('caption', caption);

  const response = await fetch(telegramUrl('sendDocument', env), {
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

export async function getTelegramStatus(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return {
      configured: false,
      connected: false,
      bot: null,
      chat: null,
      error: TELEGRAM_NOT_CONFIGURED,
    };
  }

  try {
    const me = await tgJsonCall('getMe', env);
    let chat = null;
    try {
      const chatResult = await tgJsonCall('getChat', env, { chat_id: env.TELEGRAM_CHAT_ID });
      chat = {
        id: chatResult.id,
        title: chatResult.title || chatResult.username || String(env.TELEGRAM_CHAT_ID),
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

export async function backupFileToTelegram(file, adapter, env) {
  if (file?.is_folder) {
    throw new Error('Folders cannot be backed up to Telegram');
  }

  const size = Number(file?.size || 0);
  if (size > TELEGRAM_MAX_FILE_SIZE) {
    throw new Error(
      `${file?.file_name ?? 'File'} is ${formatBytes(size)} and exceeds the Telegram 50 MB upload limit`,
    );
  }

  const downloadStream = await adapter.getDownloadStream(file);
  const buffer = await streamToBuffer(downloadStream);

  const result = await sendDocument({
    fileName: file.file_name || `opencloud-backup-${Date.now()}`,
    mimeType: file.mime_type || 'application/octet-stream',
    buffer,
    caption: `OpenCloud backup: ${file.file_name || 'file'}`,
  }, env);

  return {
    sent: true,
    fileName: file.file_name,
    size: buffer.byteLength,
    messageId: result.message_id,
  };
}

export async function backupMetadataToTelegram(userId, env) {
  const db = getDb();
  const result = await db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').all(userId);
  const files = result.results || result;
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

  const encoder = new TextEncoder();
  const buffer = encoder.encode(JSON.stringify(snapshot, null, 2));
  const sendResult = await sendDocument({
    fileName,
    mimeType: 'application/json',
    buffer,
    caption: `OpenCloud metadata backup · ${files.length} files`,
  }, env);

  return {
    sent: true,
    fileName,
    fileCount: files.length,
    size: buffer.byteLength,
    messageId: sendResult.message_id,
  };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}
