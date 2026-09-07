import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import {
	createShareLink,
	listShareLinks,
	revokeShareLink,
	getShareLinkByToken,
	touchShareLink,
	verifyPassword,
} from '../services/shareService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';

const router = Router();

router.post('/share', requireAppUser, (req, res) => {
	const { fileId, expiresInDays = 7, password } = req.body;
	if (!fileId) {
		return res.status(400).json({ error: 'fileId is required' });
	}
	const link = createShareLink({
		userId: req.user.id,
		fileId,
		expiresInDays: Number(expiresInDays),
		password: password || undefined,
	});
	return res.status(201).json({ data: link });
});

router.get('/share', requireAppUser, (_req, res) => {
	return res.json({ data: listShareLinks(_req.user.id) });
});

router.delete('/share/:token', requireAppUser, (req, res) => {
	return res.json({ data: revokeShareLink(req.user.id, req.params.token) });
});

function resolvePublicLink(req, res) {
	const link = getShareLinkByToken(req.params.token);
	if (!link || link.expired || link.is_folder) {
		res.status(404).json({ error: 'Link not found' });
		return null;
	}
	return link;
}

router.get('/share/:token/info', (req, res) => {
	const link = resolvePublicLink(req, res);
	if (!link) return;
	return res.json({
		data: {
			file_name: link.file_name,
			size: link.size,
			mime_type: link.mime_type,
			expires_at: link.expires_at,
			created_at: link.created_at,
			download_count: link.download_count,
			has_password: Boolean(link.password_hash),
		},
	});
});

router.get('/share/:token/download', async (req, res, next) => {
	try {
		const link = resolvePublicLink(req, res);
		if (!link) return;

		if (link.password_hash) {
			const provided = req.get('x-link-password') || '';
			if (!verifyPassword(provided, link.password_hash)) {
				return res.status(401).json({ error: 'Wrong or missing link password' });
			}
		}

		const account = getAccountById(link.user_id, link.cloud_account_id);
		if (!account) {
			return res.status(404).json({ error: 'Link not found' });
		}

		const adapter = createAdapter(account);
		const stream = await adapter.getDownloadStream({
			remote_file_id: link.remote_file_id,
			remote_parent_id: null,
			file_name: link.file_name,
			virtual_path: '/',
			is_folder: Boolean(link.is_folder),
			size: link.size,
			mime_type: link.mime_type,
		});

		touchShareLink(link.token);
		res.setHeader('Content-Disposition', `attachment; filename="${link.file_name}"`);
		res.setHeader('Content-Type', link.mime_type || 'application/octet-stream');
		stream.pipe(res);
	} catch (error) {
		next(error);
	}
});

export default router;
