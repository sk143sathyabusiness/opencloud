import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { kvGet, kvSet, kvDelete } from '../kvStore.js';

test('set and get a value', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      kvNamespaces: ['STATE'],
    }),
  );
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    await kvSet(STATE, 'test-key', { foo: 'bar' });
    const val = await kvGet(STATE, 'test-key');
    assert.deepEqual(val, { foo: 'bar' });
  } finally {
    await mf.dispose();
  }
});

test('get returns null for missing key', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      kvNamespaces: ['STATE'],
    }),
  );
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    const val = await kvGet(STATE, 'nonexistent');
    assert.equal(val, null);
  } finally {
    await mf.dispose();
  }
});

test('delete removes a value', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      kvNamespaces: ['STATE'],
    }),
  );
  try {
    await mf.ready;
    const { STATE } = await mf.getBindings();
    await kvSet(STATE, 'del-key', 'hello');
    await kvDelete(STATE, 'del-key');
    const val = await kvGet(STATE, 'del-key');
    assert.equal(val, null);
  } finally {
    await mf.dispose();
  }
});
