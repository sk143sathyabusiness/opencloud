import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { envStore, getDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('getDb() returns D1Compat bound to the request env', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("x"); } }',
      d1Databases: ['DB'],
      compatibilityFlags: ['nodejs_compat'],
    })
  );
  try {
    await mf.ready;
    const env = await mf.getBindings();
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8');
    await env.DB.exec(migrationSql.replace(/\r?\n/g, ' '));
    await envDBRoundTrip(env);
  } finally {
    await mf.dispose();
  }
  async function envDBRoundTrip(env) {
    await envStore.run(env, async () => {
      const db = getDb();
      await db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.c');
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
      assert.equal(row.email, 'a@b.c');
      const all = await db.prepare('SELECT id FROM users ORDER BY id').all();
      assert.ok(all.results.some((r) => r.id === 'local-default-user'));
    });
  }
});
