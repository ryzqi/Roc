import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { hash, readJson, sha256, writeJson } from '../lib/common.mjs';
import { loadDataset } from '../lib/data.mjs';
import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';
import { prepareRag, validateRagCorpus } from '../adapters/rag/data.mjs';
import { openRagEnvironment, ragInput, retrievalConfigurationSchema } from '../adapters/rag/environment.mjs';
import { readRagState } from '../adapters/rag/evidence.mjs';
import { verifyRagApplication } from '../adapters/rag/verification.mjs';
import { gradeRag, gradeRetrieval } from '../graders/rag.mjs';
import { ragFixture, ragFixtureCompletion } from './rag-fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('rag');
const corpusPath = join(root, 'corpus-source.json');
writeJson(corpusPath, ragFixture());
const dataset = loadDataset(await prepareRag(corpusPath, { cacheRoot: join(root, 'datasets') }));
const [task] = dataset.tasks;
const config = retrievalConfigurationSchema.parse({});
const signal = new AbortController().signal;
const trial = name => { const path = join(root, name); mkdirSync(path); return path; };

test('source locators and review attestations reject drift and unreviewed holdout', () => {
  const corpus = ragFixture();
  assert.equal(validateRagCorpus(corpus).tasks.length, 1);
  assert.throws(() => validateRagCorpus({ ...corpus, documents: corpus.documents.map(d => ({ ...d, content: d.content + 'changed' })) }), /rag_source_hash_mismatch/);
  const holdout = structuredClone(corpus); holdout.tasks[0].split = 'holdout';
  assert.throws(() => validateRagCorpus(holdout), /rag_unreviewed_holdout_or_claim/);
  const reviewed = structuredClone(corpus);
  reviewed.provenance.kind = 'human_reviewed';
  reviewed.tasks[0].review = { status: 'reviewed', annotations: ['one', 'two'].map(reviewer => ({
    reviewer, reviewedAt: '2026-11-14T01:00:00Z',
    contentHash: hash({ visible: task.visible, expected: task.expected }), judgmentHash: hash('agree')
  })), arbitration: null };
  assert.doesNotThrow(() => validateRagCorpus(reviewed));
  reviewed.tasks[0].visible.question += ' changed';
  assert.throws(() => validateRagCorpus(reviewed), /rag_independent_reviews_required/);
});

test('real production indexing/search/context exposes current source spans and rejects duplicate receipts', async () => {
  const path = trial('component');
  const environment = await openRagEnvironment({ dataset, task, directory: path, config, signal });
  try {
    const search = await environment.invoke('research.knowledge.search', {
      query: 'Orion yield', projectId: environment.projectId, documentId: 'orion',
      embeddingConfigId: null, limit: 20
    }, 'search-one', signal);
    assert.ok(search.hits.length > 0);
    const hit = search.hits[0], candidate = search.ranking.candidates.find(c => c.chunkId === hit.chunkId);
    const context = await environment.invoke('research.knowledge.context', {
      chunkId: hit.chunkId, expectedIndexedVersion: candidate.indexedVersion,
      projectId: environment.projectId, maxChars: 6000, neighbors: false
    }, 'context-one', signal);
    assert.match(context.context.content, /42 units/);
    const grade = gradeRetrieval(task, { state: environment.initial,
      observations: [{ name: 'research.knowledge.search', request: { projectId: environment.projectId },
        result: search, elapsedMs: 1 }] });
    assert.equal(grade.metrics.recall20, 1);
    assert.equal(grade.metrics.evidenceChainRecall20, 1);
    assert.deepEqual(grade.retrievalLatenciesMs, [1]);
    await assert.rejects(environment.invoke('research.knowledge.search', {
      query: 'Orion yield', projectId: environment.projectId, embeddingConfigId: null, limit: 20
    }, 'search-one', signal), /rag_duplicate_tool_receipt/);
    await assert.rejects(environment.invoke('research.knowledge.search', {
      query: 'Orion yield', projectId: 'another-project', embeddingConfigId: null, limit: 20
    }, 'search-two', signal), /rag_capability_denied/);
  } finally { await environment.close(); }
  const db = new Database(environment.databasePath);
  try { db.prepare("UPDATE research_knowledge_documents SET content=content||'tampered'").run(); }
  finally { db.close(); }
  assert.throws(() => readRagState(environment.databasePath, environment.sources), /rag_index_source_mismatch/);
});

