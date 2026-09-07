import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runExpress } from '../expressBridge.js';
import { createSlimApp } from '../appSlim.js';
import { seedEnv } from './helpers.mjs';

test('health returns ok', async () => {
	await seedEnv(async (env) => {
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/health'), { user: { id: 'local-default-user' } });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).appMode, 'local');
	});
});

test('files list reads seeded rows from D1', async () => {
	await seedEnv(async (env) => {
		await env.DB.prepare(`INSERT INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status)
			VALUES ('acc1','local-default-user','acc1@local.test','local','x',100,0,'active')`).run();
		await env.DB.prepare(`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,size,cloud_account_id,remote_file_id)
			VALUES ('f1','local-default-user','/','hello.txt',0,5,'acc1','rm1')`).run();
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/files?path=/'), { user: { id: 'local-default-user' } });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.files));
		assert.equal(body.files[0].file_name, 'hello.txt');
	});
});

test('files list requires auth in hosted mode', async () => {
	await seedEnv(async () => {
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/files'), { user: null });
		assert.equal(res.status, 401);
	});
});

test('share info returns public metadata + expired flag', async () => {
	await seedEnv(async (env) => {
		await env.DB.prepare(`INSERT INTO share_links (id,user_id,file_id,cloud_account_id,remote_file_id,file_name,size,mime_type,is_folder,token,download_count)
			VALUES ('s1','local-default-user','f1','acc1','rm1','hello.txt',5,'text/plain',0,'tok123',0)`).run();
		const app = createSlimApp();
		const res = await runExpress(app, new Request('http://x/api/share/tok123/info'), { user: null });
		assert.equal(res.status, 200);
		const info = await res.json();
		assert.equal(info.data.file_name, 'hello.txt');
		assert.equal(info.data.expired, false);
	});
});