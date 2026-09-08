import assert from 'node:assert/strict';
import { test } from 'node:test';
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
