const R2_PREFIX = 'staging';

export async function putStagedChunk(env, uploadId, index, data) {
  const key = `${R2_PREFIX}/${uploadId}/${index}`;
  await env.R2.put(key, data);
}

export async function getStagedChunks(env, uploadId) {
  const prefix = `${R2_PREFIX}/${uploadId}/`;
  const listed = await env.R2.list({ prefix });

  const chunks = await Promise.all(
    listed.objects
      .sort((a, b) => {
        const ai = Number(a.key.split('/').pop());
        const bi = Number(b.key.split('/').pop());
        return ai - bi;
      })
      .map(async (obj) => {
        const res = await env.R2.get(obj.key);
        return { index: Number(obj.key.split('/').pop()), body: res.body };
      })
  );

  return chunks;
}

export async function deleteStaged(env, uploadId) {
  const prefix = `${R2_PREFIX}/${uploadId}/`;
  const listed = await env.R2.list({ prefix });

  if (listed.objects.length === 0) return;

  const keys = listed.objects.map((obj) => obj.key);
  await env.R2.delete(keys);
}
