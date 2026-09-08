import { BaseAdapter } from './base.js';
import { decryptJson } from '../../backend/src/utils/crypto.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const API_BASE = 'https://www.googleapis.com/drive/v3';

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const prefixed = input.startsWith('/') ? input : `/${input}`;
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class GoogleDriveAdapter extends BaseAdapter {
  constructor(account, env) {
    super(account);
    this.env = env;
    this.accessTokenCache = null;
  }

  getCapabilities() {
    return { starred: true, rename: true, delete: true, move: true, copy: true };
  }

  readCredentials() {
    const credentials = decryptJson(this.account.encrypted_credentials);
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('Google Drive credentials are incomplete');
    }
    return credentials;
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessTokenCache && this.accessTokenCache.expiresAt > Date.now() + 30_000) {
      return this.accessTokenCache.token;
    }

    const credentials = this.readCredentials();
    if (!credentials.refreshToken) {
      throw new Error('Google Drive refresh token is missing');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
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
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || 'Failed to refresh Google access token');
    }

    this.accessTokenCache = {
      token: payload.access_token,
      expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000),
    };

    return this.accessTokenCache.token;
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const url = `${API_BASE}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      const freshToken = await this.getAccessToken(true);
      const retry = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          ...(options.headers || {}),
        },
      });
      return retry;
    }

    return response;
  }

  async ensureRemotePath(virtualPath = '/') {
    const normalizedPath = normalizePath(virtualPath);
    if (normalizedPath === '/') return 'root';

    const segments = normalizedPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let parentId = 'root';

    for (const segment of segments) {
      const q = [
        `trashed = false`,
        `mimeType = '${FOLDER_MIME_TYPE}'`,
        `name = '${escapeDriveQueryValue(segment)}'`,
        `('${escapeDriveQueryValue(parentId)}' in parents)`,
      ].join(' and ');

      const response = await this.request(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
      const data = await response.json();
      const existing = data.files?.[0];

      if (existing) {
        parentId = existing.id;
        continue;
      }

      const createRes = await this.request('/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: segment,
          mimeType: FOLDER_MIME_TYPE,
          parents: [parentId],
        }),
      });
      const created = await createRes.json();
      parentId = created.id;
    }

    return parentId;
  }

  async fetchStructure() {
    const files = [];
    let pageToken;

    do {
      const params = new URLSearchParams({
        q: "trashed = false and 'me' in owners",
        fields: 'nextPageToken, files(id, name, mimeType, size, parents, starred, createdTime, modifiedTime)',
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      });

      const response = await this.request(`/files?${params}`);
      const data = await response.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    const byId = new Map(files.map((file) => [file.id, file]));

    const buildFolderPath = (file) => {
      const parentId = file.parents?.[0];
      if (!parentId || parentId === 'root') return '/';
      const segments = [];
      const visited = new Set();
      let currentId = parentId;
      while (currentId && currentId !== 'root' && !visited.has(currentId)) {
        visited.add(currentId);
        const current = byId.get(currentId);
        if (!current) break;
        segments.unshift(current.name);
        currentId = current.parents?.[0];
      }
      return segments.length ? `/${segments.join('/')}/` : '/';
    };

    return files.map((file) => ({
      virtual_path: buildFolderPath(file),
      file_name: file.name,
      is_folder: file.mimeType === FOLDER_MIME_TYPE,
      is_starred: file.starred ? 1 : 0,
      size: Number(file.size || 0),
      mime_type: file.mimeType || null,
      remote_file_id: file.id,
      remote_parent_id: file.parents?.[0] || null,
      remote_created_time: file.createdTime || null,
      remote_modified_time: file.modifiedTime || null,
    }));
  }

  async listSharedWithMe() {
    const files = [];
    let pageToken;

    do {
      const params = new URLSearchParams({
        q: 'sharedWithMe = true and trashed = false',
        fields: 'nextPageToken, files(id, name, mimeType, size, parents, starred, createdTime, modifiedTime, owners(displayName,emailAddress))',
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      });

      const response = await this.request(`/files?${params}`);
      const data = await response.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return files.map((file) => ({
      file_name: file.name,
      is_folder: file.mimeType === FOLDER_MIME_TYPE,
      is_starred: file.starred ? 1 : 0,
      size: Number(file.size || 0),
      mime_type: file.mimeType || null,
      remote_file_id: file.id,
      remote_parent_id: file.parents?.[0] || null,
      createdTime: file.createdTime || null,
      modifiedTime: file.modifiedTime || null,
      owner_name: file.owners?.[0]?.displayName || null,
      owner_email: file.owners?.[0]?.emailAddress || this.account.email,
    }));
  }

  async listSharedFolderChildren(folderRecord) {
    const files = [];
    let pageToken;

    do {
      const params = new URLSearchParams({
        q: `'${escapeDriveQueryValue(folderRecord.remote_file_id)}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, parents, starred, createdTime, modifiedTime, owners(displayName,emailAddress))',
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      });

      const response = await this.request(`/files?${params}`);
      const data = await response.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return files.map((file) => ({
      file_name: file.name,
      is_folder: file.mimeType === FOLDER_MIME_TYPE,
      is_starred: file.starred ? 1 : 0,
      size: Number(file.size || 0),
      mime_type: file.mimeType || null,
      remote_file_id: file.id,
      remote_parent_id: file.parents?.[0] || folderRecord.remote_file_id,
      createdTime: file.createdTime || null,
      modifiedTime: file.modifiedTime || null,
      owner_name: file.owners?.[0]?.displayName || null,
      owner_email: file.owners?.[0]?.emailAddress || this.account.email,
    }));
  }

  async setFileStarred(fileRecord, isStarred) {
    await this.request(`/files/${encodeURIComponent(fileRecord.remote_file_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: Boolean(isStarred) }),
    });
  }

  async getStorageSummary() {
    const response = await this.request('/about?fields=storageQuota(limit,usage)');
    const data = await response.json();
    return {
      totalSpace: Number(data.storageQuota?.limit || 0),
      usedSpace: Number(data.storageQuota?.usage || 0),
    };
  }

  async uploadStream({ stream, fileName, mimeType, virtualPath, remoteParentId }) {
    const parentId = remoteParentId || await this.ensureRemotePath(virtualPath);

    const metadata = { name: fileName };
    if (parentId) metadata.parents = [parentId];

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', stream, fileName);

    const response = await this.request('/upload/drive/v3/files?uploadType=multipart&fields=id,parents,size,mimeType,name', {
      method: 'POST',
      body: form,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to upload to Google Drive');
    }

    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || parentId || null,
      size: Number(data.size || 0),
      fileName: data.name || fileName,
      mimeType: data.mimeType || mimeType,
    };
  }

  async createFolder({ name, virtualPath = '/', remoteParentId }) {
    const parentId = remoteParentId || await this.ensureRemotePath(virtualPath);
    const response = await this.request('/files?fields=id,parents,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME_TYPE,
        parents: parentId ? [parentId] : undefined,
      }),
    });
    const data = await response.json();
    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || parentId || null,
      fileName: data.name || name,
    };
  }

  async uploadChunked({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    if (totalSize <= 5 * 1024 * 1024) {
      return this._uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize });
    }

    const parentId = remoteParentId || await this.ensureRemotePath(virtualPath);
    const token = await this.getAccessToken();
    const metadata = { name: fileName, parents: parentId ? [parentId] : undefined };

    const sessionRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,parents,size,mimeType,name',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mimeType || 'application/octet-stream',
          'X-Upload-Content-Length': String(totalSize),
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!sessionRes.ok) {
      const err = await sessionRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Failed to start Google resumable upload session');
    }

    const sessionUri = sessionRes.headers.get('Location');
    if (!sessionUri) throw new Error('Google resumable upload did not return a session URI');

    let offset = 0;
    for await (const chunk of chunks) {
      const chunkBytes = await this._readStreamBytes(chunk.body);
      const end = offset + chunkBytes.byteLength - 1;

      const putRes = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkBytes.byteLength),
          'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
        },
        body: chunkBytes,
      });

      if (!putRes.ok && putRes.status !== 308) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error(err.error?.message || 'Google resumable upload chunk failed');
      }

      offset += chunkBytes.byteLength;
    }

    const finalRes = await fetch(
      `/upload/drive/v3/files?uploadType=resumable&fields=id,parents,size,mimeType,name`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': '0',
          'Content-Range': `bytes */${totalSize}`,
        },
      },
    );

    if (!finalRes.ok) {
      const err = await finalRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Failed to finalize Google resumable upload');
    }

    const data = await finalRes.json();
    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || parentId || null,
      size: Number(data.size || totalSize),
      fileName: data.name || fileName,
      mimeType: data.mimeType || mimeType,
    };
  }

  async _uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    const parentId = remoteParentId || await this.ensureRemotePath(virtualPath);
    const metadata = { name: fileName };
    if (parentId) metadata.parents = [parentId];

    const allChunks = [];
    for await (const chunk of chunks) {
      allChunks.push(chunk);
    }

    const parts = [];
    for (const chunk of allChunks) {
      const reader = chunk.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
    }
    const blob = new Blob(parts, { type: mimeType || 'application/octet-stream' });

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob, fileName);

    const response = await this.request('/upload/drive/v3/files?uploadType=multipart&fields=id,parents,size,mimeType,name', {
      method: 'POST',
      body: form,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to upload to Google Drive');
    }

    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || parentId || null,
      size: Number(data.size || totalSize),
      fileName: data.name || fileName,
      mimeType: data.mimeType || mimeType,
    };
  }

  async _readStreamBytes(stream) {
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

  async getDownloadStream(fileRecord) {
    const response = await this.request(
      `/files/${encodeURIComponent(fileRecord.remote_file_id)}?alt=media`,
    );
    if (!response.ok) {
      throw new Error('Failed to download from Google Drive');
    }
    return response.body;
  }

  async renameFile(fileRecord, nextName) {
    await this.request(`/files/${encodeURIComponent(fileRecord.remote_file_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nextName }),
    });
  }

  async copyFile(fileRecord, destRemoteId) {
    const response = await this.request(
      `/files/${encodeURIComponent(fileRecord.remote_file_id)}/copy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fileRecord.file_name,
          parents: destRemoteId ? [destRemoteId] : undefined,
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to copy file on Google Drive');
    }
    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || destRemoteId || null,
      size: Number(data.size || fileRecord.size || 0),
      fileName: data.name || fileRecord.file_name,
      mimeType: data.mimeType || fileRecord.mime_type,
    };
  }

  async moveFile(fileRecord, destRemoteId) {
    const sourceId = fileRecord.remote_file_id;
    const body = {};
    if (destRemoteId) body.addParents = destRemoteId;
    if (fileRecord.remote_parent_id) body.removeParents = fileRecord.remote_parent_id;

    const response = await this.request(
      `/files/${encodeURIComponent(sourceId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to move file on Google Drive');
    }
    return {
      remoteFileId: data.id,
      remoteParentId: data.parents?.[0] || destRemoteId || null,
      size: Number(data.size || fileRecord.size || 0),
      fileName: data.name || fileRecord.file_name,
      mimeType: data.mimeType || fileRecord.mime_type,
    };
  }

  async deleteFile(fileRecord) {
    await this.request(`/files/${encodeURIComponent(fileRecord.remote_file_id)}`, {
      method: 'DELETE',
    });
  }

  async getFileDetails(fileRecord) {
    const response = await this.request(
      `/files/${encodeURIComponent(fileRecord.remote_file_id)}?fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,owners(displayName,emailAddress),parents`,
    );
    const remote = await response.json();
    return {
      name: remote.name,
      file_name: remote.name,
      is_folder: remote.mimeType === FOLDER_MIME_TYPE,
      mimeType: remote.mimeType,
      mime_type: remote.mimeType,
      size: Number(remote.size || fileRecord.size || 0),
      createdTime: remote.createdTime,
      modifiedTime: remote.modifiedTime,
      webViewLink: remote.webViewLink,
      webContentLink: remote.webContentLink,
      owner_name: remote.owners?.[0]?.displayName || null,
      owner_email: remote.owners?.[0]?.emailAddress || this.account.email,
      remote_file_id: remote.id,
      remote_parent_id: remote.parents?.[0] || fileRecord.remote_parent_id || null,
      provider: 'google-drive',
    };
  }
}
