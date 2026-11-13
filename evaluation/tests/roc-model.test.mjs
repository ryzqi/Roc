import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import electron from 'electron';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, fileInventory, hash, writeJson } from '../lib/common.mjs';
import { openRocModel } from '../lib/roc-model.mjs';
import { runBenchmark } from '../lib/runner.mjs';
import { inspectRun } from '../lib/report.mjs';
import { importQasper } from '../lib/qasper.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('model');
const { readModelSelection, createConfiguredModel, completeConfigured } = await importTypeScriptModule(join(EVAL_ROOT, 'runtime/configured-model.ts'), {
  platform: 'node', external: ['@langchain/*', 'zod'], tempDir: join(root, 'imports')
});
const { terminateProcessTreeWithRetry } = await importTypeScriptModule('src/main/services/process-tree.ts', { platform: 'node' });
test('Electron model host selects application safe-storage identity before app readiness', async () => {
  const path = join(root, 'identity'), entry = join(path, 'host.mjs');
  mkdirSync(path, { recursive: true });
  await build({ entryPoints: [join(EVAL_ROOT, 'runtime/model-host.ts')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  const child = spawn(electron, [entry, path, 'roc'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  try {
    const first = await Promise.race([
      lines[Symbol.asyncIterator]().next(),
      new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('model_host_identity_timeout')), 5000);
        timeout.unref();
      })
    ]);
    assert.equal(first.done, false);
    assert.deepEqual(JSON.parse(first.value), { type: 'stage', stage: 'startup', applicationName: 'roc' });
  } finally {
    child.stdin.end();
    await terminateProcessTreeWithRetry(child);
    lines.close();
  }
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
  // Synthetic providers use Electron's namespace, without opening the user's Roc keychain.
  await assert.rejects(openRocModel({ rocRoot: path, appName: 'Electron' }), /provider_credential_missing/);
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
    assert.equal(model.identity.applicationName, 'roc');
    const reply = await model.complete({ model: 'test-model', messages: [{ role: 'user', content: '6*7' }] }, AbortSignal.timeout(10000));
    assert.equal(reply.choices[0].message.content, '42'); assert.equal(requests, 1);
    assert.equal(hash(fileInventory(path)), before);
  } finally { await model?.close(); await new Promise(resolve => server.close(resolve)); }
});
test('QASPER runs through the configured Roc factory, real file tools, checkpoint verifier and scorer without config writes', async () => {
  const path = join(root, 'qasper-provider'), dataset = join(root, 'qasper-dataset'), requests = [];
  const paragraph = 'The experiment measured a 25% increase.';
  const tasks = importQasper(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`paper${i}`, {
    title: 'Visible paper', abstract: 'public-paper-sentinel', full_text: [{ section_name: 'Results', paragraphs: [paragraph] }],
    qas: [{ question_id: `q${i}`, question: 'How much did it increase?', answers: [
      { answer: { unanswerable: false, extractive_spans: ['25%'], free_form_answer: '', yes_no: null, evidence: [paragraph] } },
      { answer: { unanswerable: false, extractive_spans: [], free_form_answer: 'hidden-reference-sentinel', yes_no: null, evidence: [paragraph] } }
    ] }]
  }]))).filter(task => task.split === 'development').slice(0, 1);
  assert.equal(tasks.length, 1);
  mkdirSync(dataset); writeJson(join(dataset, 'tasks.json'), tasks);
  const suite = 'qasper', provenance = { kind: 'synthetic-configured-provider-integration' }, inventory = fileInventory(dataset);
  writeJson(join(dataset, 'dataset.json'), { suite, provenance, inventory, identity: hash({ suite, provenance, inventory }) });
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const read = body.messages.some(message => message.role === 'tool');
    const completion = { id: `qasper-configured-${requests.length}`, object: 'chat.completion', created: 0, model: 'test-model',
      choices: [{ index: 0, finish_reason: read ? 'stop' : 'tool_calls', message: read
        ? { role: 'assistant', content: '{"answer":"25%","evidence":["p1"]}' }
        : { role: 'assistant', content: "I'll read the paper file first.", tool_calls: [
          { id: 'configured-read', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/workspace/paper.json","offset":0,"limit":100}' } }
        ] } }],
      // Real providers can omit usage. It must not invalidate an otherwise
      // complete run; the production ledger preserves its unknown accounting.
      ...(!read ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } : {}) };
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const { message, finish_reason } = completion.choices[0];
      const chunk = { id: completion.id, object: 'chat.completion.chunk', created: 0, model: 'test-model' };
      const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}) };
      res.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason }] })}\n\n`
        + (completion.usage ? `data: ${JSON.stringify({ ...chunk, choices: [], usage: completion.usage })}\n\n` : '')
        + 'data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(completion));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    settings(path, `http://127.0.0.1:${server.address().port}/v1`, 'llama_cpp', null);
    const before = fileInventory(path);
    const result = await runBenchmark({ suite, profile: 'smoke', dataset, rocRoot: path, outputRoot: join(root, 'qasper-runs') });
    assert.equal(result.status, 'complete', JSON.stringify(result.fatal));
    assert.deepEqual(result.metrics, { answerF1: 1, evidenceF1: 1, citationValidity: 1 });
    assert.equal(result.usage.requests, 2); assert.equal(requests.length, 2);
    assert.deepEqual(fileInventory(path), before);
    assert.ok(requests.every(body => body.model === 'test-model' && body.max_tokens === 128 && body.temperature === 0.3));
    assert.ok(requests.every(body => hash(body.tools.map(tool => tool.function.name).sort()) === hash(['ls', 'read_file'])));
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('public-paper-sentinel')));
    assert.equal(JSON.stringify(requests).includes('hidden-reference-sentinel'), false);
    const sealed = inspectRun(result.directory), trial = sealed.trials[0];
    assert.equal(sealed.manifest.provider.providerId, 'llama_cpp');
    assert.equal(sealed.manifest.provider.maxOutputTokens, 128);
    assert.equal(trial.runtimeVerification.status, 'verified');
    const trialRoot = join(result.directory, `trial-${hash(trial.taskId).slice(0, 16)}-${trial.repeat}`);
    const verification = JSON.parse(readFileSync(join(trialRoot, 'runtime-verification.json')));
    assert.equal(verification.status, 'verified');
    const frozen = verification.checks.find(check => check.id === 'frozen-inputs').observed;
    assert.deepEqual(frozen.model, { providerId: 'llama_cpp', modelId: 'test-model' });
    assert.equal(frozen.limits.maxOutputTokens, 128);
    assert.equal(JSON.parse(readFileSync(join(trialRoot, 'final-answer.json'))).output, '{"answer":"25%","evidence":["p1"]}');
    assert.equal(JSON.parse(readFileSync(join(trialRoot, 'output.json'))).output, "I'll read the paper file first." + '{"answer":"25%","evidence":["p1"]}');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
