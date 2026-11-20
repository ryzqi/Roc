import { parentPort, workerData } from 'node:worker_threads';
import { deserialize, serialize } from 'node:v8';
import { createHash } from 'node:crypto';

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (workerData.path === 'slow-init') wait(400);
parentPort.postMessage({ protocol: 1, type: 'ready', database: workerData });
parentPort.on('message', wire => {
  const { input, generatedAt } = deserialize(wire.bytes);
  parentPort.postMessage({ protocol: 1, type: 'started', requestId: wire.requestId });
  if (input.request.query === 'crash') process.exit(42);
  if (input.request.query === 'blocked') wait(10_000);
  if (input.request.query === 'delay') wait(150);
  if (input.request.query === 'query-error') {
    parentPort.postMessage({ protocol: 1, type: 'error', requestId: wire.requestId, code: 'research_knowledge_source_corrupt' });
    return;
  }
  const snapshot = { schemaVersion: 3, candidateLimit: 50,
    route: { intent: 'general', documentId: null, diversify: true },
    reranker: { status: 'not_requested', model: null, configHash: null, elapsedMs: 0 },
    degradation: null, projectId: input.request.projectId, limit: input.request.limit, embedding: null, candidates: [] };
  const result = { query: input.request.query, hits: [], keywordCount: 0, vectorCount: 0, embeddingModel: null,
    generatedAt, ranking: { ranker: 'rrf-v1-k60', ...snapshot,
      inputHash: createHash('sha256').update(JSON.stringify({ query: input.request.query, ...snapshot })).digest('hex'),
      coverage: { keyword: 'no_results', vector: 'not_searched' } } };
  if (input.request.query === 'wrong-query') result.query = 'forged';
  const bytes = input.request.query === 'large-reply' ? new Uint8Array(9 * 1024 * 1024) : new Uint8Array(serialize(result));
  parentPort.postMessage({ protocol: 1, type: 'result', requestId: wire.requestId, bytes,
    snapshot: { dataVersion: 1, schema: workerData.schema }, queryMs: 1 }, [bytes.buffer]);
});
