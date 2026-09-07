const ITERATIONS = 100000;
const KEY_LENGTH = 64;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function deriveKey(password, salt, iterations, keyLength) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, keyLength * 8);
}

export async function hashPassword(password, existingSalt) {
  const salt = existingSalt ? fromHex(existingSalt) : generateSalt();
  const hash = await deriveKey(password, salt, ITERATIONS, KEY_LENGTH);
  return { hash: toHex(hash), salt: toHex(salt) };
}

export async function verifyPassword(password, storedHash, salt) {
  const { hash } = await hashPassword(password, salt);
  return constantTimeEqual(fromHex(hash), fromHex(storedHash));
}

export async function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(bytes);
}

export async function hashToken(token) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toHex(hash);
}

export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
