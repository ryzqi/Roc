import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { directory, hash, journal, readJson, sha256, sourceIdentity, writeJson } from '../lib/common.mjs';
import { loadDataset } from '../lib/data.mjs';
import { executionPolicy, openExecution, storeGrade, verifiedSeal, withinTrial } from '../lib/execution.mjs';
import { readEvents } from '../lib/lifecycle.mjs';
import { inspectRun, sealRun, summarize } from '../lib/report.mjs';
import { prepareRag } from '../adapters/rag/data.mjs';
import { ragComponentCapability, retrievalConfigurationSchema } from '../adapters/rag/environment.mjs';
import { budgetRetrievalTransport, executeRagComponent, researchReference } from '../adapters/rag/run.mjs';
import { verifyRagComponent } from '../adapters/rag/verification.mjs';
import { gradeRetrieval } from '../graders/rag.mjs';
import { ragFixture } from './rag-fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('rag-transport-binding');

test('production reranking binds original receipts, host budget, source inputs and scores before sealing', async t => {
  const corpus = ragFixture(), content = 'Orion control\nThe Orion yield control used a blue label.';
  corpus.documents.push({ ...structuredClone(corpus.documents[0]), id: 'orion-control',
    sourceId: 'paper-orion-control', title: 'Orion control', content, contentSha256: sha256(content),
    blocks: [{ coordinateSystem: 'utf16', startOffset: 0, endOffset: content.length, section: 'Results' }] });
  const dataset = loadDataset(await prepareRag(corpus, { suite: 'rag-retrieval', cacheRoot: join(root, 'datasets') }));
  const [task] = dataset.tasks, path = directory(root, 'run'), capability = await ragComponentCapability();
  const config = retrievalConfigurationSchema.parse({ mode: 'bm25', rerank: 'semantic' });
  let calls = 0;
  const transport = {
    identity: { embedding: null, reranker: { model: 'owned-receipt-fixture',
      configurationHash: hash('owned-reranker-configuration'), timeoutMs: 300 } },
    embed: () => { throw new Error('unexpected_embedding'); },
    rerank: async (_query, documents) => {
      calls++;
      return { scores: documents.map((_, index) => (index + 1) / (documents.length + 1)), receipt: {
        status: 'succeeded', model: 'owned-receipt-fixture', configHash: hash('owned-reranker-configuration'), elapsedMs: 7
      } };
    }
  };
  const manifest = { schemaVersion: 1, suite: 'rag-retrieval', profile: 'smoke', evidence: 'fixture',
    source: sourceIdentity(), selection: [{ id: task.id, clusterId: task.clusterId }], repeats: 1, split: 'development',
    exclusions: [], metrics: ['recall20', 'ndcg10', 'evidenceChainRecall20', 'wrongSourceRate', 'staleHitRate'],
    datasetIdentity: dataset.manifest.identity, provider: null,
    retrievalProvider: transport.identity, executionPolicy: executionPolicy({ budget: {}, taskTimeoutMs: 30000 }, 1) };
  writeJson(join(path, 'manifest.json'), manifest);
  const events = journal(join(path, 'events.jsonl')), started = Date.now();
  events.append({ type: 'run_started', suite: manifest.suite, startedAtMs: started });
  const execution = openExecution(path, manifest, events), [trial] = execution.plan.trials;
  const trialDirectory = join(path, trial.trialId);
  mkdirSync(trialDirectory);
  let result;
  await withinTrial(execution, trial, new AbortController().signal, async signal => {
    result = await executeRagComponent({ dataset, task, directory: trialDirectory, config, capability, signal,
      transport: budgetRetrievalTransport(transport, execution, trial),
      record: event => execution.lifecycle.record(trial, event),
      lifecycle: to => execution.lifecycle.transition(trial, to) });
    verifiedSeal(trialDirectory, execution.lifecycle, trial);
  });
  const grade = storeGrade(path, execution, trial, {
    ...gradeRetrieval(task, result.ragEvidence), requests: result.requests, toolSchemaHash: result.toolSchemaHash,
    ragVerification: result.ragVerification
  }, started);
  writeJson(join(path, 'trials.json'), [grade]);
  const summary = summarize(manifest, [grade], null, execution.budget.snapshot());
  events.append({ type: 'run_finished', status: summary.status }); events.close(); sealRun(path, summary);
  assert.equal(calls, 1);
  assert.equal(result.requests, 0);
  assert.equal(result.ragVerification.status, 'verified');
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.usage.unknownUsageRequests, 1);
  assert.equal(summary.usage.inputTokens, null);
  assert.equal(summary.usage.costUsd, null);
  assert.equal(inspectRun(path).summary.status, 'complete');
  const report = readJson(join(trialDirectory, 'rag-verification.json'));
  assert.equal(report.rerankerEvidence.requests, 1);
  assert.equal(report.rerankerEvidence.sha256, sha256(readFileSync(join(trialDirectory, report.rerankerEvidence.artifact))));
  assert.ok(grade.traces.artifacts.some(pointer => pointer.artifact.endsWith('reranker-transport-receipts.json')));
  const savedEvents = readEvents(join(path, 'events.jsonl'));
  const completion = savedEvents.find(event => event.type === 'retrieval_model_completed');
  assert.equal(completion.receipt.elapsedMs, 7);
  assert.equal(Object.hasOwn(completion, 'scores'), false);
  assert.equal(Object.hasOwn(completion.inputEvidence, 'documents'), false);
  assert.ok(grade.traces.artifacts.some(pointer => pointer.artifact.endsWith(completion.artifact)));
  const research = researchReference(dataset, task, trialDirectory, transport.identity), request = result.request;
  const verify = () => verifyRagComponent({ directory: trialDirectory, research, request }).report;
  assert.equal(verify().status, 'verified');

  await t.test('a substituted provider configuration is rejected independently', () => {
    const indexPath = join(trialDirectory, 'rag-index.json'), bytes = readFileSync(indexPath);
    const value = JSON.parse(bytes);
    value.retrievalProvider.reranker.configurationHash = hash('substituted-provider');
    try {
      writeFileSync(indexPath, JSON.stringify(value));
      assert.match(verify().reason, /rag_retrieval_provider_binding_invalid/);
    } finally { writeFileSync(indexPath, bytes); }
  });
  await t.test('a changed transport response is rejected before scoring', () => {
    const responsePath = join(trialDirectory, completion.artifact), bytes = readFileSync(responsePath);
    const response = JSON.parse(bytes); response.scores[0] = .999;
    try {
      writeFileSync(responsePath, JSON.stringify(response));
      assert.match(verify().reason, /rag_artifact_changed/);
    } finally { writeFileSync(responsePath, bytes); }
  });
  await t.test('rehashing a changed response still cannot match the production ranking', () => {
    const response = readJson(join(trialDirectory, completion.artifact));
    response.scores[0] = .999;
    const responseHash = hash(response), artifact = `rag-artifacts/${responseHash}.json`;
    writeJson(join(trialDirectory, artifact), response);
    const changed = structuredClone(savedEvents), event = changed.find(value => value.sequence === completion.sequence);
    Object.assign(event, { artifact, artifactHash: responseHash, responseHash });
    const journalPath = join(path, 'events.jsonl'), bytes = readFileSync(journalPath);
    try {
      writeFileSync(journalPath, changed.map(value => JSON.stringify(value)).join('\n') + '\n');
      assert.match(verify().reason, /rag_reranker_score_binding_invalid/);
    } finally { writeFileSync(journalPath, bytes); }
  });
  await t.test('a changed original provider receipt cannot be accepted as the final ranking receipt', () => {
    const receiptPath = join(trialDirectory, 'reranker-transport-receipts.json'), bytes = readFileSync(receiptPath);
    const receipts = JSON.parse(bytes); receipts[0].receipt.status = 'failed';
    try {
      writeFileSync(receiptPath, JSON.stringify(receipts));
      assert.match(verify().reason, /rag_reranker_receipt_binding_invalid/);
    } finally { writeFileSync(receiptPath, bytes); }
  });
  await t.test('rehashing reversed candidate and hit ordering cannot bypass provider score ordering', () => {
    const receiptPath = join(trialDirectory, 'rag-receipts.json'), bytes = readFileSync(receiptPath);
    const receipts = JSON.parse(bytes), value = readJson(join(trialDirectory, receipts[0].artifact));
    assert.ok(value.ranking.candidates.length >= 2);
    value.ranking.candidates.reverse(); value.hits.reverse();
    for (const candidate of value.ranking.candidates) {
      const position = value.hits.findIndex(hit => hit.chunkId === candidate.chunkId);
      candidate.outputRank = position < 0 ? null : position + 1;
    }
    const { inputHash: _previous, ranker: _ranker, coverage: _coverage, ...snapshot } = value.ranking;
    value.ranking.inputHash = sha256(JSON.stringify({ query: value.query, ...snapshot }));
    const artifactHash = hash(value), artifact = `rag-artifacts/${artifactHash}.json`;
    writeJson(join(trialDirectory, artifact), value);
    Object.assign(receipts[0], { artifact, artifactHash });
    try {
      writeFileSync(receiptPath, JSON.stringify(receipts));
      assert.equal(verify().status, 'invalid');
      assert.match(verify().reason, /rag_reranker_order_invalid/);
    } finally { writeFileSync(receiptPath, bytes); }
  });
  await t.test('rehashing changed output ranks cannot substitute a different hit selection', () => {
    const receiptPath = join(trialDirectory, 'rag-receipts.json'), bytes = readFileSync(receiptPath);
    const receipts = JSON.parse(bytes), value = readJson(join(trialDirectory, receipts[0].artifact));
    value.hits.reverse();
    for (const candidate of value.ranking.candidates) {
      const position = value.hits.findIndex(hit => hit.chunkId === candidate.chunkId);
      candidate.outputRank = position < 0 ? null : position + 1;
    }
    const { inputHash: _previous, ranker: _ranker, coverage: _coverage, ...snapshot } = value.ranking;
    value.ranking.inputHash = sha256(JSON.stringify({ query: value.query, ...snapshot }));
    const artifactHash = hash(value), artifact = `rag-artifacts/${artifactHash}.json`;
    writeJson(join(trialDirectory, artifact), value);
    Object.assign(receipts[0], { artifact, artifactHash });
    try {
      writeFileSync(receiptPath, JSON.stringify(receipts));
      assert.equal(verify().status, 'invalid');
      assert.match(verify().reason, /rag_hit_selection_invalid/);
    } finally { writeFileSync(receiptPath, bytes); }
  });
});
