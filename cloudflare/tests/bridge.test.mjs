import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import express from 'express';
import { runExpress } from '../expressBridge.js';

async function withEnv(fn) {
	const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityFlags: ['nodejs_compat'] }));
	try { await mf.ready; return await fn(await mf.getBindings()); }
	finally { await mf.dispose(); }
}

test('runExpress serves an Express route', async () => {
	const app = express();
	app.get('/api/health', (req, res) => res.json({ ok: true }));
	await withEnv(async (env) => {
		const res = await runExpress(app, new Request('http://x/api/health'), {});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
	});
});

test('bridge forwards query + status codes', async () => {
	const app = express();
	app.get('/api/echo', (req, res) => res.status(201).json({ q: req.query.name }));
	await withEnv(async () => {
		const res = await runExpress(app, new Request('http://x/api/echo?name=alice'), {});
		assert.equal(res.status, 201);
		assert.deepEqual(await res.json(), { q: 'alice' });
	});
});
