import { BaseAdapter } from './base.js';
import { decryptJson } from '../../backend/src/utils/crypto.js';
import { guessMimeType } from '../../backend/src/utils/mime.js';

const FOLDER_MARKER = '/';

function normalizeVirtualPath(input = '/') {
  if (!input || input === '/') return '/';
  const prefixed = input.startsWith('/') ? input : `/${input}`;
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function toKey(virtualPath = '/', name = '') {
  const folder = normalizeVirtualPath(virtualPath).replace(/^\/+/, '');
  return `${folder}${name}`;
}

function keyToVirtualPath(key = '') {
  const trimmed = key.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return '/';
  return `/${trimmed.slice(0, lastSlash)}/`;
}

function keyToName(key = '') {
  const trimmed = key.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

async function buildV4SignData(method, headers, canonicalUri, canonicalQueryString, payloadHash, date, credentialScope) {
  const signedHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}`).join('\n');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    signedHeaders,
    Object.keys(headers).sort().join(' '),
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  return { stringToSign, signedHeaders: Object.keys(headers).sort().join(' ') };
}

async function sha256Hex(data) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function s3ReadStreamBytes(stream) {
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

async function hmacSha256(key, data) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

async function signV4(method, url, headers, payload, credentials) {
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateShort = date.slice(0, 8);
  const parsed = new URL(url);

  const payloadHash = await sha256Hex(typeof payload === 'string' ? payload : '');

  const credentialScope = `${dateShort}/${credentials.region || 'us-east-1'}/s3/aws4_request`;
  const authHeaders = {
    host: parsed.host,
    'x-amz-date': date,
    'x-amz-content-sha256': payloadHash,
    ...(headers || {}),
  };

  const { stringToSign, signedHeaders } = await buildV4SignData(
    method,
    authHeaders,
    parsed.pathname,
    parsed.searchParams.toString(),
    payloadHash,
    date,
    credentialScope,
  );

  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${credentials.secretAccessKey}`), dateShort);
  const kRegion = await hmacSha256(kDate, credentials.region || 'us-east-1');
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = [...new Uint8Array(await hmacSha256(kSigning, stringToSign))].map((b) => b.toString(16).padStart(2, '0')).join('');

  return {
    ...authHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3Adapter extends BaseAdapter {
  constructor(account, env) {
    super(account);
    this.env = env;
    this.credentialsCache = null;
  }

  getCapabilities() {
    return { starred: false, rename: true, delete: true, move: true, copy: true };
  }

  readCredentials() {
    if (this.credentialsCache) return this.credentialsCache;
    const credentials = decryptJson(this.account.encrypted_credentials);
    if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.bucket) {
      throw new Error('S3 account credentials are incomplete (accessKeyId, secretAccessKey, bucket required)');
    }
    this.credentialsCache = credentials;
    return credentials;
  }

  getEndpoint() {
    const credentials = this.readCredentials();
    if (credentials.endpoint) return credentials.endpoint;
    const region = credentials.region || 'us-east-1';
    return `https://s3.${region}.amazonaws.com`;
  }

  async s3Request(method, key, { body, headers = {} } = {}) {
    const credentials = this.readCredentials();
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${key}`;

    const signedHeaders = await signV4(method, url, headers, body || '', credentials);

    const response = await fetch(url, {
      method,
      headers: signedHeaders,
      body: body || undefined,
    });

    return response;
  }

  async listAllObjects() {
    const credentials = this.readCredentials();
    const bucket = credentials.bucket;
    const objects = [];
    let continuationToken;

    do {
      const params = new URLSearchParams({ 'list-type': '2' });
      if (continuationToken) params.set('continuation-token', continuationToken);
      const url = `https://s3.${credentials.region || 'us-east-1'}.amazonaws.com/${bucket}?${params}`;

      const headers = {};
      const signedHeaders = await signV4('GET', url, headers, '', credentials);
      const response = await fetch(url, { headers: signedHeaders });
      const text = await response.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');
      const contents = doc.querySelectorAll('Contents');
      for (const content of contents) {
        const keyEl = content.querySelector('Key');
        const sizeEl = content.querySelector('Size');
        const lastModEl = content.querySelector('LastModified');
        if (keyEl) {
          objects.push({
            Key: keyEl.textContent,
            Size: sizeEl ? Number(sizeEl.textContent) : 0,
            LastModified: lastModEl?.textContent || null,
          });
        }
      }

      const truncatedEl = doc.querySelector('IsTruncated');
      continuationToken = truncatedEl?.textContent === 'true'
        ? doc.querySelector('NextContinuationToken')?.textContent
        : undefined;
    } while (continuationToken);

    return objects;
  }

  async fetchStructure() {
    const objects = await this.listAllObjects();
    const records = [];
    const folderKeys = new Set();

    for (const object of objects) {
      const key = object.Key;
      if (!key) continue;

      const isFolder = key.endsWith(FOLDER_MARKER);
      if (isFolder) {
        folderKeys.add(key);
        records.push({
          virtual_path: keyToVirtualPath(key),
          file_name: keyToName(key),
          is_folder: true,
          size: 0,
          mime_type: null,
          remote_file_id: key,
          remote_parent_id: keyToVirtualPath(key),
          remote_created_time: null,
          remote_modified_time: object.LastModified || null,
        });
        continue;
      }

      records.push({
        virtual_path: keyToVirtualPath(key),
        file_name: keyToName(key),
        is_folder: false,
        size: Number(object.Size || 0),
        mime_type: guessMimeType(keyToName(key)),
        remote_file_id: key,
        remote_parent_id: keyToVirtualPath(key),
        remote_created_time: null,
        remote_modified_time: object.LastModified || null,
      });
    }

    const seen = new Set(folderKeys);
    for (const object of objects) {
      const key = object.Key || '';
      const segments = key.replace(/\/+$/, '').split('/');
      segments.pop();
      let prefix = '';
      for (const segment of segments) {
        prefix += `${segment}/`;
        if (seen.has(prefix)) continue;
        seen.add(prefix);
        records.push({
          virtual_path: keyToVirtualPath(prefix),
          file_name: keyToName(prefix),
          is_folder: true,
          size: 0,
          mime_type: null,
          remote_file_id: prefix,
          remote_parent_id: keyToVirtualPath(prefix),
          remote_created_time: null,
          remote_modified_time: null,
        });
      }
    }

    return records;
  }

  async getStorageSummary() {
    const objects = await this.listAllObjects();
    const usedSpace = objects.reduce((sum, o) => sum + Number(o.Size || 0), 0);
    return {
      totalSpace: Number(this.account.total_space || 0),
      usedSpace,
    };
  }

  async uploadStream({ stream, size, fileName, mimeType, virtualPath = '/' }) {
    const credentials = this.readCredentials();
    const key = toKey(virtualPath, fileName);
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${bucket}/${key}`;

    const signedHeaders = await signV4('PUT', url, {
      'content-type': mimeType || 'application/octet-stream',
    }, '', credentials);

    const response = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders,
      body: stream,
    });

    if (!response.ok) {
      throw new Error(`S3 upload failed: ${response.status}`);
    }

    return {
      remoteFileId: key,
      remoteParentId: normalizeVirtualPath(virtualPath),
      size: Number(size || 0),
      fileName,
      mimeType,
    };
  }

  async uploadChunked({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    if (totalSize <= 5 * 1024 * 1024) {
      return this._uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize });
    }

    const credentials = this.readCredentials();
    const bucket = credentials.bucket;
    const key = toKey(virtualPath, fileName);
    const endpoint = this.getEndpoint();
    const contentType = mimeType || 'application/octet-stream';

    const createUrl = `${endpoint}/${bucket}/${key}?uploads`;
    const createHeaders = {
      'Content-Type': contentType,
    };
    const signedCreate = await signV4('POST', createUrl, createHeaders, '', credentials);
    const createRes = await fetch(createUrl, { method: 'POST', headers: signedCreate });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`S3 CreateMultipartUpload failed: ${createRes.status} ${err}`);
    }

    const createXml = await createRes.text();
    const uploadIdMatch = createXml.match(/<UploadId>(.*?)<\/UploadId>/);
    if (!uploadIdMatch) throw new Error('S3 CreateMultipartUpload did not return UploadId');
    const uploadId = uploadIdMatch[1];

    const allChunks = [];
    for await (const chunk of chunks) {
      allChunks.push(chunk);
    }

    const partTags = [];
    let partNumber = 1;

    for (const chunk of allChunks) {
      const chunkBytes = await s3ReadStreamBytes(chunk.body);
      const partUrl = `${endpoint}/${bucket}/${key}?partNumber=${partNumber}&uploadId=${uploadId}`;

      const signedPart = await signV4('PUT', partUrl, {
        'Content-Type': contentType,
        'Content-Length': String(chunkBytes.byteLength),
      }, '', credentials);

      const partRes = await fetch(partUrl, {
        method: 'PUT',
        headers: {
          ...signedPart,
          'Content-Length': String(chunkBytes.byteLength),
        },
        body: chunkBytes,
      });

      if (!partRes.ok) {
        const err = await partRes.text();
        throw new Error(`S3 UploadPart ${partNumber} failed: ${partRes.status} ${err}`);
      }

      const etag = partRes.headers.get('ETag');
      if (!etag) throw new Error(`S3 UploadPart ${partNumber} missing ETag`);

      partTags.push({ PartNumber: partNumber, ETag: etag });
      partNumber++;
    }

    const completeXml = [
      '<CompleteMultipartUpload>',
      ...partTags.map((p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`),
      '</CompleteMultipartUpload>',
    ].join('');

    const completeUrl = `${endpoint}/${bucket}/${key}?uploadId=${uploadId}`;
    const signedComplete = await signV4('POST', completeUrl, {
      'Content-Type': 'application/xml',
    }, completeXml, credentials);

    const completeRes = await fetch(completeUrl, {
      method: 'POST',
      headers: {
        ...signedComplete,
        'Content-Type': 'application/xml',
      },
      body: completeXml,
    });

    if (!completeRes.ok) {
      const err = await completeRes.text();
      throw new Error(`S3 CompleteMultipartUpload failed: ${completeRes.status} ${err}`);
    }

    return {
      remoteFileId: key,
      remoteParentId: normalizeVirtualPath(virtualPath),
      size: Number(totalSize || 0),
      fileName,
      mimeType,
    };
  }

  async _uploadChunkedFallback({ chunks, fileName, mimeType, virtualPath, remoteParentId, totalSize }) {
    const credentials = this.readCredentials();
    const key = toKey(virtualPath, fileName);
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${bucket}/${key}`;

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

    const signedHeaders = await signV4('PUT', url, {
      'content-type': mimeType || 'application/octet-stream',
    }, '', credentials);

    const response = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders,
      body: combined,
    });

    if (!response.ok) {
      throw new Error(`S3 upload failed: ${response.status}`);
    }

    return {
      remoteFileId: key,
      remoteParentId: normalizeVirtualPath(virtualPath),
      size: Number(totalSize || 0),
      fileName,
      mimeType,
    };
  }

  async createFolder({ name, virtualPath = '/' }) {
    const credentials = this.readCredentials();
    const key = `${toKey(virtualPath, name)}/`;
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${bucket}/${key}`;

    const signedHeaders = await signV4('PUT', url, {}, '', credentials);

    const response = await fetch(url, { method: 'PUT', headers: signedHeaders });
    if (!response.ok) throw new Error(`S3 createFolder failed: ${response.status}`);

    return {
      remoteFileId: key,
      remoteParentId: normalizeVirtualPath(virtualPath),
      fileName: name,
    };
  }

  async getDownloadStream(fileRecord) {
    const credentials = this.readCredentials();
    const key = fileRecord.remote_file_id || toKey(fileRecord.virtual_path, fileRecord.file_name);
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${bucket}/${key}`;

    const signedHeaders = await signV4('GET', url, {}, '', credentials);
    const response = await fetch(url, { headers: signedHeaders });

    if (!response.ok || !response.body) {
      throw new Error('S3 download failed');
    }

    return response.body;
  }

  async renameFile(fileRecord, nextName) {
    const credentials = this.readCredentials();
    const fromKey = fileRecord.remote_file_id || toKey(fileRecord.virtual_path, fileRecord.file_name);
    const toKey2 = toKey(fileRecord.virtual_path, nextName);
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();

    const copyUrl = `${endpoint}/${bucket}/${toKey2}`;
    const copyHeaders = {
      'x-amz-copy-source': `/${bucket}/${fromKey}`,
    };
    const signedCopy = await signV4('PUT', copyUrl, copyHeaders, '', credentials);
    await fetch(copyUrl, { method: 'PUT', headers: signedCopy });

    const deleteUrl = `${endpoint}/${bucket}/${fromKey}`;
    const signedDelete = await signV4('DELETE', deleteUrl, {}, '', credentials);
    await fetch(deleteUrl, { method: 'DELETE', headers: signedDelete });
  }

  async copyFile(fileRecord, destRemoteId) {
    const credentials = this.readCredentials();
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const sourceKey = fileRecord.remote_file_id || toKey(fileRecord.virtual_path, fileRecord.file_name);
    const destKey = destRemoteId
      ? `${destRemoteId.replace(/\/+$/, '')}/${fileRecord.file_name}`
      : toKey('/', fileRecord.file_name);

    const url = `${endpoint}/${bucket}/${destKey}`;
    const headers = {
      'x-amz-copy-source': `/${bucket}/${sourceKey}`,
    };
    const signedHeaders = await signV4('PUT', url, headers, '', credentials);
    const response = await fetch(url, { method: 'PUT', headers: signedHeaders });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`S3 copy failed: ${response.status} ${err}`);
    }

    return {
      remoteFileId: destKey,
      remoteParentId: destRemoteId || '/',
      size: Number(fileRecord.size || 0),
      fileName: fileRecord.file_name,
      mimeType: fileRecord.mime_type,
    };
  }

  async moveFile(fileRecord, destRemoteId) {
    const newFile = await this.copyFile(fileRecord, destRemoteId);
    try {
      await this.deleteFile(fileRecord);
    } catch (e) {
      /* best-effort delete after copy */
    }
    return newFile;
  }

  async deleteFile(fileRecord) {
    const credentials = this.readCredentials();
    const key = fileRecord.remote_file_id || toKey(fileRecord.virtual_path, fileRecord.file_name);
    const bucket = credentials.bucket;
    const endpoint = this.getEndpoint();
    const url = `${endpoint}/${bucket}/${key}`;

    const signedHeaders = await signV4('DELETE', url, {}, '', credentials);
    await fetch(url, { method: 'DELETE', headers: signedHeaders });
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
      provider: this.account.provider,
    };
  }
}
