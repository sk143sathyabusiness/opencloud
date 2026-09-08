import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter, isSupportedProvider } from '../adapters/registry.js';
import { encryptJson } from '../../backend/src/utils/crypto.js';
import { GoogleDriveAdapter } from '../adapters/google.js';
import { OneDriveAdapter } from '../adapters/onedrive.js';
import { DropboxAdapter } from '../adapters/dropbox.js';
import { YandexAdapter } from '../adapters/yandex.js';
import { S3Adapter } from '../adapters/s3.js';
import { PCloudAdapter } from '../adapters/pcloud.js';

const mockAccount = {
  id: 'acc-1',
  user_id: 'u1',
  provider: 'google_drive',
  email: 'test@example.com',
  encrypted_credentials: encryptJson({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
  total_space: 1000000,
  used_space: 500000,
};

const mockEnv = {};

test('createAdapter returns GoogleDriveAdapter for google_drive', async () => {
  const adapter = await createAdapter('google_drive', mockAccount, mockEnv);
  assert.ok(adapter instanceof GoogleDriveAdapter);
  assert.equal(adapter.account, mockAccount);
  assert.equal(adapter.env, mockEnv);
});

test('createAdapter returns OneDriveAdapter for onedrive', async () => {
  const adapter = await createAdapter('onedrive', mockAccount, mockEnv);
  assert.ok(adapter instanceof OneDriveAdapter);
});

test('createAdapter returns DropboxAdapter for dropbox', async () => {
  const adapter = await createAdapter('dropbox', mockAccount, mockEnv);
  assert.ok(adapter instanceof DropboxAdapter);
});

test('createAdapter returns YandexAdapter for yandex', async () => {
  const adapter = await createAdapter('yandex', mockAccount, mockEnv);
  assert.ok(adapter instanceof YandexAdapter);
});

test('createAdapter returns S3Adapter for s3', async () => {
  const adapter = await createAdapter('s3', mockAccount, mockEnv);
  assert.ok(adapter instanceof S3Adapter);
});

test('createAdapter returns PCloudAdapter for pcloud', async () => {
  const adapter = await createAdapter('pcloud', mockAccount, mockEnv);
  assert.ok(adapter instanceof PCloudAdapter);
});

test('createAdapter throws for unknown provider', async () => {
  await assert.rejects(
    () => createAdapter('unknown', mockAccount, mockEnv),
    /Unknown provider: unknown/,
  );
});

test('isSupportedProvider returns true for known providers', () => {
  assert.equal(isSupportedProvider('google_drive'), true);
  assert.equal(isSupportedProvider('onedrive'), true);
  assert.equal(isSupportedProvider('dropbox'), true);
  assert.equal(isSupportedProvider('yandex'), true);
  assert.equal(isSupportedProvider('s3'), true);
  assert.equal(isSupportedProvider('pcloud'), true);
});

test('isSupportedProvider returns false for unknown providers', () => {
  assert.equal(isSupportedProvider('unknown'), false);
  assert.equal(isSupportedProvider('google-drive'), false);
  assert.equal(isSupportedProvider(''), false);
});
