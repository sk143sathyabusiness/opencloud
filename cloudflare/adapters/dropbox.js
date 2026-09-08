import { BaseAdapter } from './base.js';
import { decryptJson } from '../../backend/src/utils/crypto.js';
import { guessMimeType } from '../../backend/src/utils/mime.js';

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const prefixed = input.startsWith('/') ? input : `/${input}`;
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function joinDropboxPath(parentPath = '/', name = '') {
  const normalizedParent = parentPath === '/' ? '' : parentPath.replace(/\/+$/g, '');
  return `${normalizedParent}/${name}`;
}

function toVirtualPath(dropboxPath = '') {
  if (!dropboxPath || dropboxPath === '/') return '/';
  const withSlashes = dropboxPath.startsWith('/') ? dropboxPath : `/${dropboxPath}`;
  const parent = withSlashes.slice(0, withSlashes.lastIndexOf('/') + 1);
  return normalizePath(parent || '/');
}

function parseDropboxError(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  return payload.error_summary || payload.error?.['.tag'] || payload.message || fallback;
}

async function dropboxReadStreamBytes(stream) {
  const reader = stream.getReader();
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.byteLength;
  }
  return result;
}

export class DropboxAdapter extends BaseAdapter {
  constructor(account, env) {
    super(account);
    this.env = env;
    this.accessTokenCache = null;
  }

  getCapabilities() {
    return { starred: false, rename: true, delete: true, move: true, copy: true };
  }

