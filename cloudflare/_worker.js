import { envStore } from './db.js';
import { createApp } from './app.js';
import { runExpress } from './expressBridge.js';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '../backend/src/config/constants.js';
import { runDeltaSync } from './services/syncService.js';
import { purgeExpiredTrash } from './services/trashService.js';
import { setEnv } from '../backend/src/config/env.js';

const app = createApp();
const localUser = { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL, is_local: true };

export default {
	async fetch(request, env) {
		return envStore.run(env, async () => {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/api/')) {
				const appMode = env.APP_MODE ?? 'local';
				const user = appMode === 'local' ? localUser : null;
				return runExpress(app, request, { user, env });
			}
			return env.ASSETS.fetch(request);
		});
	},

	async scheduled(event, env, ctx) {
		setEnv(env);
		return envStore.run(env, async () => {
			if (event.cron.includes('0 3 * * *')) {
				ctx.waitUntil(purgeExpiredTrash(LOCAL_USER_ID, env));
			} else {
				ctx.waitUntil(runDeltaSync(LOCAL_USER_ID, env));
			}
		});
	},
};
