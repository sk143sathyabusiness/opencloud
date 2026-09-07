import { AsyncLocalStorage } from 'node:async_hooks';

export const envStore = new AsyncLocalStorage();

export function d1CompatFrom(d1) {
	return {
		prepare(sql) {
			const stmt = d1.prepare(sql);
			return {
				run: (...args) => stmt.bind(...args).run(),
				get: async (...args) => (await stmt.bind(...args).first()) ?? undefined,
				all: (...args) => stmt.bind(...args).all(),
			};
		},
		exec: (sql) => d1.exec(sql),
	};
}

export function getDb() {
	const store = envStore.getStore();
	if (!store?.DB) throw new Error('D1 binding "DB" is not available in this context');
	return d1CompatFrom(store.DB);
}