  readCredentials() {
    const credentials = decryptJson(this.account.encrypted_credentials);
    if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) {
      throw new Error('Dropbox account credentials are incomplete');
    }
    return credentials;
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessTokenCache && this.accessTokenCache.expiresAt > Date.now() + 30_000) {
      return this.accessTokenCache.token;
    }

    const credentials = this.readCredentials();
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(parseDropboxError(payload, 'Failed to refresh Dropbox access token'));

    this.accessTokenCache = {
      token: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in || 14400) * 1000,
    };

    return this.accessTokenCache.token;
  }

  async rpc(path, body = {}) {
    return this.requestWithReauth(async (accessToken) => {
      const response = await fetch(`https://api.dropboxapi.com/2${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(parseDropboxError(payload, 'Dropbox API request failed'));
        error.status = response.status;
        throw error;
      }
      return payload;
    });
  }

  async requestWithReauth(makeRequest) {
    let accessToken = await this.getAccessToken();
    try {
      return await makeRequest(accessToken);
    } catch (error) {
      if (error?.status !== 401) throw error;
      accessToken = await this.getAccessToken(true);
      return makeRequest(accessToken);
    }
  }

  async content(path, { args, body, contentType = 'application/octet-stream' } = {}) {
    return this.requestWithReauth(async (accessToken) => {
      const response = await fetch(`https://content.dropboxapi.com/2${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify(args),
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        ...(body ? { duplex: 'half' } : {}),
      });

      if (!response.ok && response.status === 401) {
        const error = new Error('Dropbox content request unauthorized');
        error.status = response.status;
        throw error;
      }

      return response;
    });
  }

  async listFolder(path = '', recursive = true) {
    const entries = [];
    let payload = await this.rpc('/files/list_folder', {
      path,
      recursive,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true,
      include_non_downloadable_files: true,
    });

    entries.push(...(payload.entries || []));
    while (payload.has_more) {
      payload = await this.rpc('/files/list_folder/continue', { cursor: payload.cursor });
      entries.push(...(payload.entries || []));
    }

    return entries;
  }

  async ensureRemotePath(virtualPath = '/') {
    const normalizedPath = normalizePath(virtualPath);
    if (normalizedPath === '/') return '';

    const segments = normalizedPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
      currentPath = joinDropboxPath(currentPath || '/', segment);
      try {
        await this.rpc('/files/get_metadata', { path: currentPath });
      } catch (error) {
        if (!error.message.includes('not_found')) throw error;
        await this.rpc('/files/create_folder_v2', { path: currentPath, autorename: false });
      }
    }

    return currentPath;
  }

  async fetchStructure() {
    const entries = await this.listFolder('', true);
    return entries
      .filter((entry) => entry['.tag'] === 'file' || entry['.tag'] === 'folder')
      .map((entry) => {
        const isFolder = entry['.tag'] === 'folder';
        return {
          virtual_path: toVirtualPath(entry.path_display || entry.path_lower),
          file_name: entry.name,
          is_folder: isFolder,
          size: isFolder ? 0 : Number(entry.size || 0),
          mime_type: isFolder ? null : guessMimeType(entry.name),
          remote_file_id: entry.id || entry.path_lower,
          remote_parent_id: toVirtualPath(entry.path_display || entry.path_lower),
          remote_created_time: null,
          remote_modified_time: isFolder ? null : entry.server_modified || null,
        };
      });
  }

  async getStorageSummary() {
    const payload = await this.rpc('/users/get_space_usage', {});
    const allocation = payload.allocation || {};
    const totalSpace = allocation.allocated || allocation.individual?.allocated || allocation.team?.allocated || this.account.total_space || 0;
    return {
      totalSpace: Number(totalSpace || 0),
      usedSpace: Number(payload.used || this.account.used_space || 0),
    };
  }

  async uploadStream({ stream, size, fileName, mimeType, virtualPath = '/' }) {
    const parentPath = await this.ensureRemotePath(virtualPath);
    const targetPath = joinDropboxPath(parentPath || '/', fileName);
    const response = await this.content('/files/upload', {
      args: { path: targetPath, mode: 'add', autorename: true, mute: false, strict_conflict: false },
      body: stream,
      contentType: 'application/octet-stream',
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parseDropboxError(payload, 'Failed to upload file to Dropbox'));
    }

    return {
      remoteFileId: payload.id || payload.path_lower,
      remoteParentId: parentPath || '/',
      size: Number(payload.size || size || 0),
      fileName: payload.name || fileName,
      mimeType,
    };
  }

  async uploadChunked({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    if (totalSize <= 150 * 1024 * 1024) {
      return this._uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize });
    }

    const parentPath = await this.ensureRemotePath(virtualPath);
    const targetPath = joinDropboxPath(parentPath || '/', fileName);

    const allChunks = [];
    for await (const chunk of chunks) {
      allChunks.push(chunk);
    }

    let sessionId = null;
    let offset = 0;

    for (let i = 0; i < allChunks.length; i++) {
      const chunkBytes = await dropboxReadStreamBytes(allChunks[i].body);

      if (i === 0) {
        const startRes = await this.requestWithReauth(async (accessToken) => {
          return fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ close: false }),
            },
            body: chunkBytes,
          });
        });

        if (!startRes.ok) {
          const err = await startRes.json().catch(() => null);
          throw new Error(parseDropboxError(err, 'Failed to start Dropbox upload session'));
        }

        const startPayload = await startRes.json();
        sessionId = startPayload.session_id;
        offset = chunkBytes.byteLength;
      } else {
        const appendRes = await this.requestWithReauth(async (accessToken) => {
          return fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({
                cursor: { session_id: sessionId, offset },
                close: false,
              }),
            },
            body: chunkBytes,
          });
        });

        if (!appendRes.ok) {
          const err = await appendRes.json().catch(() => null);
          throw new Error(parseDropboxError(err, 'Failed to append to Dropbox upload session'));
        }

        offset += chunkBytes.byteLength;
      }
    }

    const finishRes = await this.requestWithReauth(async (accessToken) => {
      return fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            cursor: { session_id: sessionId, offset },
            commit: { path: targetPath, mode: 'add', autorename: true, mute: false, strict_conflict: false },
          }),
        },
        body: new Uint8Array(0),
      });
    });

    if (!finishRes.ok) {
      const err = await finishRes.json().catch(() => null);
      throw new Error(parseDropboxError(err, 'Failed to finish Dropbox upload session'));
    }

    const payload = await finishRes.json();
    return {
      remoteFileId: payload.id || payload.path_lower,
      remoteParentId: parentPath || '/',
      size: Number(payload.size || totalSize),
      fileName: payload.name || fileName,
      mimeType,
    };
  }

  async _uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    const parentPath = await this.ensureRemotePath(virtualPath);
    const targetPath = joinDropboxPath(parentPath || '/', fileName);

    const allChunks = [];
    for await (const chunk of chunks) {
      allChunks.push(chunk);
    }

    let combined;
    if (allChunks.length === 1) {
      combined = allChunks[0].body;
    } else {
      const parts = [];
      for (const chunk of allChunks) {
        const reader = chunk.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
        }
      }
      combined = new Response(new Blob(parts)).body;
    }

    const response = await this.content('/files/upload', {
      args: { path: targetPath, mode: 'add', autorename: true, mute: false, strict_conflict: false },
      body: combined,
      contentType: 'application/octet-stream',
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parseDropboxError(payload, 'Failed to upload file to Dropbox'));
    }

    return {
      remoteFileId: payload.id || payload.path_lower,
      remoteParentId: parentPath || '/',
      size: Number(payload.size || totalSize),
      fileName: payload.name || fileName,
      mimeType,
    };
  }

  async createFolder({ name, virtualPath = '/' }) {
    const parentPath = await this.ensureRemotePath(virtualPath);
    const folderPath = joinDropboxPath(parentPath || '/', name);
    const payload = await this.rpc('/files/create_folder_v2', { path: folderPath, autorename: true });
    return {
      remoteFileId: payload.metadata?.id || payload.metadata?.path_lower || folderPath,
      remoteParentId: parentPath || '/',
      fileName: payload.metadata?.name || name,
    };
  }

  async getDownloadStream(fileRecord) {
    const response = await this.content('/files/download', {
      args: {
        path: fileRecord.remote_file_id || joinDropboxPath(fileRecord.virtual_path, fileRecord.file_name),
      },
      body: null,
      contentType: '',
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(parseDropboxError(payload, 'Failed to download file from Dropbox'));
    }
    if (!response.body) throw new Error('Dropbox download returned an empty response');
    return response.body;
  }

  async renameFile(fileRecord, nextName) {
    const fromPath = joinDropboxPath(fileRecord.virtual_path, fileRecord.file_name);
    const toPath = joinDropboxPath(fileRecord.virtual_path, nextName);
    await this.rpc('/files/move_v2', {
      from_path: fileRecord.remote_file_id || fromPath,
      to_path: toPath,
      autorename: false,
      allow_shared_folder: true,
    });
  }

  async deleteFile(fileRecord) {
    await this.rpc('/files/delete_v2', {
      path: fileRecord.remote_file_id || joinDropboxPath(fileRecord.virtual_path, fileRecord.file_name),
    });
  }

  async getFileDetails(fileRecord) {
    const remote = await this.rpc('/files/get_metadata', {
      path: fileRecord.remote_file_id || joinDropboxPath(fileRecord.virtual_path, fileRecord.file_name),
      include_media_info: false,
      include_deleted: false,
    });
    return {
      name: remote.name || fileRecord.file_name,
      mime_type: fileRecord.mime_type,
      size: Number(remote.size || fileRecord.size || 0),
      createdTime: null,
      modifiedTime: remote.server_modified || null,
      webViewLink: null,
      owner_email: this.account.email,
      remote_parent_id: toVirtualPath(remote.path_display || remote.path_lower),
      provider: 'dropbox',
    };
  }
}
