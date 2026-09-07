export async function kvGet(kv, key) {
  const val = await kv.get(key, { type: 'json' });
  return val;
}

export async function kvSet(kv, key, value, ttlSeconds) {
  const opts = { value: JSON.stringify(value) };
  if (ttlSeconds) opts.expirationTtl = ttlSeconds;
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

export async function kvDelete(kv, key) {
  await kv.delete(key);
}
