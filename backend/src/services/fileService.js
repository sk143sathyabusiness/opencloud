import { randomUUID } from 'crypto';
import { db } from '../config/database.js';
import { resolveMimeType } from '../utils/mime.js';

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const cleaned = input.startsWith('/') ? input : `/${input}`;
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

function joinPath(parentPath, name) {
	const base = parentPath === '/' || !parentPath ? '/' : parentPath;
	const clean = base.endsWith('/') ? base : `${base}/`;
	return `${clean}${String(name).replace(/^\/+/, '')}`;
}

export function getFolderByPath(userId, virtualPath) {
	const target = normalizePath(virtualPath);
	if (target === '/') return null;
	const rows = listAllFiles(userId);
	return rows.find(
		(row) => row.is_folder === 1 && normalizePath(joinPath(row.virtual_path, row.file_name)) === target,
	) || null;
}

export function getDescendants(rows, rootRow) {
	const folderPath = normalizePath(joinPath(rootRow.virtual_path, rootRow.file_name));
	return rows.filter((row) => row.virtual_path.startsWith(folderPath));
}

function buildDisplayNames(rows) {
	return rows.map((row) => ({
		...row,
		createdTime: row.remote_created_time || null,
		modifiedTime: row.remote_modified_time || null,
		capabilities: {
			starred: row.provider === 'google_drive',
			rename: true,
			delete: true,
		},
	}));
}

export function listFilesByPath(userId, virtualPath = '/') {
	const normalized = normalizePath(virtualPath);
	const rows = db
		.prepare(`
      SELECT
        fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND fm.virtual_path = ?
				AND ca.status = 'active'
      ORDER BY fm.is_folder DESC, fm.file_name COLLATE NOCASE ASC
    `)
		.all(userId, normalized);

	return buildDisplayNames(rows);
}

export function searchFiles(userId, term = '', limitOrOptions = 50) {
	const options = typeof limitOrOptions === 'object' && limitOrOptions !== null
		? limitOrOptions
		: { limit: limitOrOptions };
	const normalizedTerm = String(term || '').trim();
	if (!normalizedTerm) return [];

	const safeLimit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
	// Split on whitespace for multi-token AND search, escape LIKE wildcards.
	const escapeLike = (value) => String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
	const tokens = normalizedTerm.split(/\s+/).filter(Boolean).slice(0, 8);
	if (!tokens.length) return [];

	const where = ['fm.user_id = ?', `ca.status = 'active'`];
	const params = [userId];

	if (options.provider) {
		where.push('ca.provider = ?');
		params.push(String(options.provider));
	}
	if (options.accountId) {
		where.push('fm.cloud_account_id = ?');
		params.push(String(options.accountId));
	}
	if (options.type === 'folder') {
		where.push('fm.is_folder = 1');
	} else if (options.type === 'file') {
		where.push('fm.is_folder = 0');
	}

	// Every token must match at least one searchable field (global search).
	const tokenClauses = tokens.map(() => `(
				fm.file_name LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR fm.mime_type LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR fm.virtual_path LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR ca.provider LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR ca.email LIKE ? ESCAPE '\\' COLLATE NOCASE
			)`);
	for (const token of tokens) {
		const pattern = `%${escapeLike(token)}%`;
		params.push(pattern, pattern, pattern, pattern, pattern);
	}

	const firstPattern = `%${escapeLike(tokens[0])}%`;
	const rows = db
		.prepare(`
      SELECT
        fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE ${where.join(' AND ')}
				AND ${tokenClauses.join(' AND ')}
      ORDER BY
				CASE WHEN fm.file_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
				fm.is_folder DESC,
				COALESCE(fm.remote_modified_time, fm.remote_created_time, fm.updated_at) DESC,
				fm.file_name COLLATE NOCASE ASC
			LIMIT ?
    `)
		.all(...params, `${firstPattern}`, safeLimit);

	return buildDisplayNames(rows);
}

export function createFileMetadata(record) {
	const payload = {
		id: randomUUID(),
		user_id: record.user_id,
		virtual_path: normalizePath(record.virtual_path),
		file_name: record.file_name,
		is_folder: record.is_folder ? 1 : 0,
		size: record.size,
		mime_type: resolveMimeType(record),
		cloud_account_id: record.cloud_account_id,
		remote_file_id: record.remote_file_id,
		remote_parent_id: record.remote_parent_id || null,
		remote_created_time: record.remote_created_time || null,
		remote_modified_time: record.remote_modified_time || null,
	};

	db.prepare(`
    INSERT INTO file_metadata (
			id, user_id, virtual_path, file_name, is_folder, size, mime_type,
			cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
    ) VALUES (
			@id, @user_id, @virtual_path, @file_name, @is_folder, @size, @mime_type,
			@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
    )
  `).run(payload);

	return getFileById(payload.user_id, payload.id);
}

