import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * 嵌入维度的自动探测（P10）。
 *
 * 维度不是元数据，它只能从一次真实响应里量出来：`text-embedding-3-small` 可以按参数截断，
 * 自建 bge / m3e 更是随部署而变。用户手填而猜错，失败发生在「索引跑到一半」，所以这条
 * 路径要钉住两件事——确实读的是响应向量的长度，以及空向量时**报错而不是返回 0**
 * （0 维度会被当成合法配置存下来，然后所有向量都对不上）。
 */

const client = await importTypeScriptModule('src/main/plugins/research/embedding-client.ts', {
  platform: 'node'
});

test('probeDimensions 读回真实向量长度', async () => {
  const embedding = new client.OpenAICompatibleEmbeddingClient(async (url, init) => {
    assert.equal(url, 'https://x/v1/embeddings');
    assert.deepEqual(JSON.parse(init.body).input, ['dimension probe']);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  });
  assert.equal(await embedding.probeDimensions({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }), 3);
});

test('probeDimensions 对空向量报错而不是返回 0', async () => {
  const embedding = new client.OpenAICompatibleEmbeddingClient(
    async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), { status: 200 })
  );
  await assert.rejects(
    () => embedding.probeDimensions({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }),
    /embedding_provider_dimensions_unknown/
  );
});
