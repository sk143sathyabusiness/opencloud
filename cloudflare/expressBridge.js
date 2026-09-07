class BridgeResponse {
	constructor() {
		this.statusCode = 200;
		this.headersSent = false;
		this.finished = false;
		this.writableEnded = false;
		this._headers = new Headers();
		this._chunks = [];
		this.socket = undefined;
		this.connection = undefined;
		this.locals = {};
		this._finishResolvers = [];

		this.getHeader = (n) => this._headers.get(n) ?? undefined;
		this.getHeaders = () => Object.fromEntries(this._headers.entries());
		this.setHeader = (n, v) => { this._headers.set(n, String(v)); };
		this.removeHeader = (n) => { this._headers.delete(n); };
		this.hasHeader = (n) => this._headers.has(n);
		this.append = (n, v) => { const cur = this._headers.get(n); this._headers.set(n, cur ? `${cur}, ${v}` : String(v)); };
		this.flushHeaders = () => {};
		this.getHeaderNames = () => [...this._headers.keys()];

		this.status = (code) => { this.statusCode = code; return this; };
		this.sendStatus = (code) => { return this.status(code).end(String(code)); };
		this.send = (body) => { if (body !== undefined && body !== null) this._chunks.push(Buffer.from(body)); return this.end(); };
		this.json = (body) => { this.setHeader('Content-Type', 'application/json; charset=utf-8'); return this.send(JSON.stringify(body)); };
		this.writeHead = (code, headers) => { this.statusCode = code; if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); return this; };
		this.write = (chunk) => { this._chunks.push(Buffer.from(chunk)); return true; };
		this.end = (chunk) => { if (chunk) this._chunks.push(Buffer.from(chunk)); this.headersSent = true; this.finished = true; this.writableEnded = true; for (const r of this._finishResolvers) r(); return this; };
		this.on = (evt, fn) => { if (evt === 'finish' && this.finished) queueMicrotask(fn); else if (evt === 'finish') this._finishResolvers.push(fn); return this; };
		this.once = (evt, fn) => { return this.on(evt, fn); };
		this.emit = () => true;
	}
}

function parseCookies(header = '') {
	return Object.fromEntries(String(header || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

export function createBridgeRequest(request, user) {
	const url = new URL(request.url);
	const headers = Object.fromEntries(request.headers.entries());
	return {
		method: request.method,
		url: url.pathname + url.search,
		path: url.pathname,
		query: Object.fromEntries(url.searchParams),
		headers,
		get(name) { return headers[String(name).toLowerCase()]; },
		header(name) { return this.get(name); },
		body: undefined,
		cookies: parseCookies(headers.cookie),
		user,
		_webRequest: request,
	};
}

export async function runExpress(app, request, { user } = {}) {
	const req = createBridgeRequest(request, user);
	const res = new BridgeResponse();
	try {
		app(req, res);
	} catch (err) {
		res.status(500).json({ error: err?.message || 'Internal server error' });
	}
	if (!res.finished) {
		await new Promise((resolve) => res.once('finish', resolve));
	}
	const body = res._chunks.length ? Buffer.concat(res._chunks) : null;
	return new Response(body, { status: res.statusCode, headers: res._headers });
}
