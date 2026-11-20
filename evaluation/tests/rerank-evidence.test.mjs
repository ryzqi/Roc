import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {hash, readJson, ROOT, sha256} from '../lib/common.mjs';
import {readRagState, verifyRagSearch} from '../adapters/rag/evidence.mjs';
import {testArtifacts} from './test-artifacts.mjs';

const root = testArtifacts('rerank-evidence');
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('rerank_evidence_network_forbidden');
};
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0);
});
const packages = readJson(join(ROOT, 'package.json'));
const {openProductionRag} = await importTypeScriptModule(join(ROOT, 'evaluation/runtime/production-rag.ts'), {
  platform: 'node', external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
  tempDir: join(root, 'imports')
});
const provider = {model: 'fixture-production-reranker', configurationHash: 'b'.repeat(64), timeoutMs: 300};
const documents = ['first', 'second'].map((id, index) => {
  const content = `Orion experiment ${id}\nThe measured Orion yield was ${42 + index} units.`;
  return {id, projectId: 'project-evidence', sourceId: `paper-${id}`, sourceVersion: 'v1',
    parserVersion: 'fixture-text-v1', sourceUri: `fixture:${id}`, license: 'CC0-1.0', current: true,
    sourceType: 'literature', title: `Orion experiment ${id}`, content, contentSha256: sha256(content),
    blocks: [{startOffset: 0, endOffset: content.length, section: 'Results'}]};
});
const request = query => ({query, projectId: 'project-evidence', embeddingConfigId: null, limit: 20});
const signal = new AbortController().signal;
const receipt = (status = 'succeeded', elapsedMs = 173.25) => ({
  status, model: provider.model, configHash: provider.configurationHash, elapsedMs
});
const payloadHash = call => hash({kind: 'rerank', input: {query: call.query, documents: call.documents}});
const reply = (call, status = 'succeeded', elapsedMs = 173.25) => ({
  scores: status === 'succeeded' ? call.documents.map((_, index) => index === 0 ? 0.1 : 0.9) : null,
  receipt: receipt(status, elapsedMs),
  correlation: {trialId: 'trial-evidence', requestId: `rerank-${call.ordinal}`, requestHash: payloadHash(call)}
});
let nextRuntime = 0;
async function open(t, rank, {rerank = 'semantic', identity = provider} = {}) {
  const calls = [], path = join(root, `trial-${++nextRuntime}.sqlite`);
  const runtime = await openProductionRag({
    path, documents, projectId: 'project-evidence', signal,
    config: {mode: 'bm25', rerank, candidateLimit: 50, topK: 20, contextMaxChars: 6000},
    transport: {
      identity: {embedding: null, reranker: identity},
      embed: async () => {throw new Error('unexpected_embedding_call');},
      rerank: async (query, texts, active) => {
        const call = {query, documents: [...texts], signal: active, ordinal: calls.length + 1};
        calls.push(call);
        return await rank(call);
      }
    }
  });
  t.after(() => runtime.close());
  return {runtime, calls, path};
}

test('actual successful provider receipt survives production ranking and independent trial evidence checks', async t => {
  const {runtime, calls, path} = await open(t, call => reply(call));
  const initial = readRagState(path, documents), input = request('Orion yield');
  const result = await runtime.search(input, signal);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].documents.length >= 2);
  assert.deepEqual(result.ranking.reranker, receipt());
  assert.ok(result.ranking.candidates.some(candidate => candidate.rerankScore === 0.9));
  const persisted = JSON.parse(JSON.stringify({result, transportReceipts: runtime.transportReceipts}));
  assert.equal(verifyRagSearch(persisted.result, initial, input, input.projectId), true);
  assert.deepEqual(readRagState(path, documents), initial);
  assert.deepEqual(persisted.transportReceipts, [{
    schemaVersion: 1, kind: 'rerank', sequence: 1, providerId: 'roc-reranker',
    requestHash: payloadHash(calls[0]), correlation: reply(calls[0]).correlation,
    configurationHash: provider.configurationHash, timeoutMs: provider.timeoutMs,
    documentCount: calls[0].documents.length, receipt: receipt(), usage: null
  }]);
  assert.deepEqual(persisted.result.ranking.reranker, persisted.transportReceipts[0].receipt);
  assert.equal(persisted.transportReceipts[0].requestHash, persisted.transportReceipts[0].correlation.requestHash);
  assert.equal(JSON.stringify(persisted.transportReceipts).includes('evaluation.invalid'), false);
  assert.equal(Object.hasOwn(persisted.transportReceipts[0], 'documents'), false);
  assert.equal(Object.hasOwn(persisted.transportReceipts[0], 'scores'), false);
  persisted.result.ranking.reranker.elapsedMs++;
  assert.throws(() => verifyRagSearch(persisted.result, initial, input, input.projectId), /rag_ranking_invalid/);
});

for (const status of ['timeout', 'failed', 'config_missing', 'disabled']) {
  test(`actual ${status} receipt is retained without outer reclassification or a fabricated success`, async t => {
    const {runtime, calls} = await open(t, call => reply(call, status, 421.75));
    const result = await runtime.search(request('Orion yield'), signal);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.ranking.reranker, receipt(status, 421.75));
    assert.ok(result.ranking.candidates.every(candidate => candidate.rerankScore === null));
    assert.deepEqual(runtime.transportReceipts[0].receipt, result.ranking.reranker);
    assert.equal(runtime.transportReceipts[0].timeoutMs, 300);
    assert.equal(runtime.transportReceipts[0].usage, null);
  });
}

