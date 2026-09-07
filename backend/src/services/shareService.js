import { randomBytes, randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { getFileById } from './fileService.js';
import { hashPassword, verifyPassword } from './authService.js';

function linkUrl(token) {
	return `${env.frontendUrl}/s/${token}`;
}

function toPublic(row) {
	return {
		...row,
		url: linkUrl(row.token),
		expired: Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now()),
	};
}

export function createShareLink({ userId, fileId, expiresInDays = 7, password }) {
	const file = getFileById(userId, fileId);
	if (!file) {
		const err = new Error('File not found');
		err.status = 400;
		throw err;
	}
	if (file.is_folder) {
		const err = new Error('Folders are not shareable');
		err.status = 400;
		throw err;
	}

	const token = randomBytes(16).toString('hex');
	const expiresAt = Number(expiresInDays) > 0
		? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000).toISOString()
		: null;

	db.prepare(`
		INSERT INTO share_links (
			id, user_id, file_id, cloud_account_id, remote_file_id,
			file_name, size, mime_type, is_folder,
			token, password_hash, expires_at
		) VALUES (
			@id, @user_id, @file_id, @cloud_account_id, @remote_file_id,
			@file_name, @size, @mime_type, @is_folder,
			@token, @password_hash, @expires_at
		)
	`).run({
		id: randomUUID(),
		user_id: userId,
		file_id: file.id,
		cloud_account_id: file.cloud_account_id,
		remote_file_id: file.remote_file_id,
		file_name: file.file_name,
		size: Number(file.size || 0),
		mime_type: file.mime_type || null,
		is_folder: file.is_folder ? 1 : 0,
		token,
		password_hash: password ? hashPassword(password) : null,
		expires_at: expiresAt,
	});

	return { token, url: linkUrl(token), expiresAt };
}

export function listShareLinks(userId) {
	return db
		.prepare('SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC')
		.all(userId)
		.map(toPublic);
}

export function revokeShareLink(userId, token) {
	const result = db
		.prepare('DELETE FROM share_links WHERE user_id = ? AND token = ?')
		.run(userId, token);
	return { revoked: result.changes };
}

export function getShareLinkByToken(token) {
	const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
	return row ? toPublic(row) : null;
}

export function touchShareLink(token) {
	db.prepare(`
		UPDATE share_links
		SET download_count = download_count + 1, last_used_at = CURRENT_TIMESTAMP
		WHERE token = ?
	`).run(token);
}

export { verifyPassword };
