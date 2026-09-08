import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, envStore } from '../db.js';
import { requireAppUser } from '../middleware.js';
import { kvSet, kvGet, kvDelete } from '../kvStore.js';
import { putStagedChunk, getStagedChunks, deleteStaged } from '../staging.js';

function getState() {
  const store = envStore.getStore();
  return store?.STATE || null;
}

async function readJsonBody(req) {
  try {
    return await req._webRequest.json();
  } catch {
    return {};
  }
}

async function readFormData(req) {
  try {
    return await req._webRequest.formData();
  } catch {
    return null;
  }
}

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const cleaned = input.startsWith('/') ? input : `/${input}`;
  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

export function createUploadsRouter() {
  const router = Router();

  router.use(requireAppUser);

  const DEFAULT_UPLOAD_MAX_BYTES = 104857600;  // 100 MB
  const DEFAULT_MAX_CHUNK_BYTES = 26214400;    // 25 MB

  // POST /api/upload/init — initialize upload session
  router.post('/upload/init', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { file_name, size, mime_type, virtual_path = '/', remote_parent_id = null } = body;

      if (!file_name || size === undefined || size === null) {
        return res.status(400).json({ error: 'file_name and size are required' });
      }

      const db = getDb();
      const env = envStore.getStore();
      const userId = req.user.id;
      const fileSize = Number(size);

      const maxBytes = env?.UPLOAD_MAX_BYTES ? Number(env.UPLOAD_MAX_BYTES) : DEFAULT_UPLOAD_MAX_BYTES;
      if (fileSize > maxBytes) {
        return res.status(413).json({
          error: 'File size exceeds limit',
          data: { maxBytes, requestedBytes: fileSize },
        });
      }

      const { results: accounts } = await db.prepare(
        "SELECT * FROM cloud_accounts WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1"
      ).all(userId);

      if (!accounts.length) {
        return res.status(507).json({ error: 'No active cloud accounts \u2014 connect one first' });
      }

      const account = accounts[0];
      const path = normalizePath(virtual_path);
      const sessionId = randomUUID();
      const sessionToken = randomUUID();
      const now = new Date().toISOString();

      await db.prepare(`
        INSERT INTO upload_sessions (
          id, user_id, file_name, file_size, mime_type, virtual_path,
          remote_parent_id, cloud_account_id, status, session_token,
          bytes_uploaded, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, userId, file_name, fileSize, mime_type || null,
        path, remote_parent_id, account.id, 'initialized', sessionToken,
        0, now, now
      );

      const state = getState();
      if (state) {
        await kvSet(state, `upload:${sessionId}`, {
          id: sessionId, userId, fileName: file_name, fileSize,
          mimeType: mime_type, virtualPath: path, remoteParentId: remote_parent_id,
          cloudAccountId: account.id, status: 'initialized', bytesUploaded: 0, sessionToken,
        });
      }

      return res.status(201).json({
        data: {
          upload_id: sessionId,
          session_token: sessionToken,
          target_account: { id: account.id, provider: account.provider, email: account.email },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/upload/chunk — upload a chunk
  router.post('/upload/chunk', async (req, res, next) => {
    try {
      const formData = await readFormData(req);
      if (!formData) {
        return res.status(400).json({ error: 'Invalid form data' });
      }

      const uploadId = formData.get('upload_id');
      const chunkIndex = Number(formData.get('chunk_index'));
      const file = formData.get('file');

      if (!uploadId || isNaN(chunkIndex) || !file) {
        return res.status(400).json({ error: 'upload_id, chunk_index, and file are required' });
      }

      const db = getDb();
      const env = envStore.getStore();
      const userId = req.user.id;

      const session = await db.prepare(
        'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
      ).get(uploadId, userId);

      if (!session) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      const chunkId = randomUUID();
      const chunkData = await file.arrayBuffer();
      const chunkSize = chunkData.byteLength;

      const maxChunkBytes = env?.MAX_CHUNK_BYTES ? Number(env.MAX_CHUNK_BYTES) : DEFAULT_MAX_CHUNK_BYTES;
      if (chunkSize > maxChunkBytes) {
        return res.status(413).json({
          error: 'Chunk size exceeds limit',
          data: { maxBytes: maxChunkBytes, requestedBytes: chunkSize },
        });
      }

      const now = new Date().toISOString();

      const useR2 = env?.R2 != null;

      if (useR2) {
        await putStagedChunk(env, uploadId, chunkIndex, chunkData);
      } else {
        await db.prepare(`
          INSERT INTO upload_chunks (id, upload_id, chunk_index, chunk_data, chunk_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(chunkId, uploadId, chunkIndex, new Uint8Array(chunkData), chunkSize, now);
      }

      const newBytesUploaded = (session.bytes_uploaded || 0) + chunkSize;
      await db.prepare(
        'UPDATE upload_sessions SET bytes_uploaded = ?, updated_at = ? WHERE id = ?'
      ).run(newBytesUploaded, now, uploadId);

      const state = getState();
      if (state) {
        const kvSession = await kvGet(state, `upload:${uploadId}`);
        if (kvSession) {
          kvSession.bytesUploaded = newBytesUploaded;
          if (useR2) kvSession.useR2 = true;
          if (!kvSession.chunks) kvSession.chunks = [];
          kvSession.chunks.push({ index: chunkIndex, chunkId, size: chunkSize });
          await kvSet(state, `upload:${uploadId}`, kvSession);
        }
      }

      return res.json({
        data: {
          chunk_id: chunkId, chunk_index: chunkIndex,
          bytes_received: chunkSize, total_bytes_received: newBytesUploaded,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/upload/complete — finalize upload
  router.post('/upload/complete', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { upload_id } = body;

      if (!upload_id) {
        return res.status(400).json({ error: 'upload_id is required' });
      }

      const db = getDb();
      const env = envStore.getStore();
      const userId = req.user.id;

      const session = await db.prepare(
        'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
      ).get(upload_id, userId);

      if (!session) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      if (session.status === 'completed') {
        return res.json({ data: { status: 'already_completed' } });
      }

      let useR2 = false;
      const state = getState();
      if (state) {
        const kvSession = await kvGet(state, `upload:${upload_id}`);
        if (kvSession?.useR2) useR2 = true;
      }

      let chunkCount;
      let assembled;
      const now = new Date().toISOString();

      if (useR2 && env?.R2) {
        const stagedChunks = await getStagedChunks(env, upload_id);
        if (!stagedChunks.length) {
          return res.status(400).json({ error: 'No chunks uploaded' });
        }
        chunkCount = stagedChunks.length;
        assembled = new Uint8Array(session.file_size);
        let offset = 0;
        for (const chunk of stagedChunks) {
          const reader = chunk.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            assembled.set(value, offset);
            offset += value.byteLength;
          }
        }
        await deleteStaged(env, upload_id);
      } else {
        const { results: chunks } = await db.prepare(
          'SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC'
        ).all(upload_id);

        if (!chunks.length) {
          return res.status(400).json({ error: 'No chunks uploaded' });
        }

        chunkCount = chunks.length;
        assembled = new Uint8Array(session.file_size);
        let offset = 0;
        for (const chunk of chunks) {
          const chunkData = new Uint8Array(chunk.chunk_data);
          assembled.set(chunkData, offset);
          offset += chunkData.byteLength;
        }

        await db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(upload_id);
      }

      const maxBytes = env?.UPLOAD_MAX_BYTES ? Number(env.UPLOAD_MAX_BYTES) : DEFAULT_UPLOAD_MAX_BYTES;
      if (assembled.byteLength > maxBytes) {
        return res.status(413).json({
          error: 'Assembled file exceeds size limit',
          data: { maxBytes, requestedBytes: assembled.byteLength },
        });
      }

      await db.prepare(
        "UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?"
      ).run(now, upload_id);

      if (state) {
        await kvDelete(state, `upload:${upload_id}`);
      }

      return res.json({
        data: {
          upload_id, status: 'completed',
          bytes_assembled: assembled.byteLength, chunk_count: chunkCount,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/upload/:uploadId — cancel upload
  router.delete('/upload/:uploadId', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const uploadId = req.params.uploadId;

      const session = await db.prepare(
        'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
      ).get(uploadId, userId);

      if (!session) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      const now = new Date().toISOString();

      await db.prepare(
        "UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE id = ?"
      ).run(now, uploadId);

      await db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);

      const state = getState();
      if (state) {
        await kvDelete(state, `upload:${uploadId}`);
      }

      return res.json({ data: { success: true, upload_id: uploadId } });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/upload/:uploadId/progress — SSE endpoint for progress
  router.get('/upload/:uploadId/progress', async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.id;
      const uploadId = req.params.uploadId;

      const session = await db.prepare(
        'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
      ).get(uploadId, userId);

      if (!session) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const sendProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const percent = session.file_size > 0
        ? Math.min(100, Math.round((session.bytes_uploaded / session.file_size) * 100))
        : 0;

      sendProgress({
        type: 'upload:progress', uploadId,
        bytes: session.bytes_uploaded, totalBytes: session.file_size,
        percent, status: session.status,
      });

      if (['completed', 'cancelled', 'failed'].includes(session.status)) {
        res.end();
        return;
      }

      const state = getState();
      const pollInterval = 500;
      const maxDuration = 5 * 60 * 1000;
      let elapsed = 0;
      let closed = false;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try { res.end(); } catch {}
      };

      const interval = setInterval(async () => {
        elapsed += pollInterval;
        if (elapsed >= maxDuration) {
          closeStream();
          return;
        }

        try {
          let currentBytes = session.bytes_uploaded;
          let currentStatus = 'uploading';

          if (state) {
            const kvSession = await kvGet(state, `upload:${uploadId}`);
            if (kvSession) {
              currentBytes = kvSession.bytesUploaded || 0;
              currentStatus = kvSession.status || 'uploading';
            } else {
              const { results } = await db.prepare(
                'SELECT bytes_uploaded, status FROM upload_sessions WHERE id = ?'
              ).all(uploadId);
              if (results.length) {
                currentBytes = results[0].bytes_uploaded;
                currentStatus = results[0].status;
              }
            }
          }

          const p = session.file_size > 0
            ? Math.min(100, Math.round((currentBytes / session.file_size) * 100))
            : 0;

          sendProgress({
            type: 'upload:progress', uploadId,
            bytes: currentBytes, totalBytes: session.file_size,
            percent: p, status: currentStatus,
          });

          if (['completed', 'cancelled', 'failed'].includes(currentStatus)) {
            closeStream();
          }
        } catch {
          closeStream();
        }
      }, pollInterval);

      req._webRequest.signal?.addEventListener('abort', closeStream);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/upload/assemble — assemble chunks into final file
  router.post('/upload/assemble', async (req, res, next) => {
    try {
      const body = await readJsonBody(req);
      const { upload_id } = body;

      if (!upload_id) {
        return res.status(400).json({ error: 'upload_id is required' });
      }

      const db = getDb();
      const env = envStore.getStore();
      const userId = req.user.id;

      const session = await db.prepare(
        'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
      ).get(upload_id, userId);

      if (!session) {
        return res.status(404).json({ error: 'Upload session not found' });
      }

      if (session.status === 'completed') {
        return res.json({ data: { status: 'already_completed' } });
      }

      let useR2 = false;
      const state = getState();
      if (state) {
        const kvSession = await kvGet(state, `upload:${upload_id}`);
        if (kvSession?.useR2) useR2 = true;
      }

      let chunkCount;
      let assembled;
      const now = new Date().toISOString();

      if (useR2 && env?.R2) {
        const stagedChunks = await getStagedChunks(env, upload_id);
        if (!stagedChunks.length) {
          return res.status(400).json({ error: 'No chunks uploaded' });
        }
        chunkCount = stagedChunks.length;
        assembled = new Uint8Array(session.file_size);
        let offset = 0;
        for (const chunk of stagedChunks) {
          const reader = chunk.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            assembled.set(value, offset);
            offset += value.byteLength;
          }
        }
        await deleteStaged(env, upload_id);
      } else {
        const { results: chunks } = await db.prepare(
          'SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC'
        ).all(upload_id);

        if (!chunks.length) {
          return res.status(400).json({ error: 'No chunks uploaded' });
        }

        chunkCount = chunks.length;
        assembled = new Uint8Array(session.file_size);
        let offset = 0;
        for (const chunk of chunks) {
          const chunkData = new Uint8Array(chunk.chunk_data);
          assembled.set(chunkData, offset);
          offset += chunkData.byteLength;
        }

        await db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(upload_id);
      }

      const maxBytes = env?.UPLOAD_MAX_BYTES ? Number(env.UPLOAD_MAX_BYTES) : DEFAULT_UPLOAD_MAX_BYTES;
      if (assembled.byteLength > maxBytes) {
        return res.status(413).json({
          error: 'Assembled file exceeds size limit',
          data: { maxBytes, requestedBytes: assembled.byteLength },
        });
      }

      await db.prepare(
        "UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?"
      ).run(now, upload_id);

      if (state) {
        await kvDelete(state, `upload:${upload_id}`);
      }

      return res.json({
        data: {
          upload_id, status: 'completed',
          bytes_assembled: assembled.byteLength, chunk_count: chunkCount,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
