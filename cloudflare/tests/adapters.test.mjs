import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { BaseAdapter } from '../adapters/base.js';
import { GoogleDriveAdapter } from '../adapters/google.js';
import { OneDriveAdapter } from '../adapters/onedrive.js';
import { DropboxAdapter } from '../adapters/dropbox.js';
import { YandexAdapter } from '../adapters/yandex.js';
import { S3Adapter } from '../adapters/s3.js';
import { PCloudAdapter } from '../adapters/pcloud.js';

const mockAccount = {
  id: 'acc-1',
  user_id: 'u1',
  provider: 'google-drive',
  email: 'test@example.com',
  encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  total_space: 1000000,
  used_space: 500000,
};

const mockEnv = {};

function patchReadCredentials(adapter, creds) {
  adapter.readCredentials = () => creds;
}

function patchGetAccessToken(adapter, token = 'mock-token') {
  adapter.accessTokenCache = { token, expiresAt: Date.now() + 3600_000 };
}

// Base adapter

test('BaseAdapter cannot be instantiated directly', () => {
  assert.throws(() => new BaseAdapter(mockAccount), /BaseAdapter is abstract/);
});

test('BaseAdapter throws for all abstract methods', async () => {
  class TestAdapter extends BaseAdapter {}
  const adapter = new TestAdapter(mockAccount);
  await assert.rejects(() => adapter.listFiles(), /must be implemented/);
  await assert.rejects(() => adapter.getFileDetails(), /must be implemented/);
  await assert.rejects(() => adapter.getDownloadStream(), /must be implemented/);
  await assert.rejects(() => adapter.uploadFile(), /must be implemented/);
  await assert.rejects(() => adapter.renameFile(), /must be implemented/);
  await assert.rejects(() => adapter.deleteFile(), /must be implemented/);
  await assert.rejects(() => adapter.createFolder(), /must be implemented/);
  await assert.rejects(() => adapter.setFileStarred(), /must be implemented/);
});

// Google Drive

test('GoogleDriveAdapter instantiates and has correct capabilities', () => {
  const adapter = new GoogleDriveAdapter(mockAccount, mockEnv);
  assert.equal(adapter.account, mockAccount);
  assert.deepEqual(adapter.getCapabilities(), { starred: true, rename: true, delete: true, move: true, copy: true });
});

test('GoogleDriveAdapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new GoogleDriveAdapter(bad, mockEnv);
  assert.throws(() => adapter.readCredentials());
});

test('GoogleDriveAdapter getAccessToken throws on token refresh failure', async () => {
  const adapter = new GoogleDriveAdapter(mockAccount, mockEnv);
  // readCredentials will succeed with mockAccount (valid encrypted JSON),
  // but getAccessToken will fail because refreshToken is empty
  await assert.rejects(() => adapter.getAccessToken());
});

// OneDrive

test('OneDriveAdapter instantiates and has correct capabilities', () => {
  const adapter = new OneDriveAdapter(mockAccount, mockEnv);
  assert.deepEqual(adapter.getCapabilities(), { starred: false, rename: true, delete: true, move: true, copy: true });
});

test('OneDriveAdapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new OneDriveAdapter(bad, mockEnv);
  assert.rejects(() => adapter.getAccessToken());
});

// Dropbox

test('DropboxAdapter instantiates and has correct capabilities', () => {
  const adapter = new DropboxAdapter(mockAccount, mockEnv);
  assert.deepEqual(adapter.getCapabilities(), { starred: false, rename: true, delete: true, move: true, copy: true });
});

test('DropboxAdapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new DropboxAdapter(bad, mockEnv);
  assert.throws(() => adapter.readCredentials());
});

// Yandex

test('YandexAdapter instantiates and has correct capabilities', () => {
  const adapter = new YandexAdapter(mockAccount, mockEnv);
  assert.deepEqual(adapter.getCapabilities(), { starred: false, rename: true, delete: true, move: true, copy: true });
});

test('YandexAdapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new YandexAdapter(bad, mockEnv);
  assert.throws(() => adapter.readCredentials());
});

// S3

test('S3Adapter instantiates and has correct capabilities', () => {
  const adapter = new S3Adapter(mockAccount, mockEnv);
  assert.deepEqual(adapter.getCapabilities(), { starred: false, rename: true, delete: true, move: true, copy: true });
});

test('S3Adapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new S3Adapter(bad, mockEnv);
  assert.throws(() => adapter.readCredentials());
});

// pCloud

test('PCloudAdapter instantiates and has correct capabilities', () => {
  const adapter = new PCloudAdapter(mockAccount, mockEnv);
  assert.deepEqual(adapter.getCapabilities(), { starred: false, rename: true, delete: true, move: true, copy: true });
});

