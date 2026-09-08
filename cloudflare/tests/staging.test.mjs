import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { putStagedChunk, getStagedChunks, deleteStaged } from '../staging.js';

test('putStagedChunk writes to R2', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      r2Buckets: ['R2'],
    }),
  );
  try {
    await mf.ready;
    const { R2 } = await mf.getBindings();

    const data = new TextEncoder().encode('chunk-0-data');
    await putStagedChunk({ R2 }, 'upload-abc', 0, data.buffer);

    const obj = await R2.get('staging/upload-abc/0');
    assert.ok(obj, 'object should exist');
    const body = await obj.text();
    assert.equal(body, 'chunk-0-data');
  } finally {
    await mf.dispose();
  }
});

test('getStagedChunks returns sorted chunks', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      r2Buckets: ['R2'],
    }),
  );
  try {
    await mf.ready;
    const { R2 } = await mf.getBindings();

    await R2.put('staging/up-1/1', new TextEncoder().encode('second'));
    await R2.put('staging/up-1/0', new TextEncoder().encode('first'));
    await R2.put('staging/up-1/2', new TextEncoder().encode('third'));

    const chunks = await getStagedChunks({ R2 }, 'up-1');

    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].index, 0);
    assert.equal(chunks[1].index, 1);
    assert.equal(chunks[2].index, 2);

    const text0 = await new Response(chunks[0].body).text();
    const text1 = await new Response(chunks[1].body).text();
    const text2 = await new Response(chunks[2].body).text();
    assert.equal(text0, 'first');
    assert.equal(text1, 'second');
    assert.equal(text2, 'third');
  } finally {
    await mf.dispose();
  }
});

test('deleteStaged removes all objects', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      r2Buckets: ['R2'],
    }),
  );
  try {
    await mf.ready;
    const { R2 } = await mf.getBindings();

    await R2.put('staging/up-del/0', new TextEncoder().encode('a'));
    await R2.put('staging/up-del/1', new TextEncoder().encode('b'));

    const before = await R2.list({ prefix: 'staging/up-del/' });
    assert.equal(before.objects.length, 2);

    await deleteStaged({ R2 }, 'up-del');

    const after = await R2.list({ prefix: 'staging/up-del/' });
    assert.equal(after.objects.length, 0);
  } finally {
    await mf.dispose();
  }
});

test('deleteStaged is safe on empty upload', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      r2Buckets: ['R2'],
    }),
  );
  try {
    await mf.ready;
    const { R2 } = await mf.getBindings();

    await deleteStaged({ R2 }, 'nonexistent-upload');

    const listed = await R2.list({ prefix: 'staging/nonexistent-upload/' });
    assert.equal(listed.objects.length, 0);
  } finally {
    await mf.dispose();
  }
});
