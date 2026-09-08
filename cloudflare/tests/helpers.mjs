import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { envStore } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function seedEnv(fn, extraEnv = {}) {
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: 'export default { fetch() { return new Response("x"); } }',
			d1Databases: ['DB'],
			compatibilityFlags: ['nodejs_compat'],
			vars: extraEnv,
		}),
	);
	try {
		await mf.ready;
		const bindings = await mf.getBindings();
		const env = { ...bindings, ...extraEnv };
		const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_init.sql'), 'utf8');
		await env.DB.exec(migrationSql.replace(/\r?\n/g, ' '));
		await envStore.run(env, async () => fn(env));
	} finally {
		await mf.dispose();
	}
}