test('PCloudAdapter throws on bad credentials', () => {
  const bad = { ...mockAccount, encrypted_credentials: 'not-valid-base64-encrypted' };
  const adapter = new PCloudAdapter(bad, mockEnv);
  assert.throws(() => adapter.readCredentials());
});

// All adapters have required methods

test('all adapters implement required methods', () => {
  const adapters = [
    GoogleDriveAdapter,
    OneDriveAdapter,
    DropboxAdapter,
    YandexAdapter,
    S3Adapter,
    PCloudAdapter,
  ];

  const requiredMethods = [
    'listFiles',
    'getFileDetails',
    'getDownloadStream',
    'uploadFile',
    'renameFile',
    'deleteFile',
    'createFolder',
    'setFileStarred',
    'fetchStructure',
    'getStorageSummary',
    'uploadStream',
    'getDownloadStream',
  ];

  for (const AdapterClass of adapters) {
    const adapter = new AdapterClass(mockAccount, mockEnv);
    for (const method of requiredMethods) {
      assert.equal(typeof adapter[method], 'function', `${AdapterClass.name} missing ${method}`);
    }
  }
});

// Chunked upload tests

function makeChunkStream(data) {
  return new Response(data).body;
}

async function* makeChunks(byteArrays) {
  for (let i = 0; i < byteArrays.length; i++) {
    yield { index: i, body: makeChunkStream(byteArrays[i]) };
  }
}

test('BaseAdapter uploadChunked falls back to uploadStream', async () => {
  let uploadCalled = false;
  let uploadedStream = null;

  class TestAdapter extends BaseAdapter {
    async uploadStream({ stream }) {
      uploadCalled = true;
      uploadedStream = stream;
      return { remoteFileId: 'test-id', size: 6 };
    }
  }

  const adapter = new TestAdapter(mockAccount);
  const chunk1 = new Uint8Array([1, 2, 3]);
  const chunk2 = new Uint8Array([4, 5, 6]);

  const result = await adapter.uploadChunked({
    chunks: makeChunks([chunk1, chunk2]),
    fileName: 'test.txt',
    mimeType: 'text/plain',
    virtualPath: '/',
    remoteParentId: null,
    totalSize: 6,
  });

  assert.equal(uploadCalled, true);
  assert.equal(result.remoteFileId, 'test-id');
  assert.equal(result.size, 6);
  assert.ok(uploadedStream !== null);
});

test('BaseAdapter uploadChunked rejects empty chunks', async () => {
  class TestAdapter extends BaseAdapter {
    async uploadStream() { return {}; }
  }

  const adapter = new TestAdapter(mockAccount);
  await assert.rejects(
    () => adapter.uploadChunked({
      chunks: makeChunks([]),
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      virtualPath: '/',
      remoteParentId: null,
      totalSize: 0,
    }),
    /No chunks provided/,
  );
});

// Google Drive chunked upload tests

