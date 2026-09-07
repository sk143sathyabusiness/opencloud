import { randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { listAllFiles, createFileMetadata, getTrashedRemoteIds } from './fileService.js';

function joinPath(parentPath, name) {
	const base = parentPath === '/' || !parentPath ? '/' : parentPath;
	const clean = base.endsWith('/') ? base : `${base}/`;
	return `${clean}${String(name).replace(/^\/+/, '')}`;
}

export function listTrashedFiles(userId) {
	return db
		.prepare(`
			SELECT t.*, ca.provider
			FROM trash t
			LEFT JOIN cloud_accounts ca ON ca.id = t.cloud_account_id
			WHERE t.user_id = ?
			ORDER BY t.deleted_at DESC, t.file_name COLLATE NOCASE
		`)
		.all(userId);
}

export function softDeleteFilesByIds(userId, ids) {
	const all = listAllFiles(userId);
	const byId = new Map(all.map((row) => [row.id, row]));
	const insert = db.prepare(`
		INSERT OR IGNORE INTO trash (
			id, user_id, cloud_account_id, remote_file_id, remote_parent_id,
			virtual_path, file_name, is_folder, size, mime_type,
			remote_created_time, remote_modified_time, deleted_at
		) VALUES (
			@id, @user_id, @cloud_account_id, @remote_file_id, @remote_parent_id,
			@virtual_path, @file_name, @is_folder, @size, @mime_type,
			@remote_created_time, @remote_modified_time, @deleted_at
		)
	`);

	const run = db.transaction(() => {
		let trashed = 0;
		const missing = [];
		const removeIds = [];
		const deletedAt = new Date().toISOString();
		for (const rawId of ids || []) {
			const root = byId.get(rawId);
			if (!root) {
				missing.push(rawId);
				continue;
			}

			const folderPath = root.is_folder
				? joinPath(root.virtual_path, root.file_name)
				: null;
			const targets = [root];
			if (folderPath) {
				for (const row of all) {
					if (row.virtual_path.startsWith(folderPath)) targets.push(row);
				}
			}
			for (const target of targets) {
				if (!byId.has(target.id)) continue;
				insert.run({
					id: randomUUID(),
					user_id: userId,
					cloud_account_id: target.cloud_account_id,
					remote_file_id: target.remote_file_id,
					remote_parent_id: target.remote_parent_id,
					virtual_path: target.virtual_path,
					file_name: target.file_name,
					is_folder: target.is_folder ? 1 : 0,
					size: Number(target.size || 0),
					mime_type: target.mime_type || null,
					remote_created_time: target.remote_created_time || null,
					remote_modified_time: target.remote_modified_time || null,
deleted_at: deletedAt,
			});
				byId.delete(target.id);
				removeIds.push(target.id);
				trashed += 1;
			}
		}
		if (removeIds.length) {
			const del = db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?');
			for (const id of removeIds) del.run(userId, id);
		}
		return { trashed, skipped: missing.length };
	});

	return run();
}

export function restoreTrashedFiles(userId, ids) {
	const rows = getTrashedRowsByIds(userId, ids);
	const restore = db.transaction(() => {
		let restored = 0;
		for (const row of rows) {
			createFileMetadata({
				user_id: userId,
				virtual_path: row.virtual_path,
				file_name: row.file_name,
				is_folder: row.is_folder,
				size: row.size,
				mime_type: row.mime_type,
				cloud_account_id: row.cloud_account_id,
				remote_file_id: row.remote_file_id,
				remote_parent_id: row.remote_parent_id,
				remote_created_time: row.remote_created_time,
				remote_modified_time: row.remote_modified_time,
			});
			db.prepare('DELETE FROM trash WHERE user_id = ? AND id = ?').run(userId, row.id);
			restored += 1;
		}
		return restored;
	});
	return { restored: restore() };
}

export function getTrashedRowsByIds(userId, ids) {
	if (!ids?.length) return [];
	const placeholders = ids.map(() => '?').join(', ');
	return db
		.prepare(`SELECT * FROM trash WHERE user_id = ? AND id IN (${placeholders})`)
		.all(userId, ...ids);
}

export function removeTrashedRows(userId, ids) {
	if (!ids?.length) return;
	const placeholders = ids.map(() => '?').join(', ');
	db.prepare(`DELETE FROM trash WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids);
}

export function getExpiredTrashRows(userId, cutoffIso) {
	return db
		.prepare('SELECT * FROM trash WHERE user_id = ? AND deleted_at < ?')
		.all(userId, cutoffIso);
}

export function getTrashUserIds() {
	return db.prepare('SELECT DISTINCT user_id FROM trash').all().map((row) => row.user_id);
}