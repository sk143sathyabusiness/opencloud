import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword, generateToken, hashToken, constantTimeEqual } from '../../backend/src/config/crypto.js';
import { encryptJson, decryptJson } from '../../backend/src/utils/crypto.js';

test('hashPassword produces a hash and salt', async () => {
  const { hash, salt } = await hashPassword('mypassword');
  assert.ok(hash);
  assert.ok(salt);
  assert.ok(hash.length > 0);
});

test('verifyPassword returns true for correct password', async () => {
  const { hash, salt } = await hashPassword('test123');
  const result = await verifyPassword('test123', hash, salt);
  assert.equal(result, true);
});

test('verifyPassword returns false for wrong password', async () => {
  const { hash, salt } = await hashPassword('test123');
  const result = await verifyPassword('wrong', hash, salt);
  assert.equal(result, false);
});

test('generateToken returns a random hex string', async () => {
  const t1 = await generateToken();
  const t2 = await generateToken();
  assert.ok(t1.length > 0);
  assert.notEqual(t1, t2);
});

test('hashToken produces consistent SHA-256', async () => {
  const h1 = await hashToken('hello');
  const h2 = await hashToken('hello');
  assert.equal(h1, h2);
});

test('constantTimeEqual compares buffers', async () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  const c = new Uint8Array([1, 2, 4]);
  assert.equal(constantTimeEqual(a, b), true);
  assert.equal(constantTimeEqual(a, c), false);
});

// encryptJson / decryptJson round-trip tests

test('encryptJson produces a base64 string and decryptJson recovers the original', () => {
  const input = { test: true, nested: { key: 'value' } };
  const encrypted = encryptJson(input);
  assert.equal(typeof encrypted, 'string');
  assert.ok(encrypted.length > 0);
  // Should be valid base64
  assert.ok(Buffer.from(encrypted, 'base64').toString('base64') === encrypted);
  const decrypted = decryptJson(encrypted);
  assert.deepEqual(decrypted, input);
});

test('encryptJson with different inputs produces different ciphertexts', () => {
  const a = encryptJson({ x: 1 });
  const b = encryptJson({ x: 2 });
  assert.notEqual(a, b);
});

test('encryptJson with same input produces different ciphertexts (random IV)', () => {
  const a = encryptJson({ x: 1 });
  const b = encryptJson({ x: 1 });
  assert.notEqual(a, b);
  // But both decrypt to the same value
  assert.deepEqual(decryptJson(a), decryptJson(b));
});

test('decryptJson fails on tampered ciphertext', () => {
  const encrypted = encryptJson({ test: true });
  // Tamper by flipping a byte in the base64-decoded content
  const raw = Buffer.from(encrypted, 'base64');
  raw[raw.length - 1] ^= 0xff;
  const tampered = raw.toString('base64');
  assert.throws(() => decryptJson(tampered), /auth/);
});