test('real Roc RAG tools bind the proposal, model context, checkpoint and persisted source before grading', async () => {
  const artifactRoot = trial('artifact'), artifact = await prepareApplication(artifactRoot);
  const path = trial('application');
  const research = await openRagEnvironment({ dataset, task, directory: path, config, signal });
  const result = await executeApplication({ artifact, input: ragInput(task), directory: path,
    config: fixtureConfig, complete: ragFixtureCompletion, record: () => {}, signal, research,
    protectedPaths: [join(dataset.root, 'tasks.json'), research.databasePath] });
  const grade = gradeRag(task, result.output, result.ragEvidence);
  assert.equal(result.runtimeVerification.status, 'verified');
  assert.equal(result.ragVerification.status, 'verified');
  assert.equal(grade.success, true);
  assert.equal(grade.metrics.contextCoverage, 1);
  assert.equal(grade.metrics.evidenceReadCoverage, 1);
  assert.equal(grade.metrics.wrongSourceRate, 0);
  assert.equal(grade.metrics.staleHitRate, 0);
  const recordedSearches = result.ragEvidence.observations.filter(value => value.name === 'research.knowledge.search');
  assert.ok(recordedSearches.length > 0);
  assert.deepEqual(grade.retrievalLatenciesMs, recordedSearches.map(value => value.elapsedMs));
  assert.ok(grade.retrievalLatenciesMs.every(value => Number.isFinite(value) && value >= 0));
  assert.equal(gradeRag(task, JSON.stringify({ abstain: false,
    evidence: grade.answer.evidence, answer: grade.answer.answer }), result.ragEvidence).success, true);
  assert.throws(() => gradeRag({ ...task, expected: undefined }, result.output, result.ragEvidence), /rag_hidden_truth_unreadable/);
  const lost = { ...result.ragEvidence, visibleSpans: [] };
  assert.equal(gradeRag(task, result.output, lost).reason, 'citation_not_read');
  assert.ok(gradeRag(task, result.output, lost).diagnostics.labels.includes('context_loss'));
  const miss = { ...result.ragEvidence, observations: result.ragEvidence.observations.map(o => o.name === 'research.knowledge.search'
    ? { ...o, result: { ...o.result, ranking: { ...o.result.ranking, candidates: [] } } } : o) };
  assert.ok(gradeRag(task, result.output, miss).diagnostics.labels.includes('retrieval_miss'));
  const stale = { ...result.ragEvidence, observations: result.ragEvidence.observations.map(o =>
    o.name === 'research.knowledge.search' ? { ...o, result: { ...o.result, ranking: { ...o.result.ranking,
      candidates: o.result.ranking.candidates.map(candidate => ({ ...candidate, indexedVersion: 'obsolete-version' }))
    } } } : o) };
  assert.equal(gradeRag(task, result.output, stale).metrics.staleHitRate, 1);
  const receipts = readJson(join(path, 'rag-receipts.json'));
  assert.equal(receipts.length, 2);
  const db = new Database(join(path, 'worker/agent.sqlite'));
  try {
    const checkpoint = db.prepare("SELECT checkpoint_id,checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1").get();
    const blob = JSON.parse(checkpoint.checkpoint_blob.toString());
    const tool = blob.channel_values.messages.find(m => m.kwargs?.tool_call_id);
    assert.ok(tool);
    tool.kwargs.content = '{"tampered":true}';
    db.prepare("UPDATE langgraph_checkpoints SET checkpoint_blob=? WHERE checkpoint_id=? AND checkpoint_ns=''").run(Buffer.from(JSON.stringify(blob)), checkpoint.checkpoint_id);
  } finally { db.close(); }
  assert.equal(verifyRagApplication({ directory: path, research }).report.status, 'invalid');
});

