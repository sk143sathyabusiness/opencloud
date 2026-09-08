import { BaseAdapter } from './base.js';
import { decryptJson } from '../../backend/src/utils/crypto.js';

function normalizeVirtualPath(input = '/') {
  if (!input || input === '/') return '/';
  const prefixed = input.startsWith('/') ? input : `/${input}`;
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function joinPath(parent = '/', name = '') {
  const base = parent === '/' ? '' : parent.replace(/\/+$/, '');
  return `${base}/${name}`;
}

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function pcloudGet(host, method, params = {}) {
  const url = new URL(`https://${host}/${method}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });

  const response = await fetch(url.toString());
  const payload = await response.json();
  if (payload.result !== 0) {
    const error = new Error(payload.error || `pCloud ${method} failed`);
    error.result = payload.result;
    throw error;
  }
  return payload;
}

async function pcloudLogin({ username, password }) {
  const response = await fetch('https://api.pcloud.com/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, getmd5: '1' }),
  });

  const payload = await response.json();
  if (payload.result !== 0) {
    throw new Error(payload.error || 'pCloud login failed');
  }

  return {
    auth: payload.auth,
    host: payload.hosts?.[0] || 'api.pcloud.com',
  };
}

export class PCloudAdapter extends BaseAdapter {
  constructor(account, env) {
    super(account);
    this.env = env;
    this.session = null;
  }

  getCapabilities() {
    return { starred: false, rename: true, delete: true, move: true, copy: true };
  }

  readCredentials() {
    const credentials = decryptJson(this.account.encrypted_credentials);
    if (!credentials.auth && (!credentials.username || !credentials.password)) {
      throw new Error('pCloud account credentials are incomplete');
    }
    return credentials;
  }

  async getSession(forceRelogin = false) {
    if (this.session && !forceRelogin) return this.session;

    const credentials = this.readCredentials();

    if (credentials.auth && credentials.host && !forceRelogin) {
      this.session = { host: credentials.host, auth: credentials.auth };
      return this.session;
    }

    if (!credentials.username || !credentials.password) {
      throw new Error('pCloud session expired and no stored password to re-login');
    }

    const login = await pcloudLogin({
      username: credentials.username,
      password: credentials.password,
    });
    this.session = { host: login.host, auth: login.auth };
    return this.session;
  }

  async call(method, params = {}) {
    const { host, auth } = await this.getSession();
    try {
      return await pcloudGet(host, method, { ...params, auth });
    } catch (error) {
      if ([1000, 2000, 2094].includes(error.result)) {
        const fresh = await this.getSession(true);
        return pcloudGet(fresh.host, method, { ...params, auth: fresh.auth });
      }
      throw error;
    }
  }

  async fetchStructure() {
    const records = [];
    const rootPayload = await this.call('listfolder', { path: '/' });

    const walk = (entry, parentVirtualPath) => {
      const isFolder = Boolean(entry.isfolder);
      const name = entry.name;

      if (entry.path === '/' || !name) {
        (entry.contents || []).forEach((child) => walk(child, '/'));
        return;
      }

      const virtualPath = normalizeVirtualPath(parentVirtualPath);
      records.push({
        virtual_path: virtualPath,
        file_name: name,
        is_folder: isFolder,
        size: isFolder ? 0 : Number(entry.size || 0),
        mime_type: isFolder ? null : entry.contenttype || 'application/octet-stream',
        remote_file_id: isFolder ? `d${entry.folderid}` : `f${entry.fileid}`,
        remote_parent_id: virtualPath,
        remote_created_time: toIsoDate(entry.created),
        remote_modified_time: toIsoDate(entry.modified),
      });

      if (isFolder) {
        const childVirtualPath = joinPath(virtualPath === '/' ? '' : virtualPath.replace(/\/+$/, ''), name) + '/';
        (entry.contents || []).forEach((child) => walk(child, childVirtualPath));
      }
    };

    const populateFolderContents = async (entry) => {
      if (!entry?.isfolder) return entry;

      const folderPath = entry.folderid === 0 ? '/' : entry.path;
      const payload = entry.folderid === 0
        ? rootPayload
        : await this.call('listfolder', { path: folderPath || '/' });

      const contents = Array.isArray(payload.metadata?.contents) ? payload.metadata.contents : [];
      entry.contents = contents;

      await Promise.all(contents.filter((child) => child?.isfolder).map((child) => populateFolderContents(child)));
      return entry;
    };

    const rootEntry = await populateFolderContents(rootPayload.metadata);
    walk(rootEntry, '/');
    return records;
  }

  async getStorageSummary() {
    const payload = await this.call('userinfo', {});
    return {
      totalSpace: Number(payload.quota || this.account.total_space || 0),
      usedSpace: Number(payload.usedquota || this.account.used_space || 0),
    };
  }

  async ensureFolder(virtualPath = '/') {
    const normalized = normalizeVirtualPath(virtualPath);
    if (normalized === '/') return 0;

    const path = normalized.replace(/\/+$/, '');
    const payload = await this.call('createfolderifnotexists', { path });
    return payload.metadata?.folderid ?? 0;
  }

  async uploadStream({ stream, size, fileName, mimeType, virtualPath = '/' }) {
    const { host, auth } = await this.getSession();
    await this.ensureFolder(virtualPath);

    const normalized = normalizeVirtualPath(virtualPath);
    const folderPath = normalized === '/' ? '/' : normalized.replace(/\/+$/, '');

    const chunks = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' });

    const form = new FormData();
    form.set('auth', auth);
    form.set('path', folderPath);
    form.set('filename', fileName);
    form.set('nopartial', '1');
    form.append('file', blob, fileName);

    const response = await fetch(`https://${host}/uploadfile`, {
      method: 'POST',
      body: form,
    });

    const payload = await response.json().catch(() => null);
    if (!payload || payload.result !== 0) {
      throw new Error(payload?.error || `pCloud upload failed (HTTP ${response.status})`);
    }

    const meta = (payload.metadata || [])[0] || {};
    return {
      remoteFileId: meta.fileid ? `f${meta.fileid}` : undefined,
      remoteParentId: normalized,
      size: Number(meta.size || size || 0),
      fileName: meta.name || fileName,
      mimeType,
    };
  }

  async createFolder({ name, virtualPath = '/' }) {
    const normalized = normalizeVirtualPath(virtualPath);
    const base = normalized === '/' ? '' : normalized.replace(/\/+$/, '');
    const path = `${base}/${name}`;
    const payload = await this.call('createfolderifnotexists', { path });
    return {
      remoteFileId: `d${payload.metadata?.folderid ?? ''}`,
      remoteParentId: normalized,
      fileName: payload.metadata?.name || name,
    };
  }

  idParams(fileRecord) {
    const id = fileRecord.remote_file_id || '';
    if (id.startsWith('f')) return { fileid: id.slice(1) };
    if (id.startsWith('d')) return { folderid: id.slice(1) };
    const base = fileRecord.virtual_path === '/' ? '' : normalizeVirtualPath(fileRecord.virtual_path).replace(/\/+$/, '');
    return { path: `${base}/${fileRecord.file_name}` };
  }

  async getDownloadStream(fileRecord) {
    const params = this.idParams(fileRecord);
    const link = await this.call('getfilelink', params);
    const host = (link.hosts || [])[0];
    if (!host || !link.path) throw new Error('pCloud did not return a download link');

    const response = await fetch(`https://${host}${link.path}`);
    if (!response.ok || !response.body) throw new Error('Failed to download file from pCloud');
    return response.body;
  }

  async renameFile(fileRecord, nextName) {
    const params = this.idParams(fileRecord);
    const method = fileRecord.is_folder ? 'renamefolder' : 'renamefile';
    await this.call(method, { ...params, toname: nextName });
  }

  async deleteFile(fileRecord) {
    const params = this.idParams(fileRecord);
    if (fileRecord.is_folder) {
      await this.call('deletefolderrecursive', params);
    } else {
      await this.call('deletefile', params);
    }
  }

  async getFileDetails(fileRecord) {
    return {
      name: fileRecord.file_name,
      mime_type: fileRecord.mime_type,
      size: Number(fileRecord.size || 0),
      createdTime: fileRecord.remote_created_time,
      modifiedTime: fileRecord.remote_modified_time,
      webViewLink: null,
      owner_email: this.account.email,
      remote_parent_id: fileRecord.virtual_path,
      provider: 'pcloud',
    };
  }
}
