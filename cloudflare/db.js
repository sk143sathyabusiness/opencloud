import { AsyncLocalStorage } from 'node:async_hooks';

export const envStore = new AsyncLocalStorage();

export function d1CompatFrom(d1) {
	return {
	prepare(sql) {
		const stmt = d1.prepare(sql);
		const wrapper = {
			run: (...args) => stmt.bind(...args).run(),
			get: async (...args) => (await stmt.bind(...args).first()) ?? undefined,
			all: (...args) => stmt.bind(...args).all(),
			bind: (...args) => stmt.bind(...args),
			_stmt: stmt,
		};
		return wrapper;
	},
		exec: (sql) => d1.exec(sql),
		transaction: async (fn) => {
			const ops = [];
			const txDb = {
				prepare(sql) {
					const d1Stmt = d1.prepare(sql);
					return {
						run: (...args) => {
							ops.push(d1Stmt.bind(...args));
							return Promise.resolve({ success: true });
						},
						get: (...args) => {
							ops.push(d1Stmt.bind(...args));
							return Promise.resolve(undefined);
						},
						all: (...args) => {
							ops.push(d1Stmt.bind(...args));
							return Promise.resolve({ results: [] });
						},
						_stmt: d1Stmt,
					};
				},
				exec: () => Promise.resolve(),
				batch: (queries) => {
					const stmts = queries.map((q) => q._stmt || q);
					ops.push(...stmts);
					return Promise.resolve([]);
				},
			};
			await fn(txDb);
			if (ops.length > 0) {
				await d1.batch(ops);
			}
		},
		batch: (queries) => d1.batch(queries.map((q) => q._stmt || q)),
	};
}

export function getDb() {
	const store = envStore.getStore();
	if (!store?.DB) throw new Error('D1 binding "DB" is not available in this context');
	return d1CompatFrom(store.DB);
}
