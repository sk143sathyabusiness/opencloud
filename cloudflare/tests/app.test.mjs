import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { envStore } from '../db.js';
import { createApp } from '../app.js';
import { runExpress } from '../expressBridge.js';
import { env } from '../../backend/src/config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(
	path.resolve(__dirname, '../../migrations/0001_init.sql'),
	'utf8',
).replace(/\r?\n/g, ' ');

async function withApp(fn, { mode = 'local' } = {}) {
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: 'export default { fetch() { return new Response("x"); } }',
			d1Databases: ['DB'],
			kvNamespaces: ['STATE'],
			compatibilityFlags: ['nodejs_compat'],
			compatibilityDate: '2025-12-01',
		}),
	);
	try {
		await mf.ready;
		const bindings = await mf.getBindings();
		await bindings.DB.exec(migrationSql);

		const prevMode = env.appMode;
		env.appMode = mode;

		try {
			await envStore.run(bindings, async () => {
				const app = createApp();
				await fn(app, bindings);
			});
		} finally {
			env.appMode = prevMode;
		}
	} finally {
		await mf.dispose();
	}
}

const localUser = { id: 'local-default-user', email: 'local@omnicloud.local', is_local: true };

test('GET /api/health returns 200 with status ok', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/health'), {
			user: localUser,
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.status, 'ok');
	});
});

test('GET /api/auth/me returns auth summary in local mode', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/auth/me'), {
			user: localUser,
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.mode, 'local');
		assert.ok(body.user);
	});
});

test('POST /api/auth/register creates a new user', async () => {
	await withApp(async (app) => {
		const res = await runExpress(
			app,
			new Request('http://x/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'test@app.com', password: 'password123' }),
			}),
			{ user: null },
		);
		assert.equal(res.status, 201);
		const body = await res.json();
		assert.ok(body.user);
		assert.equal(body.user.email, 'test@app.com');
	});
});

test('POST /api/auth/login returns user with correct credentials', async () => {
	await withApp(async (app) => {
		await runExpress(
			app,
			new Request('http://x/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'login@app.com', password: 'password123' }),
			}),
			{ user: null },
		);
		const res = await runExpress(
			app,
			new Request('http://x/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'login@app.com', password: 'password123' }),
			}),
			{ user: null },
		);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(body.user);
	});
});

test('GET /api/files returns 401 without auth cookie', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/files'), {
			user: null,
		});
		assert.equal(res.status, 401);
		const body = await res.json();
		assert.ok(body.error);
	}, { mode: 'hosted' });
});

test('POST /api/files/bulk/delete returns 401 without auth', async () => {
	await withApp(async (app) => {
		const res = await runExpress(
			app,
			new Request('http://x/api/files/bulk/delete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: ['some-id'] }),
			}),
			{ user: null },
		);
		assert.equal(res.status, 401);
		const body = await res.json();
		assert.ok(body.error);
	}, { mode: 'hosted' });
});

test('GET /api/accounts returns 401 without auth', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/accounts'), {
			user: null,
		});
		assert.equal(res.status, 401);
	}, { mode: 'hosted' });
});

test('GET /api/share/nonexistent/info returns 404', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/share/nonexistent/info'), {
			user: localUser,
		});
		assert.equal(res.status, 404);
	});
});

test('GET /api/settings returns defaults for local user', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/settings'), {
			user: localUser,
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(body.data);
	});
});

test('GET /api/allocation returns config for local user', async () => {
	await withApp(async (app) => {
		const res = await runExpress(app, new Request('http://x/api/allocation'), {
			user: localUser,
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(body.data);
		assert.ok(body.data.strategy);
	});
});
