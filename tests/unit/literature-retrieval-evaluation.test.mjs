import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';

let directory, api, bundleHash;
const timestamp = '2026-11-03T00:00:00.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-retrieval-eval-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'fixture.mjs');
  await esbuild.build({stdin: {contents: `
    export {evaluateLiteratureRetrieval, prepareLiteratureJudgmentPacket} from './src/main/plugins/research/literature-retrieval-evaluation';
    export {literatureSearchPoolBodySchema} from './src/shared/schemas/literature-search-pool';
  `, resolveDir: process.cwd()}, outfile, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', logLevel: 'silent'});
  bundleHash = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));
function record(id, source = 'crossref', doi = `10.1234/${id}`) {
  return {id: `${source}:${id}`, source, externalId: id, doi, title: `Synthetic ${id}`, authors: [],
    abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
    importedAt: timestamp, updatedAt: timestamp};
}
function ranked(record, rank) {
  return {record, rank, identifiers: [], rawIdentifiers: null,
    review: {publicationType: null, copies: [], updates: [], retraction: {status: 'unknown', field: null}}};
}
function pool(records, id = 'execution-1', status = 'complete') {
  const names = [...new Set(records.map(item => item.record.source))];
  const selected = names.length === 0 ? ['crossref'] : names;
  const body = api.literatureSearchPoolBodySchema.parse({schemaVersion: 1, executionId: id, createdAt: timestamp,
    request: {query: 'synthetic query', sources: selected, limit: 30, maxPages: 1, projectId: null},
    strategy: null, status, records, sources: selected.map(source => ({
      source, status: status === 'failed' ? 'error' : 'ok',
      returnedCount: records.filter(item => item.record.source === source).length,
      errorCode: status === 'failed' ? 'literature_provider_timeout' : null, retryAfterMs: null, requests: [],
      governance: {host: 'fixture.test', state: 'unknown', consecutiveFailures: 0, remainingRequests: 10,
        quotaResetAt: timestamp, minIntervalMs: 1000, cooldownUntil: null, lastSuccessAt: null, lastFailureAt: null},
      coverage: {state: status === 'failed' ? 'failed' : 'unknown', apiHitCount: null,
        validatedPages: status === 'failed' ? 0 : 1, nextPage: null},
      stopReason: status === 'failed' ? 'failed' : 'continuation_unavailable', pages: []
    }))});
  return {...body, contentHash: hash(body)};
}
function paper(id, grade, records) {
  return {paperId: id, grade, recordHashes: [...new Set(records.map(hash))], evidenceRefs: ['synthetic hand calculation']};
}
function corpus(queries) {
  return {schemaVersion: 1, corpusId: 'synthetic-engineering-example', kind: 'engineering_fixture',
    annotation: null, minimumTopics: 1, queries};
}
const evaluate = data => api.evaluateLiteratureRetrieval(data, null, bundleHash);
function reseal(pool) {
  const {contentHash: _hash, ...body} = pool;
  pool.contentHash = hash(body);
}

test('RRF and source-order baseline use a complete pool; graded metrics match hand calculations', () => {
  const low = record('low');
  const high = record('high');
  const secondHigh = record('high-openalex', 'openalex', high.doi);
  const data = corpus([{queryId: 'query-1', topicId: 'topic-1',
    pool: pool([ranked(low, 1), ranked(high, 2), ranked(secondHigh, 1)]),
    papers: [paper('low', 0, [low]), paper('high', 3, [high, secondHigh]), paper('missed', 1, [])]}]);
  const report = evaluate(data);
  const ideal = 7 + 1 / Math.log2(3);
  assert.equal(report.queries[0].baseline.recall20, 1 / 2);
  assert.equal(report.queries[0].rrf.recall20, 1 / 2);
  assert.equal(report.queries[0].baseline.ndcg10, (7 / Math.log2(3)) / ideal);
  assert.equal(report.queries[0].rrf.ndcg10, 7 / ideal);
  assert.equal(report.queries[0].rrf.duplicateRate20, 0);
  assert.equal(report.annotationAssurance, 'engineering_only');
  assert.equal(report.sampleStatus, 'engineering_only');
  assert.equal(report.implementationCommit, null);
  assert.equal(report.implementationBundleHash, bundleHash);
  const reversed = structuredClone(data);
  reversed.queries[0].pool.records.reverse(); reseal(reversed.queries[0].pool);
  assert.deepEqual(evaluate(reversed).queries[0].rrf, report.queries[0].rrf);
});

