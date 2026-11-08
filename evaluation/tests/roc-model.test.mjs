import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, fileInventory, hash } from '../lib/common.mjs';
import { openRocModel } from '../lib/roc-model.mjs';

const root = directory(join(EVAL_ROOT, '.runtime/tests'), 'model');
const { readModelSelection, createConfiguredModel, completeConfigured } = await importTypeScriptModule(join(EVAL_ROOT, 'runtime/configured-model.ts'), {
  platform: 'node', external: ['@langchain/*', 'zod'], tempDir: join(root, 'imports')
});
function settings(path, endpoint, type = 'openai_compatible', credentialRef = 'secret:custom') {
  const id = type === 'llama_cpp' ? 'llama_cpp' : 'custom';
  mkdirSync(join(path, 'config'), { recursive: true }); mkdirSync(join(path, 'secrets'), { recursive: true });
  writeFileSync(join(path, 'config/settings.json'), JSON.stringify({ providers: { schemaVersion: 2, defaultModelId: `${id}:test-model`, providers: [{
    id, name: 'Test', type, enabled: true, endpoint, credentialRef,
    options: { defaultHeaders: { 'x-test-header': 'header-sentinel' } },
    models: [{ id: 'test-model', displayName: 'Test model', supportsStreaming: true, supportsToolCalls: true, supportsImages: false, enabled: true, options: { temperature: 0.3, maxTokens: 128 } }]
  }] } }));
  writeFileSync(join(path, 'secrets/custom.bin'), 'encrypted-fixture');
}
test('Roc configured model uses production parameters and leaves config/rotated secrets untouched', async () => {
  const path = join(root, 'readonly'), requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ body: JSON.parse(text), headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'configured-test', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '42' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    settings(path, `http://127.0.0.1:${server.address().port}/v1`);
    const before = fileInventory(path); let writes = 0;
    const model = await createConfiguredModel(path, { isEncryptionAvailable: async () => true,
      encryptString: async () => { writes++; throw new Error('must not rotate'); },
      decryptString: async () => ({ plaintext: 'credential-sentinel', shouldReEncrypt: true }) });
    const reply = await completeConfigured(model, { model: 'test-model', messages: [{ role: 'user', content: 'What is 6*7?' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } } }] }, new AbortController().signal);
    assert.equal(reply.choices[0].message.content, '42'); assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, 'Bearer credential-sentinel');
    assert.equal(requests[0].headers['x-test-header'], 'header-sentinel');
    assert.equal(requests[0].body.temperature, 0.3); assert.equal(requests[0].body.max_tokens, 128);
    assert.equal(requests[0].body.tools[0].function.name, 'read_file');
    assert.equal(writes, 0); assert.deepEqual(fileInventory(path), before);
    assert.equal(JSON.stringify(model.identity).includes('sentinel'), false);
    const selected = readModelSelection(path); assert.equal(selected.model.id, 'test-model');
    assert.throws(() => readModelSelection(path, { providerId: 'absent', modelId: 'absent' }), /unavailable/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('Electron model host reports missing credentials promptly without mutating the Roc source', async () => {
  const path = join(root, 'missing'); settings(path, 'http://127.0.0.1:9/v1', 'openai_compatible', null);
  const before = hash(fileInventory(path));
  await assert.rejects(openRocModel({ rocRoot: path }), /provider_credential_missing/);
  assert.equal(hash(fileInventory(path)), before);
});
test('Electron model host completes through an existing local provider without loading Roc state', async () => {
  const path = join(root, 'host-success'); let requests = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests++;
    if (JSON.parse(body).stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ id: 'host-test', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: '42' } }] })}\n\ndata: ${JSON.stringify({ id: 'host-test', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'host-test', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '42' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let model;
  try {
    settings(path, `http://127.0.0.1:${server.address().port}/v1`, 'llama_cpp', null);
    const before = hash(fileInventory(path));
    model = await openRocModel({ rocRoot: path });
    assert.equal(requests, 0);
    const reply = await model.complete({ model: 'test-model', messages: [{ role: 'user', content: '6*7' }] }, AbortSignal.timeout(10000));
    assert.equal(reply.choices[0].message.content, '42'); assert.equal(requests, 1);
    assert.equal(hash(fileInventory(path)), before);
  } finally { await model?.close(); await new Promise(resolve => server.close(resolve)); }
});