test('real multi-paper context calls preserve proposal IDs and reject swapped receipt identities', async () => {
  const corpus = ragFixture(), first = corpus.documents[0];
  const quote = 'The measured Orion control yield was 84 units.';
  const second = {...first, id: 'orion-control', sourceId: 'paper-orion-control', title: 'Orion control',
    sourceUri: 'fixture:paper-orion-control', content: quote, contentSha256: sha256(quote),
    blocks: [{coordinateSystem: 'utf16', startOffset: 0, endOffset: quote.length, section: 'Results'}]};
  corpus.documents.push(second);
  const sourceTask = corpus.tasks[0];
  sourceTask.category = 'cross-paper';
  sourceTask.visible = {question: 'For Orion and Orion control, return both sentences about measured yield.',
    documentIds: [first.id, second.id]};
  sourceTask.expected.answers = [`The measured Orion yield was 42 units. ${quote}`];
  const evidence = {id: 'orion-control-yield', sourceId: second.sourceId, sourceVersion: second.sourceVersion,
    sourceSha256: second.contentSha256, parserVersion: second.parserVersion,
    locator: {coordinateSystem: 'utf16', startOffset: 0, endOffset: quote.length, section: 'Results'},
    evidenceTextSha256: sha256(quote), relevance: 3};
  sourceTask.expected.evidence.push(evidence);
  sourceTask.expected.evidenceChains = [[sourceTask.expected.evidence[0].id, evidence.id]];
  const corpusPath = join(root, 'multi-paper-corpus.json');
  writeJson(corpusPath, corpus);
  const multiDataset = loadDataset(await prepareRag(corpusPath, {cacheRoot: join(root, 'multi-datasets')}));
  const [multiTask] = multiDataset.tasks;
  const artifact = await prepareApplication(trial('multi-artifact'));
  const path = trial('multi-application');
  const research = await openRagEnvironment({dataset: multiDataset, task: multiTask, directory: path, config, signal});
  const complete = body => {
    const response = ragFixtureCompletion(body);
    if (!body.messages.some(message => message.role === 'tool')) {
      response.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({query: 'Orion yield', limit: 20});
    }
    const contexts = body.messages.filter(message => message.role === 'tool')
      .map(message => JSON.parse(message.content)).filter(value => value.context);
    if (contexts.length > 0) {
      response.choices[0].message.content = JSON.stringify({
        answer: contexts.flatMap(value => value.context.content.match(/The measured Orion(?: control)? yield was [^.]+\./gu) ?? []).join(' '),
        evidence: contexts.map(value => value.context.chunkId), abstain: false
      });
    }
    return response;
  };
  const result = await executeApplication({artifact, input: ragInput(multiTask), directory: path,
    config: fixtureConfig, complete, record: () => {}, signal, research,
    protectedPaths: [join(multiDataset.root, 'tasks.json'), research.databasePath]});
  assert.equal(result.runtimeVerification.status, 'verified');
  assert.equal(result.ragVerification.status, 'verified');
  const grade = gradeRag(multiTask, result.output, result.ragEvidence);
  assert.equal(grade.success, true, JSON.stringify({reason: grade.reason, metrics: grade.metrics, answer: grade.answer}));
  assert.equal(grade.metrics.contextCoverage, 1);
  assert.equal(grade.metrics.evidenceReadCoverage, 1);
  const calls = readFileSync(join(path, 'responses.jsonl'), 'utf8').trim().split('\n')
    .flatMap(line => JSON.parse(line).body.choices[0].message.tool_calls ?? [])
    .filter(call => call.function.name === 'research_read_knowledge_context');
  assert.equal(calls.length, 2);
  const receipts = readJson(join(path, 'rag-receipts.json'));
  const contexts = receipts.filter(receipt => receipt.name === 'research.knowledge.context');
  assert.equal(contexts.length, 2);
  for (const call of calls) {
    const args = JSON.parse(call.function.arguments);
    const receipt = contexts.find(value => value.toolCallId === call.id);
    assert.ok(receipt);
    assert.equal(receipt.request.chunkId, args.chunkId);
    assert.equal(receipt.request.expectedIndexedVersion, args.expectedIndexedVersion);
  }
  [contexts[0].toolCallId, contexts[1].toolCallId] = [contexts[1].toolCallId, contexts[0].toolCallId];
  writeFileSync(join(path, 'rag-receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`);
  const tampered = verifyRagApplication({directory: path, research}).report;
  assert.equal(tampered.status, 'invalid');
  assert.equal(tampered.reason, 'rag_receipt_request_invalid');
});