test('independently labeled duplicates gain relevance once and mixed-paper merges gain none', () => {
  const a = record('a'), b = record('b');
  const duplicate = evaluate(corpus([{queryId: 'duplicate', topicId: 'same-paper',
    pool: pool([ranked(a, 1), ranked(b, 2)]), papers: [paper('one-paper', 3, [a, b])]}]));
  assert.deepEqual(duplicate.queries[0].rrf, {recall20: 1, ndcg10: 1, duplicateRate20: 0.5,
    retrieved20: 2, duplicates20: 1, falseMerges20: 0});
  const wrong = {...b, doi: a.doi};
  const merged = evaluate(corpus([{queryId: 'mixed', topicId: 'mixed-paper',
    pool: pool([ranked(a, 1), ranked(wrong, 2)]), papers: [paper('a', 3, [a]), paper('b', 3, [wrong])]}]));
  assert.deepEqual(merged.queries[0].rrf, {recall20: 0, ndcg10: 0, duplicateRate20: 0,
    retrieved20: 1, duplicates20: 0, falseMerges20: 1});
});

test('failed queries stay in equal-topic averages and empty rankings do not claim zero duplicate quality', () => {
  const a = record('a');
  const queries = ['repeat-1', 'repeat-2'].map((queryId, index) => ({queryId, topicId: 'topic-a',
    pool: pool([ranked(a, 1)], `execution-${index}`), papers: [paper('a', 3, [a])]}));
  queries.push({queryId: 'failure', topicId: 'topic-b', pool: pool([], 'execution-failed', 'failed'),
    papers: [paper('missed', 3, [])]});
  const report = evaluate(corpus(queries));
  assert.equal(report.queryCount, 3);
  assert.equal(report.topicCount, 2);
  assert.equal(report.failedQueries, 1);
  assert.equal(report.summary.rrf.recall20, 0.5);
  assert.equal(report.summary.rrf.ndcg10, 0.5);
  assert.equal(report.queries[2].rrf.duplicateRate20, null);
});

test('corpus integrity, complete labeling and independent-review provenance fail explicitly', () => {
  const a = record('a');
  const data = corpus([{queryId: 'q', topicId: 't', pool: pool([ranked(a, 1)]), papers: [paper('a', 3, [a])]}]);
  const corrupt = structuredClone(data); corrupt.queries[0].pool.records[0].rank = 9;
  assert.throws(() => evaluate(corrupt), /literature_eval_pool_integrity_invalid/u);
  const incomplete = structuredClone(data); incomplete.queries[0].papers[0].recordHashes = [];
  assert.throws(() => evaluate(incomplete), /literature_eval_judgment_missing/u);
  const unpooled = structuredClone(data); unpooled.queries[0].pool.sources[0].returnedCount = 2; reseal(unpooled.queries[0].pool);
  assert.throws(() => evaluate(unpooled), /literature_eval_pool_incomplete/u);
  const noRelevant = structuredClone(data); noRelevant.queries[0].papers[0].grade = 0;
  assert.throws(() => evaluate(noRelevant), /literature_eval_relevance_denominator_missing/u);
  const duplicate = structuredClone(data); duplicate.queries.push(structuredClone(duplicate.queries[0]));
  assert.throws(() => evaluate(duplicate), /literature_eval_query_duplicate/u);
  const human = {...data, kind: 'human_reviewed', minimumTopics: 20, annotation: {
    method: 'independent_human', blindToRanking: true, reviewerIds: ['reviewer-a', 'reviewer-b'], producerIds: ['producer'],
    evidence: {reference: 'synthetic review receipt', sha256: '0'.repeat(64)}}};
  assert.throws(() => evaluate(human), /literature_eval_source_commit_required/u);
  const declared = api.evaluateLiteratureRetrieval(human, 'a'.repeat(40), bundleHash);
  assert.equal(declared.annotationAssurance, 'declared_independent_human');
  assert.equal(declared.sampleStatus, 'insufficient');
  const short = structuredClone(human); short.queries[0].pool.request.limit = 10; reseal(short.queries[0].pool);
  assert.throws(() => api.evaluateLiteratureRetrieval(short, 'a'.repeat(40), bundleHash), /literature_eval_candidate_cutoff_mismatch/u);
  human.annotation.producerIds = ['reviewer-a'];
  assert.throws(() => api.evaluateLiteratureRetrieval(human, 'a'.repeat(40), bundleHash), /literature_eval_independence_conflict/u);
});

