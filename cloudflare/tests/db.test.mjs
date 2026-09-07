import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { envStore, getDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8').replace(/\r?\n/g, ' ');

async function withDb(fn) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      d1Databases: ['DB'],
      compatibilityFlags: ['nodejs_compat'],
    }),
  );
  try {
    await mf.ready;
    const env = await mf.getBindings();
    await env.DB.exec(migrationSql);
    await envStore.run(env, async () => fn(getDb()));
  } finally {
    await mf.dispose();
  }
}

test('transaction commits on success', async () => {
  await withDb(async (db) => {
    await db.transaction(async (tx) => {
      await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.c');
      await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u2', 'b@c.d');
    });
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
    assert.equal(row.email, 'a@b.c');
  });
});

test('transaction rolls back on error', async () => {
  await withDb(async (db) => {
    try {
      await db.transaction(async (tx) => {
        await tx.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u3', 'c@d.e');
        throw new Error('boom');
      });
    } catch (e) {
      // expected
    }
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u3');
    assert.equal(row, undefined);
  });
});

test('batch executes multiple queries', async () => {
  await withDb(async (db) => {
    const results = await db.batch([
      db.prepare('SELECT COUNT(*) as cnt FROM users'),
      db.prepare('SELECT COUNT(*) as cnt FROM file_metadata'),
    ]);
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
  });
});