test('uncorrelated transports retain an explicit null binding and a budget-compatible request hash', async t => {
  const {runtime, calls} = await open(t, call => {
    const {correlation: _binding, ...value} = reply(call);
    return value;
  });
  await runtime.search(request('Orion yield'), signal);
  assert.equal(runtime.transportReceipts[0].correlation, null);
  assert.equal(runtime.transportReceipts[0].requestHash, payloadHash(calls[0]));
});

test('receipt evidence is detached from mutable transport replies, ranking results and returned snapshots', async t => {
  let value;
  const {runtime} = await open(t, call => value = reply(call));
  const result = await runtime.search(request('Orion yield'), signal);
  value.receipt.configHash = 'a'.repeat(64);
  value.correlation.requestId = 'mutated';
  const snapshot = runtime.transportReceipts;
  snapshot[0].receipt.elapsedMs = 0;
  snapshot[0].correlation.trialId = 'mutated';
  snapshot.pop();
  assert.deepEqual(result.ranking.reranker, receipt());
  result.ranking.reranker.model = 'mutated';
  assert.deepEqual(runtime.transportReceipts[0].receipt, receipt());
  assert.equal(runtime.transportReceipts[0].correlation.requestId, 'rerank-1');
  assert.equal(runtime.transportReceipts[0].correlation.trialId, 'trial-evidence');
});

test('malformed or mismatched receipts and correlation are hard redacted errors and are never replayed', async t => {
  const changes = [
    value => {value.receipt.configHash = 'a'.repeat(64);},
    value => {value.receipt.model = 'https://private.invalid/credential';},
    value => {value.receipt.elapsedMs = Number.NaN;},
    value => {value.receipt.elapsedMs = -1;},
    value => {value.receipt.status = 'failed';},
    value => {value.scores = null;},
    value => {value.scores = [];},
    value => {value.scores[0] = 2;},
    value => {value.correlation.requestHash = 'c'.repeat(64);},
    value => {value.correlation.requestId = '';},
    value => {delete value.receipt.configHash;}
  ];
  for (const change of changes) {
    const {runtime, calls} = await open(t, call => {
      const value = reply(call);
      change(value);
      return value;
    });
    await assert.rejects(runtime.search(request('Orion yield'), signal),
      error => error.message === 'rag_reranker_transport_receipt_invalid');
    assert.equal(calls.length, 1);
    assert.deepEqual(runtime.transportReceipts, []);
  }
});

test('hard transport and budget failures propagate once and do not invent provider receipts', async t => {
  for (const error of [
    Object.assign(new Error('roc_retrieval_host_unavailable'), {code: 'roc_retrieval_host_unavailable'}),
    Object.assign(new Error('budget_max_model_requests'), {failureClass: 'policy'})
  ]) {
    const {runtime, calls} = await open(t, () => {throw error;});
    await assert.rejects(runtime.search(request('Orion yield'), signal), value => value === error);
    assert.equal(calls.length, 1);
    assert.deepEqual(runtime.transportReceipts, []);
  }
});

test('simultaneous identical searches retain separate request IDs despite reverse completion order', {timeout: 10000}, async t => {
  const waiting = [];
  t.after(() => waiting.forEach(release => release()));
  let firstStarted, secondStarted;
  const firstReady = new Promise(resolve => {firstStarted = resolve;});
  const secondReady = new Promise(resolve => {secondStarted = resolve;});
  const {runtime, calls} = await open(t, call => new Promise(resolve => {
    waiting.push(() => resolve(reply(call, 'succeeded', call.ordinal * 41)));
    if (call.ordinal === 1) firstStarted(); else secondStarted();
  }));
  const first = runtime.search(request('Orion yield'), signal);
  await firstReady;
  const second = runtime.search(request('Orion yield'), signal);
  await secondReady;
  waiting[1]();
  const secondResult = await second;
  assert.equal(secondResult.ranking.reranker.elapsedMs, 82);
  waiting[0]();
  const firstResult = await first;
  assert.equal(firstResult.ranking.reranker.elapsedMs, 41);
  assert.equal(calls.length, 2);
  assert.deepEqual(runtime.transportReceipts.map(value => value.sequence), [1, 2]);
  assert.deepEqual(runtime.transportReceipts.map(value => value.correlation.requestId), ['rerank-1', 'rerank-2']);
  assert.equal(runtime.transportReceipts[0].requestHash, runtime.transportReceipts[1].requestHash);
});

test('a late reply after cancellation remains observed evidence and is not turned into a successful search', async t => {
  const controller = new AbortController();
  const {runtime, calls} = await open(t, call => {
    controller.abort();
    return reply(call);
  });
  await assert.rejects(runtime.search(request('Orion yield'), controller.signal));
  assert.equal(calls.length, 1);
  assert.deepEqual(runtime.transportReceipts[0].receipt, receipt());
  assert.equal(runtime.transportReceipts[0].usage, null);
});

test('no-rerank arm produces no transport evidence or claims about configured provider execution', async t => {
  const {runtime, calls} = await open(t, () => {throw new Error('unexpected_rerank_call');}, {rerank: 'none'});
  const result = await runtime.search(request('Orion yield'), signal);
  assert.deepEqual(result.ranking.reranker, {status: 'not_requested', model: null, configHash: null, elapsedMs: 0});
  assert.equal(calls.length, 0);
  assert.deepEqual(runtime.transportReceipts, []);
});

test('empty candidates retain the actual transport receipt without manufacturing a provider receipt', async t => {
  const {runtime, calls} = await open(t, call => reply(call));
  const result = await runtime.search(request('zzzzunmatched'), signal);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].documents, []);
  assert.deepEqual(result.ranking.reranker, receipt());
  assert.equal(runtime.transportReceipts[0].documentCount, 0);
  assert.equal(runtime.transportReceipts[0].requestHash, payloadHash(calls[0]));
});