test('offline CLI writes an explicitly engineering-only report, refuses overwrite and publishes no invalid result', () => {
  const a = record('a');
  const data = corpus([{queryId: 'cli-q', topicId: 'cli-t', pool: pool([ranked(a, 1)]), papers: [paper('a', 3, [a])]}]);
  const input = join(directory, 'input.json'), output = join(directory, 'report.json');
  writeFileSync(input, JSON.stringify(data));
  const command = ['scripts/evaluate-literature-retrieval.mjs', input, output];
  execFileSync(process.execPath, command, {cwd: process.cwd(), stdio: 'pipe'});
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.annotationAssurance, 'engineering_only');
  assert.equal(report.sampleStatus, 'engineering_only');
  assert.match(report.implementationBundleHash, /^[a-f0-9]{64}$/u);
  const original = readFileSync(output);
  const originalInput = structuredClone(data);
  assert.throws(() => execFileSync(process.execPath, command, {cwd: process.cwd(), stdio: 'pipe'}), /EEXIST/u);
  assert.deepEqual(readFileSync(output), original);
  data.queries[0].pool.records = []; writeFileSync(input, JSON.stringify(data));
  const invalidOutput = join(directory, 'invalid-report.json');
  assert.throws(() => execFileSync(process.execPath, ['scripts/evaluate-literature-retrieval.mjs', input, invalidOutput],
    {cwd: process.cwd(), stdio: 'pipe'}), /literature_eval_pool_integrity_invalid/u);
  assert.equal(existsSync(invalidOutput), false);
  const artifacts = join(process.cwd(), '.artifacts/research-optimization');
  mkdirSync(artifacts, {recursive: true});
  writeFileSync(join(artifacts, 'pr04-metrics-engineering-corpus.json'), JSON.stringify(originalInput, null, 2) + '\n');
  writeFileSync(join(artifacts, 'pr04-metrics-engineering-example.json'), JSON.stringify(report, null, 2) + '\n');
});

test('annotation preparation strips rankings and retains raw identifier differences without inventing relevance', () => {
  const original = record('W1', 'openalex');
  const records = ['123', '456'].map((pmid, index) => ({...ranked(original, index + 1),
    rawIdentifiers: {pmid}, identifiers: [{kind: 'pmid', value: pmid, identity: `pmid:${pmid}`, field: 'ids.pmid'}]}));
  const captures = {schemaVersion: 1, corpusId: 'unlabeled-engineering-captures', minimumTopics: 20,
    queries: [{queryId: 'q', topicId: 't', pool: pool(records)}]};
  const packet = api.prepareLiteratureJudgmentPacket(captures);
  assert.equal(packet.kind, 'unlabeled_packet');
  assert.equal(packet.rankingsIncluded, false);
  assert.equal(packet.queries[0].records.length, 1);
  const metadata = packet.queries[0].records[0];
  assert.deepEqual(metadata.identifiers, [{kind: 'pmid', value: '123'}, {kind: 'pmid', value: '456'}]);
  for (const field of ['rank', 'score', 'source', 'grade', 'candidateId', 'paperId']) assert.equal(field in metadata, false);
  assert.equal(metadata.recordHash, hash(original));
  const {contentHash, ...body} = packet;
  assert.equal(contentHash, hash(body));
  assert.throws(() => evaluate(packet));
  const input = join(directory, 'captures.json'), output = join(directory, 'packet.json');
  writeFileSync(input, JSON.stringify(captures));
  execFileSync(process.execPath, ['scripts/evaluate-literature-retrieval.mjs', '--prepare', input, output],
    {cwd: process.cwd(), stdio: 'pipe'});
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), packet);
  const historical = structuredClone(captures);
  historical.queries[0].pool.strategy = {kind:'historical',auditId:'a'.repeat(64),reason:'historical_search_plan_not_authorized'};
  reseal(historical.queries[0].pool);
  const historicalPacket = api.prepareLiteratureJudgmentPacket(historical);
  assert.equal(historicalPacket.queries[0].question,historical.queries[0].pool.request.query);
  assert.deepEqual(historicalPacket.queries[0].records,packet.queries[0].records);
  writeFileSync(join(process.cwd(), '.artifacts/research-optimization/pr04-metrics-unlabeled-packet.json'),
    JSON.stringify(packet, null, 2) + '\n');
});
