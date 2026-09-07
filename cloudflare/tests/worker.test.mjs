import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, 'fixtures');

const shimModules = [
	['http', 'node:http'], ['https', 'node:https'], ['net', 'node:net'],
	['path', 'node:path'], ['url', 'node:url'], ['events', 'node:events'],
	['crypto', 'node:crypto'], ['stream', 'node:stream'], ['zlib', 'node:zlib'],
	['util', 'node:util'], ['assert', 'node:assert'], ['querystring', 'node:querystring'],
	['buffer', 'node:buffer'], ['async_hooks', 'node:async_hooks'],
	['fs', 'node:fs'], ['tls', 'node:tls'], ['os', 'node:os'], ['vm', 'node:vm'],
];

const imports = shimModules
	.map(([, m]) => `import _shim_${m.replace(/[:\/]/g, '_')} from '${m}';`)
	.join('\n');

const mapEntries = shimModules
	.flatMap(([bare, node]) => [
		`'${node}': _shim_${node.replace(/[:\/]/g, '_')},`,
		`'${bare}': _shim_${node.replace(/[:\/]/g, '_')},`,
	])
	.join('\n');

const banner = `
${imports}
var _nodeBuiltinModules = {${mapEntries}};
var require = function(id) {
  if (_nodeBuiltinModules[id]) return _nodeBuiltinModules[id];
  throw new Error('require shim: unknown builtin ' + id);
};
`;

const { outputFiles } = await build({
	entryPoints: [path.resolve(__dirname, '..', '_worker.js')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	mainFields: ['browser', 'module', 'main'],
	write: false,
	external: ['miniflare'],
	banner: { js: banner },
});
const workerScript = outputFiles[0].text;

async function startWorker() {
	const opts = convertV4MiniflareOptions({
		modules: true,
		script: workerScript,
		d1Databases: ['DB'],
		sitePath: fixturesDir,
		compatibilityFlags: ['nodejs_compat'],
		compatibilityDate: '2025-12-01',
	});
	// Add assets config so env.ASSETS is available.
	opts.workers[0].config.assets = { directory: fixturesDir, hasUserWorker: true };
	const mf = new Miniflare(opts);
	await mf.ready;
	return mf;
}

test('spa fallback serves a response for non-api path', async () => {
	const mf = await startWorker();
	try {
		const env = await mf.getBindings();
		const migrationSql = fs.readFileSync(
			path.resolve(__dirname, '../../migrations/0001_init.sql'),
			'utf8'
		);
		await env.DB.exec(migrationSql.replace(/\r?\n/g, ' '));
		const res = await mf.dispatchFetch('http://x/');
		assert.ok(res.status < 400, `expected <400 but got ${res.status}`);
	} finally {
		await mf.dispose();
	}
});

test('api health works through the worker', async () => {
	const mf = await startWorker();
	try {
		const res = await mf.dispatchFetch('http://x/api/health');
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.status, 'ok');
	} finally {
		await mf.dispose();
	}
});
