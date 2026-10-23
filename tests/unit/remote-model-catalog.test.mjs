import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * 「拉取模型」与「维度探测」这两个新功能各自有一个容易悄悄变错的地方，这里各钉一处：
 *
 *  1. **端点归一化**。用户填 `https://x/v1`、`https://x/v1/`、`https://x/v1/models` 都是
 *     合理输入，但只有一种结果是正确的请求地址。旧的 `embed()` 里这条逻辑是内联的一行
 *     三元表达式，重复出现就会漂移（嵌入与模型列表各写一遍，一边改了一边没改）。
 *  2. **两种响应形状**。OpenAI 家族给 `{ data: [...] }`，Ollama 原生给 `{ models: [...] }`。
 *     形状不认识时必须报错，不能返回空列表——空列表会被读成「这个端点没有模型」，那是
 *     另一种事实，用户会去错的地方找问题。
 */

const catalog = await importTypeScriptModule('src/main/services/remote-model-catalog.ts', {
  platform: 'node'
});

test('resolveModelListUrl 归一化三种合理写法', () => {
  assert.equal(catalog.resolveModelListUrl('https://x/v1'), 'https://x/v1/models');
  assert.equal(catalog.resolveModelListUrl('https://x/v1/'), 'https://x/v1/models');
  assert.equal(catalog.resolveModelListUrl('  https://x/v1//  '), 'https://x/v1/models');
  assert.equal(catalog.resolveModelListUrl('https://x/v1/models'), 'https://x/v1/models');
});

test('listRemoteModels 接受 OpenAI 与 Ollama 两种形状并去重', async () => {
  const openai = await catalog.listRemoteModels({
    endpoint: 'https://x/v1',
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://x/v1/models');
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      return new Response(JSON.stringify({ data: [{ id: 'a', owned_by: 'x' }, { id: 'a' }, { id: 'b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.deepEqual(openai.models.map((entry) => entry.id), ['a', 'b']);
  assert.equal(openai.models[0].ownedBy, 'x');
  assert.equal(openai.models[1].ownedBy, null);

  const ollama = await catalog.listRemoteModels({
    endpoint: 'http://127.0.0.1:11434/api',
    apiKey: null,
    fetchImpl: async (_url, init) => {
      // 没有 key 时绝不能发出空的 Authorization 头：部分服务会因此判 401。
      assert.equal(init.headers.authorization, undefined);
      return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
    }
  });
  assert.deepEqual(ollama.models, [{ id: 'qwen3:8b', ownedBy: null }]);
});

test('listRemoteModels 把「形状不认识」与「端点没有模型」区分开', async () => {
  await assert.rejects(
    () =>
      catalog.listRemoteModels({
        endpoint: 'https://x/v1',
        apiKey: null,
        fetchImpl: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })
      }),
    (error) => error.code === 'remote_model_list_malformed'
  );
  const empty = await catalog.listRemoteModels({
    endpoint: 'https://x/v1',
    apiKey: null,
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  });
  assert.deepEqual(empty.models, []);
});

test('listRemoteModels 拒绝非 URL 与无协议地址', async () => {
  await assert.rejects(
    () => catalog.listRemoteModels({ endpoint: 'api.openai.com/v1', apiKey: null }),
    (error) => error.code === 'remote_model_endpoint_invalid'
  );
  await assert.rejects(
    () => catalog.listRemoteModels({ endpoint: '   ', apiKey: null }),
    (error) => error.code === 'remote_model_endpoint_empty'
  );
});

/**
 * 地址里夹带凭据必须在校验层就被拒，而不是发出去让服务端处理。
 *
 * 它的报错信息里不能回显密码，这一点也一并钉住。
 */
test('listRemoteModels 拒绝把凭据写进地址，且报错不回显密码', async () => {
  let called = false;
  const error = await catalog
    .listRemoteModels({
      endpoint: 'https://user:hunter2@api.example.com/v1',
      apiKey: null,
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }
    })
    .then(
      () => null,
      (thrown) => thrown
    );
  assert.equal(called, false);
  assert.equal(error?.code, 'remote_model_endpoint_invalid');
  assert.equal(error?.message?.includes('hunter2'), false);
});
