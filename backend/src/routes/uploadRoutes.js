import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { selectBestAccount, toFreeSpaceView } from '../services/spaceAllocator.js';
import { env } from '../config/env.js';
import { createUploadSession } from '../services/uploadSessionService.js';
import { handleUpload } from '../services/uploadService.js';

const router = Router();

router.use(requireAppUser);

router.post('/uploads/initiate', (req, res) => {
	const { file_name, size, mime_type, virtual_path = '/', remote_parent_id = null } = req.body;

	if (!file_name || size === undefined || size === null) {
		return res.status(400).json({ error: 'file_name and size are required' });
	}

	const allocation = selectBestAccount(req.user.id, Number(size));
	const requiredBytes = Number(size) || 0;
	const selectedView = toFreeSpaceView(allocation.selected);

	if (requiredBytes > selectedView.freeSpace && env.quotaHardLimitEnabled) {
		const perAccount = [allocation.selected, ...allocation.fallbackChain].map((account) => {
			const view = toFreeSpaceView(account);
			return {
				id: view.id,
				provider: view.provider,
				email: view.email,
				totalBytes: Number(view.total_space || 0),
				usedBytes: Number(view.used_space || 0),
				freeBytes: view.freeSpace,
				soft: view.usedRatio >= 0.85,
			};
		});
		return res.status(507).json({
			error: 'Insufficient storage available — free some space or connect another account',
			data: { perAccount },
		});
	}

	const session = createUploadSession({
		user_id: req.user.id,
		file_name,
		size: Number(size),
		mime_type,
		virtual_path,
		remote_parent_id,
		cloud_account_id: allocation.selected.id,
		fallback_chain: allocation.fallbackChain.map((account) => account.id),
	});

	return res.status(201).json({
		data: {
			upload_id: session.id,
			session_token: session.token,
			target_account: {
				id: allocation.selected.id,
				provider: allocation.selected.provider,
				email: allocation.selected.email,
			},
		},
	});
});

router.post('/uploads/:uploadId/stream', async (req, res, next) => {
	try {
		const metadata = await handleUpload(req, req.params.uploadId);
		res.status(201).json({ data: metadata });
	} catch (error) {
		next(error);
	}
});

export default router;
