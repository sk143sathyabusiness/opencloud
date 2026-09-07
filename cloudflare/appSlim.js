import express from 'express';
import { getDb } from './db.js';
import { env } from '../backend/src/config/env.js';

function toPublic(row) {
	return {
		id: row.id,
		file_id: row.file_id,
		file_name: row.file_name,
		size: row.size,
		mime_type: row.mime_type,
		is_folder: row.is_folder,
		token: row.token,
		expires_at: row.expires_at,
		download_count: row.download_count,
		url: `${env.frontendUrl}/s/${row.token}`,
		expired: !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now(),
	};
}

export function createSlimApp() {
	const app = express();
	app.use(express.json());

	app.get('/api/health', (_req, res) => {
		res.json({ status: 'ok', appMode: env.appMode, port: env.port });
	});

	app.get('/api/files', async (req, res) => {
		if (!req.user) return res.status(401).json({ error: 'Authentication required' });
		const db = getDb();
		const path = typeof req.query.path === 'string' ? req.query.path : '/';
		const rows = (await db.prepare(
			'SELECT * FROM file_metadata WHERE user_id = ? AND virtual_path = ? ORDER BY is_folder DESC, file_name COLLATE NOCASE',
		).all(req.user.id, normalizePath(path))).results;
		res.json({ files: rows });
	});

	app.get('/api/share/:token/info', async (req, res) => {
		const db = getDb();
		const row = await db.prepare('SELECT * FROM share_links WHERE token = ?').get(req.params.token);
		if (!row || row.is_folder || toPublic(row).expired) return res.status(404).json({ error: 'Share link not found' });
		res.json({ data: toPublic(row) });
	});

	return app;
}

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}