export function getFileById(userId, id) {
	const row = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND fm.id = ? AND ca.status = 'active'
    `)
		.get(userId, id);

	if (!row) return row;
	return buildDisplayNames([row])[0];
}

export function getFileByRemoteId(userId, cloudAccountId, remoteFileId) {
	const row = db
		.prepare(`
      SELECT fm.*, ca.provider, ca.email
      FROM file_metadata fm
      INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND fm.cloud_account_id = ? AND fm.remote_file_id = ? AND ca.status = 'active'
    `)
		.get(userId, cloudAccountId, remoteFileId);

	if (!row) return row;
	return buildDisplayNames([row])[0];
}

export function listAllFiles(userId) {
	return db.prepare('SELECT * FROM file_metadata WHERE user_id = ?').all(userId);
}

export function getTrashedRemoteIds(userId, cloudAccountId) {
	const rows = db
		.prepare('SELECT remote_file_id FROM trash WHERE user_id = ? AND cloud_account_id = ?')
		.all(userId, cloudAccountId);
	return new Set(rows.map((row) => row.remote_file_id));
}

export function listStarredFiles(userId) {
	const rows = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ? AND COALESCE(fm.is_starred, 0) = 1 AND ca.status = 'active'
			ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
				fm.updated_at DESC,
				fm.file_name COLLATE NOCASE ASC
		`)
		.all(userId);

	return buildDisplayNames(rows);
}

export function listRecentFiles(userId) {
	const rows = db
		.prepare(`
			SELECT fm.*, ca.provider, ca.email
			FROM file_metadata fm
			INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
			WHERE fm.user_id = ?
				AND fm.is_folder = 0
				AND ca.status = 'active'
			ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC,
				fm.updated_at DESC,
				fm.file_name COLLATE NOCASE ASC
		`)
		.all(userId);

	return buildDisplayNames(rows);
}

export function updateFileStarredByRemoteId(userId, cloudAccountId, remoteFileId, isStarred) {
	return db.prepare(`
		UPDATE file_metadata
		SET is_starred = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND cloud_account_id = ? AND remote_file_id = ?
	`).run(isStarred ? 1 : 0, userId, cloudAccountId, remoteFileId);
}

export function setFileStarred(userId, fileId, isStarred) {
	return db.prepare(`
		UPDATE file_metadata
		SET is_starred = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND id = ?
	`).run(isStarred ? 1 : 0, userId, fileId);
}

export function replaceFilesForAccount(userId, cloudAccountId, records) {
	const trashedIds = getTrashedRemoteIds(userId, cloudAccountId);
	const normalizedRecords = records
		.filter((record) => !trashedIds.has(record.remote_file_id))
		.map((record) => ({
		id: record.id || randomUUID(),
		user_id: userId,
		virtual_path: normalizePath(record.virtual_path),
		file_name: record.file_name,
		is_folder: record.is_folder ? 1 : 0,
		is_starred: record.is_starred ? 1 : 0,
		size: Number(record.size || 0),
		mime_type: resolveMimeType(record),
		cloud_account_id: cloudAccountId,
		remote_file_id: record.remote_file_id,
		remote_parent_id: record.remote_parent_id || null,
		remote_created_time: record.remote_created_time || null,
		remote_modified_time: record.remote_modified_time || null,
	}));

	const replace = db.transaction(() => {
		db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').run(userId, cloudAccountId);

		if (!normalizedRecords.length) {
			return;
		}

		const insert = db.prepare(`
      INSERT INTO file_metadata (
				id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
				cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
      ) VALUES (
				@id, @user_id, @virtual_path, @file_name, @is_folder, @is_starred, @size, @mime_type,
				@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
      )
    `);

		normalizedRecords.forEach((record) => insert.run(record));
	});

	replace();
}

export function clearFilesForAccount(userId, cloudAccountId) {
	db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').run(userId, cloudAccountId);
}

export function upsertFileMetadata(record) {
	db.prepare(`
    INSERT INTO file_metadata (
			id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
			cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
    ) VALUES (
			@id, @user_id, @virtual_path, @file_name, @is_folder, @is_starred, @size, @mime_type,
			@cloud_account_id, @remote_file_id, @remote_parent_id, @remote_created_time, @remote_modified_time
    )
    ON CONFLICT(id) DO UPDATE SET
			user_id = excluded.user_id,
      virtual_path = excluded.virtual_path,
      file_name = excluded.file_name,
      is_folder = excluded.is_folder,
			is_starred = excluded.is_starred,
      size = excluded.size,
      mime_type = excluded.mime_type,
      cloud_account_id = excluded.cloud_account_id,
      remote_file_id = excluded.remote_file_id,
      remote_parent_id = excluded.remote_parent_id,
	  remote_created_time = excluded.remote_created_time,
	  remote_modified_time = excluded.remote_modified_time,
      updated_at = CURRENT_TIMESTAMP
  `).run({
		...record,
		virtual_path: normalizePath(record.virtual_path),
		user_id: record.user_id,
		is_folder: record.is_folder ? 1 : 0,
		is_starred: record.is_starred ? 1 : 0,
	});
}

export function listDirectoryTree(userId) {
	return db
		.prepare(`
      SELECT id, virtual_path, file_name, is_folder, cloud_account_id
      FROM file_metadata
      WHERE user_id = ?
      ORDER BY virtual_path, is_folder DESC, file_name
    `)
		.all(userId);
}