test('GoogleDriveAdapter uploadChunked uses resumable for files > 5MB', async () => {
  const googleAccount = {
    ...mockAccount,
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  };

  const adapter = new GoogleDriveAdapter(googleAccount, mockEnv);
  patchReadCredentials(adapter, { clientId: 'c', clientSecret: 's', refreshToken: 'r' });

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method, headers: opts.headers });

    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }

    if (String(url).includes('uploadType=resumable') && opts.method === 'POST') {
      return new Response(null, {
        status: 200,
        headers: { Location: 'https://session.example.com/upload' },
      });
    }

    if (String(url).includes('session.example.com/upload')) {
      return new Response(null, { status: 308 });
    }

    if (String(url).includes('uploadType=resumable') && opts.method === 'PUT' && opts.headers?.['Content-Range']?.includes('bytes */')) {
      return new Response(JSON.stringify({ id: 'file-123', name: 'big.bin', size: '6291456', parents: ['root'] }), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const chunk1 = new Uint8Array(5 * 1024 * 1024);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(1291456);
    chunk2.fill(2);

    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk1, chunk2]),
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      virtualPath: '/',
      remoteParentId: 'root',
      totalSize: 6291456,
    });

    assert.equal(result.remoteFileId, 'file-123');
    assert.ok(fetchCalls.some((c) => c.url.includes('uploadType=resumable') && c.method === 'POST'));
    assert.ok(fetchCalls.some((c) => c.url.includes('session.example.com/upload') && c.method === 'PUT'));
    assert.ok(fetchCalls.some((c) => c.headers?.['Content-Range']?.includes('bytes */')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GoogleDriveAdapter uploadChunked uses multipart for files <= 5MB', async () => {
  const googleAccount = {
    ...mockAccount,
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  };

  const adapter = new GoogleDriveAdapter(googleAccount, mockEnv);
  patchReadCredentials(adapter, { clientId: 'c', clientSecret: 's', refreshToken: 'r' });

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method });

    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }

    if (String(url).includes('uploadType=multipart')) {
      return new Response(JSON.stringify({ id: 'file-small', name: 'small.txt', size: '100', parents: ['root'] }), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const chunk = new Uint8Array(100);
    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk]),
      fileName: 'small.txt',
      mimeType: 'text/plain',
      virtualPath: '/',
      remoteParentId: 'root',
      totalSize: 100,
    });

    assert.equal(result.remoteFileId, 'file-small');
    assert.ok(fetchCalls.some((c) => c.url.includes('uploadType=multipart')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// S3 multipart upload tests

test('S3Adapter uploadChunked uses multipart for files > 5MB', async () => {
  const s3Account = {
    ...mockAccount,
    provider: 's3',
    encrypted_credentials: JSON.stringify({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret123',
      bucket: 'my-bucket',
      region: 'us-east-1',
    }),
  };

  const adapter = new S3Adapter(s3Account, mockEnv);
  patchReadCredentials(adapter, {
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret123',
    bucket: 'my-bucket',
    region: 'us-east-1',
  });

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method, headers: opts.headers });

    if (String(url).includes('?uploads') && opts.method === 'POST') {
      return new Response('<InitiateMultipartUploadResult><Bucket>my-bucket</Bucket><Key>big.bin</Key><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }

    if (String(url).includes('uploadId=') && opts.method === 'PUT') {
      return new Response(null, {
        status: 200,
        headers: { ETag: '"part-etag-1"' },
      });
    }

    if (String(url).includes('uploadId=') && opts.method === 'POST' && opts.headers?.['Content-Type'] === 'application/xml') {
      return new Response('<CompleteMultipartUploadResult><Bucket>my-bucket</Bucket></CompleteMultipartUploadResult>', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const chunk1 = new Uint8Array(5 * 1024 * 1024);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(1291456);
    chunk2.fill(2);

    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk1, chunk2]),
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      virtualPath: '/',
      remoteParentId: null,
      totalSize: 6291456,
    });

    assert.equal(result.remoteFileId, 'big.bin');
    assert.ok(fetchCalls.some((c) => c.url.includes('?uploads') && c.method === 'POST'));
    assert.ok(fetchCalls.some((c) => c.url.includes('uploadId=') && c.method === 'PUT'));
    assert.ok(fetchCalls.some((c) => c.url.includes('uploadId=') && c.method === 'POST' && c.headers?.['Content-Type'] === 'application/xml'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('S3Adapter uploadChunked uses simple PUT for files <= 5MB', async () => {
  const s3Account = {
    ...mockAccount,
    provider: 's3',
    encrypted_credentials: JSON.stringify({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret123',
      bucket: 'my-bucket',
      region: 'us-east-1',
    }),
  };

  const adapter = new S3Adapter(s3Account, mockEnv);
  patchReadCredentials(adapter, {
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret123',
    bucket: 'my-bucket',
    region: 'us-east-1',
  });

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method });
    return new Response(null, { status: 200 });
  };

  try {
    const chunk = new Uint8Array(100);
    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk]),
      fileName: 'small.txt',
      mimeType: 'text/plain',
      virtualPath: '/',
      remoteParentId: null,
      totalSize: 100,
    });

    assert.equal(result.remoteFileId, 'small.txt');
    assert.ok(!fetchCalls.some((c) => c.url.includes('?uploads')));
    assert.ok(fetchCalls.some((c) => c.method === 'PUT'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Dropbox upload session tests

test('DropboxAdapter uploadChunked uses session for files > 150MB', async () => {
  const dropboxAccount = {
    ...mockAccount,
    provider: 'dropbox',
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  };

  const adapter = new DropboxAdapter(dropboxAccount, mockEnv);
  patchReadCredentials(adapter, { clientId: 'c', clientSecret: 's', refreshToken: 'r' });
  patchGetAccessToken(adapter);

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method, headers: opts.headers });

    if (String(url).includes('upload_session/start')) {
      return new Response(JSON.stringify({ session_id: 'sess-123', offset: 0 }), { status: 200 });
    }

    if (String(url).includes('upload_session/append_v2')) {
      return new Response(null, { status: 200 });
    }

    if (String(url).includes('upload_session/finish')) {
      return new Response(JSON.stringify({ id: 'dbx-file-1', name: 'huge.bin', path_lower: '/huge.bin', size: 157286401 }), { status: 200 });
    }

    return new Response(JSON.stringify({ error_summary: 'not_found' }), { status: 404 });
  };

  try {
    const chunk1 = new Uint8Array(1024 * 1024);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(1024 * 1024);
    chunk2.fill(2);

    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk1, chunk2]),
      fileName: 'huge.bin',
      mimeType: 'application/octet-stream',
      virtualPath: '/',
      remoteParentId: null,
      totalSize: 157286401,
    });

    assert.equal(result.remoteFileId, 'dbx-file-1');
    assert.ok(fetchCalls.some((c) => c.url.includes('upload_session/start') && c.method === 'POST'));
    assert.ok(fetchCalls.some((c) => c.url.includes('upload_session/append_v2') && c.method === 'POST'));
    assert.ok(fetchCalls.some((c) => c.url.includes('upload_session/finish') && c.method === 'POST'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DropboxAdapter uploadChunked uses simple upload for files <= 150MB', async () => {
  const dropboxAccount = {
    ...mockAccount,
    provider: 'dropbox',
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  };

  const adapter = new DropboxAdapter(dropboxAccount, mockEnv);
  patchReadCredentials(adapter, { clientId: 'c', clientSecret: 's', refreshToken: 'r' });
  patchGetAccessToken(adapter);

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method });

    if (String(url).includes('content.dropboxapi.com') && String(url).includes('files/upload')) {
      return new Response(JSON.stringify({ id: 'dbx-file-small', name: 'small.txt', path_lower: '/small.txt', size: 100 }), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const chunk = new Uint8Array(100);
    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk]),
      fileName: 'small.txt',
      mimeType: 'text/plain',
      virtualPath: '/',
      remoteParentId: null,
      totalSize: 100,
    });

    assert.equal(result.remoteFileId, 'dbx-file-small');
    assert.ok(!fetchCalls.some((c) => c.url.includes('upload_session/start')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// OneDrive chunked upload tests

test('OneDriveAdapter uploadChunked uses session for files > 4MB', async () => {
  const onedriveAccount = {
    ...mockAccount,
    provider: 'onedrive',
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r', tenantId: 't' }),
  };

  const adapter = new OneDriveAdapter(onedriveAccount, mockEnv);
  patchGetAccessToken(adapter);

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method, headers: opts.headers });

    if (String(url).includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }

    if (String(url).includes('createUploadSession')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://session.example.com/upload', id: 'od-file-1', name: 'big.bin', size: 5242880, parentReference: { id: 'root' } }), { status: 200 });
    }

    if (String(url).includes('session.example.com/upload') && opts.method === 'PUT') {
      return new Response(JSON.stringify({ id: 'od-file-1', name: 'big.bin', size: 5242880, parentReference: { id: 'root' } }), { status: 200 });
    }

    if (String(url).includes('session.example.com/upload') && opts.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
  };

  try {
    const chunk1 = new Uint8Array(4 * 1024 * 1024);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(1242880);
    chunk2.fill(2);

    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk1, chunk2]),
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      virtualPath: '/',
      remoteParentId: 'root',
      totalSize: 5242880,
    });

    assert.equal(result.remoteFileId, 'od-file-1');
    assert.ok(fetchCalls.some((c) => c.url.includes('createUploadSession') && c.method === 'POST'));
    assert.ok(fetchCalls.some((c) => c.url.includes('session.example.com/upload') && c.method === 'PUT'));
    assert.ok(fetchCalls.some((c) => c.url.includes('session.example.com/upload') && c.method === 'DELETE'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OneDriveAdapter uploadChunked uses simple upload for files <= 4MB', async () => {
  const onedriveAccount = {
    ...mockAccount,
    provider: 'onedrive',
    encrypted_credentials: JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r', tenantId: 't' }),
  };

  const adapter = new OneDriveAdapter(onedriveAccount, mockEnv);
  patchGetAccessToken(adapter);

  let fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method });

    if (String(url).includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }

    if (String(url).includes('graph.microsoft.com') && opts.method === 'PUT') {
      return new Response(JSON.stringify({ id: 'od-file-small', name: 'small.txt', size: 100, parentReference: { id: 'root' } }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
  };

  try {
    const chunk = new Uint8Array(100);
    const result = await adapter.uploadChunked({
      chunks: makeChunks([chunk]),
      fileName: 'small.txt',
      mimeType: 'text/plain',
      virtualPath: '/',
      remoteParentId: 'root',
      totalSize: 100,
    });

    assert.equal(result.remoteFileId, 'od-file-small');
    assert.ok(!fetchCalls.some((c) => c.url.includes('createUploadSession')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
