import { envStore } from './db.js';
import { createSlimApp } from './appSlim.js';
import { runExpress } from './expressBridge.js';
import { LOCAL_USER_ID } from '../backend/src/config/constants.js';

const app = createSlimApp();
const localUser = { id: LOCAL_USER_ID, email: 'local@omnicloud.local' };

export default {
	async fetch(request, env) {
		return envStore.run(env, async () => {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/api/')) {
				const appMode = env.APP_MODE ?? 'local';
				const user = appMode === 'local' ? localUser : null;
				return runExpress(app, request, { user });
			}
			return env.ASSETS.fetch(request);
		});
	},
};
