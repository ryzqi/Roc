import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import * as esbuild from 'esbuild';
import { createResearchFixture } from './fixtures/research-test-kit.mjs';

let directory;
let api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-literature-import-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'fixture.mjs');
  await esbuild.build({ stdin: { contents: `
    export {withResearchWorker} from './src/main/plugins/research/execution/worker-context';
    export { ResearchRepository } from './src/main/plugins/research/repository';
    export { applyAgentDatabaseSchema, applyResearchDatabaseSchema, researchSchema } from './src/main/infrastructure/database-schemas';
    export { ResearchTaskRepository } from './src/main/plugins/research/research-task-repository';
    export { LiteratureImportService } from './src/main/plugins/research/literature-import-service';
    export { LiteratureSearchService, bibliographyFromRecord } from './src/main/plugins/research/literature-service';
    export { normalizeResearchArxiv, normalizeResearchPmid, literatureIdentity } from './src/main/plugins/research/literature-identity';
    export { fuseLiterature, literatureRanking } from './src/main/plugins/research/literature-fusion';
    export { LiteratureResponseCache } from './src/main/plugins/research/literature-response-cache';
    export { LiteratureProviderGovernor, createLiteratureProviderGovernor } from './src/main/plugins/research/literature-provider-governor';
    export { LiteratureSearchLedger } from './src/main/plugins/research/literature-search-ledger';
    export { ResearchStageRuntime } from './src/main/plugins/research/stage-runtime';
    export { shutdownResearchPlugin } from './src/main/plugins/research/research-plugin-lifecycle';
    export { withLiteratureContext } from './src/main/services/literature-context';
    export { createLiteratureTools } from './src/main/plugins/agent/literature-tools';
    export { providerIdentifierObservations } from './src/main/plugins/research/literature-provider-identifiers';
    export { unknownLiteratureReview } from './src/main/plugins/research/literature-provider-review';
    export { registerResearchLibraryCapabilities } from './src/main/plugins/research/library-capabilities';
    export { registerLiteratureImportCapabilities } from './src/main/plugins/research/literature-import-capabilities';
    export { parseIpcRequestArgs } from './src/shared/ipc-registry';
  `, resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', loader: { '.md': 'text' }, logLevel: 'silent',
    plugins: process.env.ROC_POOL_BASELINE === '1' ? [{name: 'fixed-pool-baseline', setup(build) {
      build.onLoad({filter: /literature-import-service\.ts$/}, () => ({
        contents: execFileSync('git', ['show', 'af32a2c:src/main/plugins/research/literature-import-service.ts'], {encoding: 'utf8'}),
        loader: 'ts', resolveDir: join(process.cwd(), 'src/main/plugins/research')
      }));
    }}] : [] });
  api = await import(outfile);
});
after(() => rmSync(directory, { recursive: true, force: true }));
const timestamp = '2026-10-23T00:00:00.000Z';
function record(id = '1', doi = `10.1234/${id}`) {
  return { id: `crossref:${id}`, source: 'crossref', externalId: id, doi, title: `Literature ${id}`, authors: ['Alice Smith'],
    abstract: 'A source abstract.', publishedYear: 2024, citationCount: 4, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp };
}
function rankedRecords(records) {
  const ranks = new Map();
  return records.map(record => {
    const rank = (ranks.get(record.source) ?? 0) + 1;
    ranks.set(record.source, rank);
    return {record, rank, identifiers: [], rawIdentifiers: null, review: api.unknownLiteratureReview()};
  });
}

test('RRF gives one contribution per source, keeps provider ranks and resolves ties without arrival order', () => {
  const sharedCrossref = record('shared');
  const duplicateCrossref = {...sharedCrossref, id: 'crossref:duplicate', externalId: 'duplicate', title: 'Conflicting source title'};
  const soloCrossref = record('solo-crossref', null);
  const sharedOpenalex = {...sharedCrossref, source: 'openalex', id: 'openalex:shared', externalId: 'shared',
    publishedYear: 2023, authors: ['Another Author']};
  const soloOpenalex = {...record('solo-openalex', null), source: 'openalex'};
  const first = api.fuseLiterature(rankedRecords([sharedCrossref, duplicateCrossref, soloCrossref, sharedOpenalex, soloOpenalex]));
  const interleaved = api.fuseLiterature(rankedRecords([sharedOpenalex, sharedCrossref, soloOpenalex, duplicateCrossref, soloCrossref]));
  assert.deepEqual(first, interleaved);
  const shared = first.find(candidate => candidate.identity === 'doi:10.1234/shared');
  assert.equal(shared.score, 2 / 61);
  assert.equal(shared.origins.length, 3);
  assert.deepEqual(shared.contributions, [
    {source: 'crossref', rank: 1, score: 1 / 61},
    {source: 'openalex', rank: 1, score: 1 / 61}
  ]);
  assert.deepEqual(shared.record, sharedCrossref);
  assert.equal(shared.selectionReason, 'source_priority_then_rank_then_metadata_hash');
  assert.deepEqual(shared.conflicts.map(conflict => conflict.field), ['title', 'authors', 'publishedYear']);
  assert.deepEqual(shared.origins.map(origin => origin.record), [sharedCrossref, duplicateCrossref, sharedOpenalex]);
  assert.equal(first.find(candidate => candidate.identity === 'crossref:solo-crossref').contributions[0].rank, 3);
  const sameTitles = api.fuseLiterature(rankedRecords([
    {...record('a', null), title: 'Identical title'}, {...record('b', null), title: 'Identical title'}
  ]));
  assert.equal(sameTitles.length, 2, 'titles cannot merge distinct papers');
  const tied = api.fuseLiterature(rankedRecords([record('z'), {...record('a'), source: 'openalex'}]));
  assert.deepEqual(tied.map(candidate => candidate.identity), ['doi:10.1234/a', 'doi:10.1234/z']);
  const doiVariants = api.fuseLiterature(rankedRecords([record('case', '10.1234/CASE'),
    {...record('case', 'https://doi.org/10.1234/case'), source: 'openalex'}]));
  assert.equal(doiVariants.length, 1);
  assert.equal(doiVariants[0].conflicts.some(conflict => conflict.field === 'doi'), false);
});

test('model tools preview fused metadata while retaining the complete scoped source snapshots', async () => {
  const original = {...record(), abstract: 'x'.repeat(5000)};
  const f = setup({records: [original]});
  try {
    const tools = api.createLiteratureTools({invoke: (name, input) => {
      assert.equal(name, 'research.literature.search');
      return f.service.search(input);
    }}, f.scope, {search: 'search', read: 'read', add: 'add', get: 'get', cancel: 'cancel'});
    const preview = await tools[0].invoke({query: 'preview', sources: ['crossref'], limit: 5});
    assert.equal(preview.candidates[0].record.abstract.length, 800);
    assert.equal('record' in preview.candidates[0].origins[0], false);
    const snapshot = f.run(() => f.service.readSearch({searchId: preview.searchId, offset: 0, limit: 10}));
    assert.equal(snapshot.candidates[0].record.abstract.length, 5000);
    assert.deepEqual(snapshot.candidates[0].origins[0].record, original);
  } finally { f.close(); }
});

test('an old search snapshot fails explicitly and is retained without fabricated ranking fields', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const old = structuredClone(result);
    delete old.schemaVersion;
    delete old.ranking;
    f.db.prepare('UPDATE research_literature_searches SET result_json=? WHERE id=?')
      .run(JSON.stringify(old), result.searchId);
    assert.throws(() => f.run(() => f.service.readSearch({searchId: result.searchId, offset: 0, limit: 10})),
      /literature_storage_invalid/u);
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT result_json FROM research_literature_searches WHERE id=?')
      .pluck().get(result.searchId)), old);
  } finally { f.close(); }
});

test('fused candidate snapshots retain score, conflicts and original records through manual import', async () => {
  const primary = record('shared');
  const alternate = {...primary, source: 'openalex', id: 'openalex:shared', externalId: 'W1', publishedYear: 2023};
  const f = setup({records: [alternate, primary]});
  try {
    const result = await f.run(() => f.service.search({query: 'shared', sources: ['openalex', 'crossref'], limit: 5}));
    assert.equal(result.schemaVersion, 14);
    assert.deepEqual(result.ranking, {method: 'rrf', version: 1, k: 60,
      sourceWeights: [{source: 'crossref', weight: 1}, {source: 'openalex', weight: 1}]});
    assert.equal(result.candidates.length, 1);
    assert.equal(f.repo.library.list({projectId: f.project.id, query: '', limit: 10, includeArchived: false}).length, 0);
    const reread = f.run(() => f.service.readSearch({searchId: result.searchId, offset: 0, limit: 10}));
    assert.deepEqual(reread.candidates, result.candidates);
    assert.deepEqual(reread.candidates[0].record, primary);
    assert.equal(reread.candidates[0].conflicts[0].field, 'publishedYear');
    const imported = await f.run(() => f.service.add({entries: [{kind: 'candidate',
      searchId: result.searchId, candidateId: result.candidates[0].candidateId}], requestId: 'fused-manual-import'}));
    assert.equal(imported.counts.created, 1);
    assert.deepEqual(f.run(() => f.service.readSearch({searchId: result.searchId, offset: 0, limit: 10})).candidates,
      result.candidates, 'import cannot mutate the frozen source records');
  } finally { f.close(); }
});
function setup(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  api.applyResearchDatabaseSchema(db, () => timestamp);
  const agentDb = new Database(':memory:');
  api.applyAgentDatabaseSchema(agentDb);
  const repo = new api.ResearchRepository(db, new api.ResearchTaskRepository(agentDb), () => timestamp);
  const project = repo.createProject({ title: 'Import', description: '', workspacePath: `/tmp/roc-${crypto.randomUUID()}` });
  let time = timestamp;
  const changes = [];
  const prepare = options.prepare ?? (async (metadata) => ({ metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()) }));
  const search = options.search ?? { searchDetailed: async () => ({ records: options.rankedRecords ?? rankedRecords(options.records ?? [record()]), sources: [
    { source: 'crossref', status: 'ok', returnedCount: 1, errorCode: null, retryAfterMs: null, requests: [],
      governance: api.createLiteratureProviderGovernor().observe('api.crossref.org'),
      coverage: {state: 'unknown', apiHitCount: null, validatedPages: 1, nextPage: null}, stopReason: 'continuation_unavailable',
      pages: [{position: {kind: 'offset', value: 0}, rankOffset: 0, url: 'https://api.crossref.org/works?query=fixture',
        returnedCount: 1, cache: {state: 'miss'}, coverage: {state: 'unknown', apiHitCount: null, validatedPages: 1, nextPage: null}}] }
  ], status: 'complete', truncated: false, warnings: [] }) };
  const make = () => new api.LiteratureImportService(db, repo.library, search, {
    prepareRecord: async (metadata, projectId, signal) => {
      assert.equal(projectId, project.id);
      return prepare(metadata, signal);
    },
    prepareDoi: async (doi, projectId, signal) => {
      assert.equal(projectId, project.id);
      return prepare(record(doi.split('/')[1], doi), signal);
    }
  }, async (event) => changes.push(structuredClone(event)), () => time);
  const service = make();
  const scope = { owner: 'thread:a', projectId: project.id, runId: 'run_a' };
  return { db, repo, service, project, scope, changes, make, setTime: (next) => { time = next; },
    run: (action, override = {}) => api.withLiteratureContext({ ...scope, ...override }, action),
    close: () => { db.close(); agentDb.close(); } };
}
async function candidate(f) {
  const result = await f.run(() => f.service.search({ query: 'literature', sources: ['crossref'], limit: 10 }));
  return { result, entry: { kind: 'candidate', searchId: result.searchId, candidateId: result.candidates[0].candidateId } };
}

test('pure search persists only scoped candidates; explicit add indexes and links real library item', async () => {
  const f = setup();
  try {
    const { result, entry } = await candidate(f);
    assert.equal(result.candidates[0].matchedLibraryItemId, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_library').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_knowledge_documents').get().n, 0);
    const input = { entries: [entry, entry], requestId: 'add-1' };
    const added = await f.run(() => f.service.add(input));
    assert.equal(added.counts.created, 1);
    assert.deepEqual(added.items[0].inputPositions, [0, 1]);
    assert.match(added.items[0].libraryItemId, /^paper_/);
    assert.equal(added.items[0].metadata, 'ready');
    assert.equal(added.items[0].attachment, 'not_requested');
    assert.equal(added.items[0].parse, 'not_requested');
    assert.equal(added.items[0].index.keyword, 'ready');
    assert.deepEqual(f.repo.library.get(added.items[0].libraryItemId).projectIds, [f.project.id]);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_knowledge_documents').get().n, 1);
    assert.deepEqual(await f.run(() => f.service.add(input)), added);
    assert.deepEqual(f.run(() => f.service.get({ requestId: 'add-1' })), added);
    await assert.rejects(f.run(() => f.service.add({ ...input, destination: 'library_only' })), /import_request_conflict/);
    assert.equal(f.changes.length, 1);
  } finally { f.close(); }
});

test('transaction rollback never exposes an uncommitted library id in the ledger', async () => {
  const f = setup();
  try {
    f.db.exec(`CREATE TRIGGER reject_import_commit BEFORE UPDATE ON research_literature_imports
      WHEN json_extract(NEW.result_json, '$.counts.created') > 0
      BEGIN SELECT RAISE(ABORT, 'fixture_commit_failure'); END`);
    const result = await f.run(() => f.service.add({ requestId: 'rollback', entries: [{ kind: 'doi', doi: '10.1234/1' }] }));
    assert.equal(result.counts.failed, 1);
    assert.equal(result.items[0].libraryItemId, null);
    assert.equal(result.items[0].citationKey, null);
    assert.equal(result.items[0].index.keyword, 'not_requested');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_library').get().n, 0);
    assert.equal(f.changes.length, 0);
  } finally { f.close(); }
});

test('candidate ownership, project boundary, expiry and invented ids reject before any operation', async () => {
  const f = setup();
  try {
    const { entry } = await candidate(f);
    for (const [override, expected] of [[{ owner: 'thread:b' }, /literature_search_not_found/], [{ projectId: null }, /literature_project_required/]]) {
      await assert.rejects(f.run(() => f.service.add({ entries: [entry], requestId: crypto.randomUUID() }), override), expected);
    }
    await assert.rejects(f.run(() => f.service.add({ entries: [{ ...entry, candidateId: 'invented' }], requestId: 'bad' })), /literature_candidate_not_found/);
    f.setTime('2026-11-01T00:00:00.000Z');
    await assert.rejects(f.run(() => f.service.add({ entries: [entry], requestId: 'expired' })), /literature_search_expired/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_literature_imports').get().n, 0);
  } finally { f.close(); }
});

test('library-only then project add links; archived matches never restore; concurrent DOI adds deduplicate', async () => {
  const f = setup();
  try {
    const { entry } = await candidate(f);
    const first = await f.run(() => f.service.add({ entries: [entry], destination: 'library_only', requestId: 'global' }));
    const id = first.items[0].libraryItemId;
    assert.deepEqual(f.repo.library.get(id).projectIds, []);
    const concurrent = await Promise.all(['a', 'b'].map((requestId) => f.run(() => f.service.add({ entries: [{ kind: 'doi', doi: 'https://doi.org/10.1234/1' }], requestId }))));
    assert.deepEqual(concurrent.map((op) => op.items[0].disposition).sort(), ['already_present', 'linked']);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_library').get().n, 1);
    const current = f.repo.library.get(id);
    f.repo.library.archive(id, current.revision, true);
    const archived = await f.run(() => f.service.add({ entries: [entry], requestId: 'archived' }));
    assert.equal(archived.items[0].disposition, 'skipped_archived');
    assert.equal(f.repo.library.get(id).archived, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_knowledge_documents').get().n, 0);
  } finally { f.close(); }
});

test('arXiv DOI and arXiv search imports reuse the same item in either order', async () => {
  const doi = {...record('arxiv-doi', '10.48550/ARXIV.2410.07283'), source: 'doi',
    externalId: '10.48550/arxiv.2410.07283'};
  const arxiv = {...doi, id: 'arxiv:2410.07283v1', source: 'arxiv',
    externalId: 'http://arxiv.org/abs/2410.07283v1', doi: null};
  for (const records of [[doi, arxiv], [arxiv, doi]]) {
    const f = setup();
    try {
      const first = f.repo.library.import([{metadata: records[0],
        bibliography: api.bibliographyFromRecord(records[0], new Set())}], f.project.id);
      f.db.prepare('DELETE FROM research_library_aliases WHERE item_id=? AND identity<>?')
        .run(first.items[0].id, api.literatureIdentity(records[0]));
      const second = f.repo.library.import([{metadata: records[1],
        bibliography: api.bibliographyFromRecord(records[1], new Set())}], f.project.id);
      assert.equal(second.createdCount, 0, `duplicate created after ${records[0].source}`);
      assert.equal(second.items[0].id, first.items[0].id);
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 1);
      assert.equal(second.items[0].sources.length, 2, 'retain both source records');
      assert.deepEqual(second.items[0].sources.map(source => source.metadata.doi), records.map(value => value.doi?.toLowerCase() ?? null));
    } finally { f.close(); }
  }
});

test('arXiv DOI equivalence fuses explicit identifiers without merging other DOI namespaces or titles', () => {
  for (const id of ['2410.07283', 'hep-th/9901001']) {
    const arxiv = {...record('arxiv', null), source: 'arxiv', externalId: `${id}v2`};
    const doi = record('registered', `10.48550/ARXIV.${id.toUpperCase()}`);
    const fused = api.fuseLiterature(rankedRecords([arxiv, doi]));
    assert.equal(fused.length, 1);
    assert.equal(fused[0].origins.length, 2);
    assert.equal(fused[0].identity, `doi:10.48550/arxiv.${id}`);
    const unrelated = [record('other', `10.9999/arxiv.${id}`),
      record('malformed', '10.48550/arxiv.not-an-id'), record('suffix', `10.48550/arxiv.${id}.extra`)];
    assert.equal(api.fuseLiterature(rankedRecords([arxiv, ...unrelated])).length, 4);
  }
});

test('partial failures retain successes and generated citation keys remain unique', async () => {
  const f = setup({ prepare: async (metadata) => {
    if (metadata.doi.endsWith('/bad')) throw new Error('secret provider response');
    return { metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()) };
  } });
  try {
    const op = await f.run(() => f.service.add({ requestId: 'partial', entries: ['1', 'bad', '2'].map((id) => ({ kind: 'doi', doi: `10.1234/${id}` })) }));
    assert.equal(op.status, 'partial');
    assert.equal(op.counts.created, 2);
    assert.equal(op.counts.failed, 1);
    assert.equal(op.items[1].errorCode, 'literature_metadata_import_failed');
    assert.notEqual(op.items[0].citationKey, op.items[2].citationKey);
    const page = f.run(() => f.service.get({ operationId: op.operationId, limit: 1, offset: 1 }));
    assert.equal(page.items.length, 1);
    assert.equal(page.nextOffset, 2);
    assert.equal(page.counts.created, 2);
  } finally { f.close(); }
});

test('cancel during normalization keeps committed entries and does not commit later work', async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const f = setup({ prepare: async (metadata) => {
    if (metadata.doi.endsWith('/2')) { started(); await new Promise((resolve) => { release = resolve; }); }
    return { metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()) };
  } });
  try {
    const pending = f.run(() => f.service.add({ requestId: 'cancel', entries: ['1', '2', '3'].map((id) => ({ kind: 'doi', doi: `10.1234/${id}` })) }));
    await waiting;
    const running = f.run(() => f.service.get({ requestId: 'cancel' }));
    f.run(() => f.service.cancel(running.operationId));
    release();
    const result = await pending;
    assert.equal(result.status, 'partial');
    assert.equal(result.counts.created, 1);
    assert.equal(result.counts.cancelled, 2);
    assert.deepEqual(f.run(() => f.service.cancel(result.operationId)), result);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM research_library').get().n, 1);
  } finally { f.close(); }
});

test('restart recovery closes unfinished ledger and preserves committed item ids', async () => {
  const f = setup();
  try {
    const { entry } = await candidate(f);
    const op = await f.run(() => f.service.add({ requestId: 'restart', entries: [entry] }));
    const interrupted = structuredClone(op);
    interrupted.status = 'running'; interrupted.requestedCount = 2;
    interrupted.items.push({ ...interrupted.items[0], entryKey: 'doi:10.1234/2', inputPositions: [1], libraryItemId: null, citationKey: null, disposition: 'not_processed', metadata: 'not_requested' });
    f.db.prepare('UPDATE research_literature_imports SET result_json = ? WHERE id = ?').run(JSON.stringify(interrupted), op.operationId);
    f.make().recover();
    const recovered = f.run(() => f.service.get({ requestId: 'restart' }));
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.items[0].libraryItemId, op.items[0].libraryItemId);
    assert.equal(recovered.items[1].errorCode, 'literature_import_interrupted');
    assert.equal(recovered.items[1].retryable, true);
  } finally { f.close(); }
});

test('provider outcomes distinguish partial, empty, rate limiting and invalid response', async () => {
  const service = new api.LiteratureSearchService(async (url) => {
    if (url.includes('openalex')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (url.includes('crossref')) return new Response('rate limit', { status: 429, headers: { 'retry-after': '2' } });
    return new Response('broken', { status: 200 });
  });
  const result = await service.searchDetailed({ query: 'x', sources: ['openalex', 'crossref', 'semantic_scholar'], limit: 5 });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.sources.map((s) => [s.source, s.status]),
    [['crossref', 'rate_limited'], ['openalex', 'empty'], ['semantic_scholar', 'error']]);
  assert.equal(result.sources.find(source => source.source === 'crossref').retryAfterMs, 2000);
});

test('every Provider rejects missing result containers and invented paper identities instead of returning empty success', async () => {
  const cases = [
    ['openalex', {results: [{id: 'W1', title: 'Located paper'}]}, {results: [{}]}, {results: []}],
    ['crossref', {message: {items: [{DOI: '10.1234/located', title: ['Located paper']}]}},
      {message: {items: [{title: ['No DOI']}]}}, {message: {items: []}}],
    ['semantic_scholar', {data: [{paperId: 'S1', title: 'Located paper'}]}, {data: [{title: 'No paper ID'}]}, {data: []}],
    ['pubmed', {resultList: {result: [{id: '123', source: 'MED', title: 'Located paper', pubYear: '2024'}]}},
      {resultList: {result: [{source: 'MED', title: 'No paper ID'}]}}, {resultList: {result: []}}],
    ['europe_pmc', {resultList: {result: [{id: 'PMC123', source: 'PMC', title: 'Located paper'}]}},
      {resultList: {result: [{id: 'PMC123', title: 'No source identity'}]}}, {resultList: {result: []}}]
  ];
  for (const [source, valid, invalid, empty] of cases) {
    for (const [payload, expectedStatus] of [[valid, 'complete'], [invalid, 'failed'], [{error: 'bad query'}, 'failed'], [empty, 'complete']]) {
      const service = new api.LiteratureSearchService(async () => Response.json(payload));
      const result = await service.searchDetailed({query: 'located', sources: [source], limit: 5});
      assert.equal(result.status, expectedStatus, `${source}: ${JSON.stringify(payload)}`);
      if (expectedStatus === 'failed') {
        assert.equal(result.records.length, 0);
        assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
      } else {
        assert.equal(result.records.length, payload === valid ? 1 : 0);
      }
    }
  }
  let openAlexUrl;
  await new api.LiteratureSearchService(async url => { openAlexUrl = new URL(url); return Response.json({results: []}); })
    .searchDetailed({query: 'paging contract', sources: ['openalex'], limit: 7});
  assert.equal(openAlexUrl.searchParams.get('per_page'), '7');
  assert.equal(openAlexUrl.searchParams.has('per-page'), false);
});

test('arXiv parses located Atom records and DOI but refuses error feeds and invalid XML as papers', async () => {
  const feed = entry => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
    xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>${entry ? 1 : 0}</opensearch:totalResults>${entry}</feed>`;
  const paper = `<entry><id>http://arxiv.org/abs/2601.00001v2</id><title> Located paper </title>
    <summary>Original abstract</summary><published>2026-01-01T00:00:00Z</published>
    <author><name>Author</name></author><arxiv:doi>10.1234/located</arxiv:doi></entry>`;
  for (const [xml, expectedStatus, count] of [
    [feed(paper), 'complete', 1], [feed(''), 'complete', 0],
    [feed(paper.replace('http://arxiv.org/abs/2601.00001v2', 'http://arxiv.org/api/errors#query')), 'failed', 0],
    ['<html><title>Backend failure</title></html>', 'failed', 0],
    [feed(paper).replace('</feed>', ''), 'failed', 0],
    ['<feed/>', 'failed', 0]
  ]) {
    const result = await new api.LiteratureSearchService(async () => new Response(xml))
      .searchDetailed({query: 'located', sources: ['arxiv'], limit: 5});
    assert.equal(result.status, expectedStatus);
    assert.equal(result.records.length, count);
    if (expectedStatus === 'failed') assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
    if (count === 1) {
      assert.equal(result.records[0].record.doi, '10.1234/located');
      assert.equal(result.records[0].record.publishedYear, 2026);
      assert.equal(result.records[0].record.title, 'Located paper');
    }
  }
});

test('Provider request receipts persist exact query, page, retries, response hashes and transport failures', async () => {
  let attempts = 0;
  const body = JSON.stringify({message: {items: [{DOI: '10.1234/receipt', title: ['Receipt paper']}]}});
  const service = new api.LiteratureSearchService(async (_url, init) => {
    assert.equal(init.method, 'GET');
    attempts++;
    return attempts === 1 ? new Response('rate limited', {status: 429, headers: {'retry-after': '0'}}) : new Response(body);
  });
  const f = setup({search: service});
  try {
    const result = await f.run(() => f.service.search({query: 'exact query', sources: ['crossref'], limit: 5, yearFrom: 2020}));
    const requests = result.sources[0].requests;
    assert.equal(result.schemaVersion, 14);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => [request.attempt, request.status]), [[1, 429], [2, 200]]);
    assert.equal(requests[0].retryAfterMs, 0);
    assert.equal(requests[0].errorCode, 'literature_provider_http_429');
    assert.equal(requests[1].responseHash, createHash('sha256').update(body).digest('hex'));
    assert.equal(requests[1].errorCode, null);
    const url = new URL(requests[1].url);
    assert.equal(url.searchParams.get('query'), 'exact query');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('rows'), '5');
    assert.ok(requests.every(request => Number.isFinite(Date.parse(request.startedAt)) &&
      Number.isFinite(Date.parse(request.endedAt))));
    const reread = f.run(() => f.service.readSearch({searchId: result.searchId, offset: 0, limit: 10}));
    assert.deepEqual(reread.sources, result.sources);
    const storedRequest = JSON.parse(f.db.prepare('SELECT request_json FROM research_literature_searches WHERE id=?')
      .pluck().get(result.searchId));
    assert.equal(storedRequest.yearFrom, 2020);
  } finally { f.close(); }
  const invalid = await new api.LiteratureSearchService(async () => Response.json({error: 'invalid response'}))
    .searchDetailed({query: 'error payload', sources: ['openalex'], limit: 5});
  assert.equal(invalid.sources[0].errorCode, 'literature_provider_response_invalid');
  assert.equal(invalid.sources[0].requests[0].status, 200);
  assert.ok(invalid.sources[0].requests[0].responseHash);
  assert.equal(invalid.sources[0].requests[0].errorCode, null, 'HTTP receipt must not pretend payload validation was a transport error');
  const networkFailure = await new api.LiteratureSearchService(async () => { throw new Error('offline fixture'); })
    .searchDetailed({query: 'network error', sources: ['openalex'], limit: 5});
  assert.equal(networkFailure.status, 'failed');
  assert.equal(networkFailure.sources[0].requests[0].status, null);
  assert.equal(networkFailure.sources[0].requests[0].responseHash, null);
  assert.equal(networkFailure.sources[0].requests[0].errorCode, 'literature_provider_transport_error');
});

test('concurrent Provider responses cannot attach their request receipts to another source', async () => {
  const service = new api.LiteratureSearchService(async url => {
    if (url.includes('crossref')) {
      await new Promise(resolve => setTimeout(resolve, 5));
      return Response.json({message: {items: [{DOI: '10.1234/shared', title: ['Shared paper']}]}});
    }
    return Response.json({results: [{id: 'W1', doi: '10.1234/shared', title: 'Shared paper'}]});
  });
  const result = await service.searchDetailed({query: 'shared', sources: ['openalex', 'crossref'], limit: 5});
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.sources.map(source => source.source), ['crossref', 'openalex']);
  for (const source of result.sources) {
    assert.equal(source.requests.length, 1);
    assert.equal(new URL(source.requests[0].url).hostname, `api.${source.source}.org`);
    assert.equal(source.requests[0].status, 200);
    assert.ok(source.requests[0].responseHash);
  }
});

test('bounded response cache expires and evicts by byte budget and least recent access', () => {
  let now = 0;
  const cache = new api.LiteratureResponseCache({maxEntries: 2, maxBytes: 6, ttlMs: 10}, () => now);
  const response = body => ({body, fetchedAt: timestamp, responseHash: createHash('sha256').update(body).digest('hex')});
  cache.put('a', response('aaa'));
  cache.put('b', response('bb'));
  assert.equal(cache.get('a').body, 'aaa');
  cache.put('c', response('cc'));
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a').body, 'aaa');
  assert.equal(cache.get('c').body, 'cc');
  now = 10;
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), null);
  cache.put('oversize', response('1234567'));
  assert.equal(cache.get('oversize'), null);
  cache.put('fresh', response('fresh'));
  cache.clear();
  assert.equal(cache.get('fresh'), null);
});

test('cached searches retain original timestamps and hashes under the trusted project scope', async () => {
  let calls = 0;
  const search = new api.LiteratureSearchService(async () => {
    calls++;
    return Response.json({message: {items: [{DOI: '10.1234/cache', title: ['Cached paper']}]}});
  });
  const f = setup({search});
  try {
    const request = {query: 'cache scope', sources: ['crossref'], limit: 5, projectId: 'untrusted-input-project'};
    const first = await f.run(() => f.service.search(request));
    const cached = await f.run(() => f.service.search(request));
    assert.equal(calls, 1);
    assert.equal(first.sources[0].pages[0].cache.state, 'miss');
    assert.equal(cached.sources[0].requests.length, 0);
    assert.deepEqual(cached.candidates, first.candidates);
    assert.deepEqual(cached.sources[0].pages[0].cache, {state: 'hit',
      fetchedAt: first.candidates[0].record.importedAt, responseHash: first.sources[0].requests[0].responseHash});
    const persisted = JSON.parse(f.db.prepare('SELECT request_json FROM research_literature_searches WHERE id=?')
      .pluck().get(cached.searchId));
    assert.equal(persisted.projectId, f.project.id);
    const other = f.repo.createProject({title: 'Another cache scope', description: '', workspacePath: '/tmp/roc-other-cache-scope'});
    const otherResult = await f.run(() => f.service.search(request), {projectId: other.id});
    assert.equal(otherResult.sources[0].pages[0].cache.state, 'miss');
    assert.equal(calls, 2);
    await f.run(() => f.service.search({...request, limit: 6}));
    assert.equal(calls, 3, 'different source page sizes cannot share a response');
  } finally { await search.shutdown(); f.close(); }
});

test('failed payloads do not enter cache and service shutdown aborts work and refuses warm-cache reads', async () => {
  let calls = 0, startedResolve, lateResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const late = new Promise(resolve => { lateResolve = resolve; });
  let signal;
  const search = new api.LiteratureSearchService(async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json({error: 'bad payload'});
    if (calls === 2) return Response.json({results: [{id: 'W1', title: 'Valid paper'}]});
    signal = init.signal;
    startedResolve();
    return late;
  });
  const request = {query: 'cache failure', sources: ['openalex'], limit: 5, projectId: 'project'};
  assert.equal((await search.searchDetailed(request)).status, 'failed');
  assert.equal((await search.searchDetailed(request)).status, 'complete');
  assert.equal((await search.searchDetailed(request)).sources[0].pages[0].cache.state, 'hit');
  assert.equal(calls, 2);
  const pending = search.searchDetailed({...request, query: 'inflight shutdown'});
  const rejected = assert.rejects(pending, /literature_service_closed/u);
  await started;
  const shutdown = search.shutdown();
  assert.equal(signal.aborted, true);
  lateResolve(Response.json({results: [{id: 'W2', title: 'Late paper'}]}));
  await shutdown;
  await rejected;
  await assert.rejects(search.searchDetailed(request), /literature_service_closed/u);
  assert.equal(calls, 3);
});

test('plugin shutdown interrupts the actual parent stage before closing search and rejects late role output', async () => {
  const f = createResearchFixture(api, 'discovery');
  let startedResolve, sourceSignal, requests = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const search = new api.LiteratureSearchService(async (_url, init) => {
    requests++;
    if (requests > 1) return Response.json({results: []});
    sourceSignal = init.signal;
    startedResolve();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
    });
  });
  let roleFinished = false;
  const runtime = new api.ResearchStageRuntime(f.repository, {}, {
    async prepare() { return {providerId: 'fixture', modelId: 'fixture', async execute({signal}) {
      try {
        await search.searchDetailed({query: 'shutdown parent', sources: ['openalex'], limit: 5, projectId: f.project.id}, signal);
      } catch {
        // Simulate an executor that returns after cancellation; the real stage must fence it.
      }
      roleFinished = true;
      return {output: {title: 'Late output', markdown: 'Must not publish', claims: [], sections: [], verdict: 'ready'}, modelVersion: null};
    }}; }
  }, {complete: async () => { throw new Error('late_gate_must_not_execute'); }}, {cancelOwned: async () => {}});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({projectId: f.project.id, runId: f.run.id, requestId: 'shutdown-parent'});
    await started;
    await api.shutdownResearchPlugin({zenodo: null, monitors: null, stageRuntime: runtime, reviewSearch: null, scholarly: null, resources: null, openreview: null, huggingface: null, huggingfaceDownloads: null, literature: search, zotero: null, literatureImports: null,
      productionInputs: null, exports: null, figures: null, experiments: null, pythonEnvironments: null, indexer: null,
      embeddings: null, templates: null, documents: null, library: null, prose: null});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(roleFinished, true);
    assert.equal(sourceSignal.reason.message, 'research_run_interrupted_by_shutdown');
    assert.equal(f.repository.runs.get(current.id, f.project.id).status, 'interrupted');
    assert.deepEqual(f.repository.runs.get(current.id, f.project.id).outputArtifactIds, []);
    await assert.rejects(search.searchDetailed({query: 'shutdown parent', sources: ['openalex'], limit: 5}), /literature_service_closed/u);
    assert.equal(requests, 1);
  } finally { await runtime.shutdown(); await search.shutdown(); f.close(); }
});

test('concurrent searches share one host connection and cancellation removes queued HTTP work', async () => {
  let startedResolve, finishResolve, calls = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const finish = new Promise(resolve => { finishResolve = resolve; });
  const search = new api.LiteratureSearchService(async url => {
    calls++;
    if (url.includes('openalex')) return Response.json({results: []});
    startedResolve();
    if (calls === 1) await finish;
    return Response.json({message: {items: []}});
  });
  const request = {query: 'host admission', sources: ['crossref'], limit: 5};
  const first = search.searchDetailed(request);
  await started;
  const controller = new AbortController();
  const second = search.searchDetailed({...request, query: 'queued host'}, controller.signal);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'another search cannot bypass the shared host admission');
    const rejection = assert.rejects(second, /queued_cancelled/u);
    controller.abort(new Error('queued_cancelled'));
    await rejection;
    const independent = await search.searchDetailed({...request, sources: ['openalex']});
    assert.equal(independent.status, 'complete', 'a blocked host cannot hold an unrelated host');
    finishResolve();
    assert.equal((await first).status, 'complete');
    assert.equal(calls, 2);
  } finally { finishResolve(); await Promise.allSettled([first, second]); await search.shutdown(); }
});

function governanceFixture(overrides = {}) {
  let now = Date.parse(timestamp);
  const waits = [];
  const hosts = ['api.openalex.org', 'api.crossref.org', 'api.semanticscholar.org', 'export.arxiv.org', 'www.ebi.ac.uk'];
  const policy = {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600_000, failureThreshold: 3, cooldownMs: 60_000, ...overrides};
  const governor = new api.LiteratureProviderGovernor(Object.fromEntries(hosts.map(host => [host, policy])), () => now,
    async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); now += ms; });
  return {governor, waits, advance: ms => { now += ms; }, now: () => now};
}

test('host quota counts actual retries, permits cached reads and refuses dispatch until its window resets', async () => {
  const g = governanceFixture({maxRequests: 2});
  let calls = 0;
  const search = new api.LiteratureSearchService(async () => {
    calls++;
    return Response.json({results: [{id: 'W1', title: 'Quota paper'}]});
  }, g.governor);
  const request = {query: 'quota', sources: ['openalex'], limit: 5};
  try {
    const first = await search.searchDetailed(request);
    assert.equal(first.sources[0].governance.remainingRequests, 1);
    const cached = await search.searchDetailed(request);
    assert.equal(cached.sources[0].requests.length, 0);
    assert.equal(cached.sources[0].governance.remainingRequests, 1);
    await search.searchDetailed({...request, query: 'second dispatch'});
    const denied = await search.searchDetailed({...request, query: 'third dispatch'});
    assert.equal(denied.status, 'failed');
    assert.equal(denied.sources[0].errorCode, 'literature_provider_quota_exhausted');
    assert.equal(denied.sources[0].governance.state, 'quota_exhausted');
    assert.deepEqual(denied.sources[0].requests, []);
    assert.equal(calls, 2);
    g.advance(3600_000);
    const resumed = await search.searchDetailed({...request, query: 'new quota window'});
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.sources[0].governance.remainingRequests, 1);
    assert.equal(calls, 3);
  } finally { await search.shutdown(); }
});

test('Retry-After and response rate headers constrain later searches across projects without extending allowance', async () => {
  const g = governanceFixture();
  let calls = 0;
  const starts = [];
  const search = new api.LiteratureSearchService(async () => {
    starts.push(g.now());
    calls++;
    return calls === 1 ? new Response('rate limited', {status: 429, headers: {'retry-after': '0'}}) :
      Response.json({message: {items: []}}, {headers: {'x-rate-limit-limit': '1', 'x-rate-limit-interval': '2s'}});
  }, g.governor);
  try {
    const first = await search.searchDetailed({query: 'retry', sources: ['crossref'], limit: 5, projectId: 'project_a'});
    assert.deepEqual(first.sources[0].requests.map(receipt => receipt.status), [429, 200]);
    assert.equal(first.sources[0].governance.remainingRequests, 298);
    assert.equal(first.sources[0].governance.minIntervalMs, 2000);
    await search.searchDetailed({query: 'different project', sources: ['crossref'], limit: 5, projectId: 'project_b'});
    assert.equal(starts[1] - starts[0], 1000);
    assert.equal(starts[2] - starts[1], 2000);
    g.governor.responseLimits('api.crossref.org', new Headers({'x-rate-limit-limit': '100', 'x-rate-limit-interval': '1s'}));
    assert.equal(g.governor.observe('api.crossref.org').minIntervalMs, 2000);
    g.governor.failure('api.crossref.org', 5000);
    const release = await g.governor.acquire('api.crossref.org', new AbortController().signal);
    release();
    assert.equal(g.now() - starts[2], 5000);
  } finally { await search.shutdown(); }
});

test('invalid HTTP200 payloads open host cooldown and a validated recovery probe restores health', async () => {
  const g = governanceFixture();
  let valid = false, calls = 0;
  const search = new api.LiteratureSearchService(async () => {
    calls++;
    return valid ? Response.json({data: []}) : Response.json({error: 'schema changed'});
  }, g.governor);
  const request = {query: 'payload health', sources: ['semantic_scholar'], limit: 5};
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await search.searchDetailed(request);
      assert.equal(result.sources[0].requests[0].status, 200);
      assert.equal(result.sources[0].governance.consecutiveFailures, attempt + 1);
    }
    const blocked = await search.searchDetailed(request);
    assert.equal(blocked.sources[0].errorCode, 'literature_provider_cooldown');
    assert.equal(blocked.sources[0].governance.state, 'cooldown');
    assert.deepEqual(blocked.sources[0].requests, []);
    assert.equal(calls, 3);
    g.advance(60_000);
    valid = true;
    const recovered = await search.searchDetailed(request);
    assert.equal(recovered.status, 'complete');
    assert.equal(recovered.sources[0].governance.state, 'healthy');
    assert.equal(recovered.sources[0].governance.consecutiveFailures, 0);
    assert.equal(calls, 4);
  } finally { await search.shutdown(); }
});

test('PubMed and Europe PMC share host quota while unrelated Providers remain available', async () => {
  const g = governanceFixture({maxRequests: 1});
  const hosts = [];
  const search = new api.LiteratureSearchService(async url => {
    hosts.push(new URL(url).hostname);
    return url.includes('europepmc') ? Response.json({resultList: {result: []}}) : Response.json({results: []});
  }, g.governor);
  try {
    await search.searchDetailed({query: 'shared endpoint', sources: ['pubmed'], limit: 5});
    const denied = await search.searchDetailed({query: 'shared endpoint', sources: ['europe_pmc', 'openalex'], limit: 5});
    assert.equal(denied.status, 'partial');
    assert.equal(denied.sources.find(source => source.source === 'europe_pmc').errorCode, 'literature_provider_quota_exhausted');
    assert.deepEqual(hosts, ['www.ebi.ac.uk', 'api.openalex.org']);
    const defaults = api.createLiteratureProviderGovernor();
    assert.equal(defaults.observe('export.arxiv.org').minIntervalMs, 3000);
    assert.equal(defaults.observe('api.crossref.org').minIntervalMs, 1000);
  } finally { await search.shutdown(); }
});

test('cached responses cannot clear failures and caller cancellation cannot poison host health', async () => {
  const g = governanceFixture();
  let bad = false, calls = 0, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const search = new api.LiteratureSearchService(async (url, init) => {
    calls++;
    if (url.includes('semantic')) {
      startedResolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
    }
    return bad ? Response.json({error: 'bad payload'}) : Response.json({message: {items: []}});
  }, g.governor);
  const warm = {query: 'warm health', sources: ['crossref'], limit: 5};
  try {
    await search.searchDetailed(warm);
    bad = true;
    for (let i = 0; i < 3; i++) await search.searchDetailed({...warm, query: `bad health ${i}`});
    const hit = await search.searchDetailed(warm);
    assert.equal(hit.status, 'complete');
    assert.equal(hit.sources[0].pages[0].cache.state, 'hit');
    assert.equal(hit.sources[0].governance.state, 'cooldown');
    assert.equal(hit.sources[0].governance.consecutiveFailures, 3);
    assert.equal(calls, 4);
    const controller = new AbortController();
    const pending = search.searchDetailed({...warm, sources: ['semantic_scholar']}, controller.signal);
    const rejection = assert.rejects(pending, /intentional_cancel/u);
    await started;
    controller.abort(new Error('intentional_cancel'));
    await rejection;
    assert.equal(g.governor.observe('api.semanticscholar.org').consecutiveFailures, 0);
    assert.equal(g.governor.observe('api.semanticscholar.org').state, 'unknown');
    assert.equal(g.governor.observe('api.semanticscholar.org').remainingRequests, 299);
  } finally { await search.shutdown(); }
});

test('owned search cancellation preserves dispatch receipts and scope before a candidate snapshot exists', async () => {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const search = new api.LiteratureSearchService(async (_url, init) => {
    startedResolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  const f = setup({search});
  const controller = new AbortController();
  const pending = f.run(() => f.service.search({query: 'cancelled original query', sources: ['crossref'], limit: 5}),
    {signal: controller.signal});
  const rejection = assert.rejects(pending, /cancelled_search/u);
  try {
    await started;
    const execution = f.db.prepare('SELECT * FROM research_literature_search_executions').get();
    assert.equal(execution.status, 'running');
    assert.equal(execution.owner, f.scope.owner);
    assert.equal(execution.project_id, f.project.id);
    assert.equal(execution.run_id, f.scope.runId);
    assert.equal(JSON.parse(execution.request_json).request.query, 'cancelled original query');
    const active = f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').get(execution.id);
    assert.equal(active.state, 'dispatched');
    assert.equal(JSON.parse(active.receipt_json).endedAt, null);
    controller.abort(new Error('cancelled_search'));
    await rejection;
    const completed = f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(execution.id);
    assert.equal(completed.status, 'cancelled');
    assert.equal(completed.search_id, null);
    const receipt = JSON.parse(f.db.prepare('SELECT receipt_json FROM research_literature_request_receipts WHERE execution_id=?')
      .pluck().get(execution.id));
    assert.equal(receipt.status, null);
    assert.equal(receipt.errorCode, 'literature_provider_cancelled');
    assert.ok(receipt.endedAt);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
  } finally {
    controller.abort(new Error('cancelled_search'));
    await Promise.allSettled([pending, rejection]);
    await search.shutdown();
    f.close();
  }
});

test('audit persistence failures stop dispatch or publication and retain unknown transport state', async () => {
  for (const phase of ['started', 'finished', 'snapshot']) {
    let calls = 0;
    const search = new api.LiteratureSearchService(async () => {
      calls++;
      return Response.json({message: {items: []}});
    });
    const f = setup({search});
    try {
      const trigger = phase === 'started' ? `BEFORE INSERT ON research_literature_request_receipts` :
        phase === 'finished' ? `BEFORE UPDATE OF receipt_json ON research_literature_request_receipts` :
          `BEFORE INSERT ON research_literature_searches`;
      f.db.exec(`CREATE TRIGGER fixture_receipt_failure ${trigger} BEGIN SELECT RAISE(ABORT, 'fixture_receipt_write_failed'); END`);
      await assert.rejects(f.run(() => f.service.search({query: `audit failure ${phase}`, sources: ['crossref'], limit: 5})),
        phase === 'snapshot' ? /fixture_receipt_write_failed/u : /literature_request_audit_failed/u);
      assert.equal(calls, phase === 'started' ? 0 : 1);
      const execution = f.db.prepare('SELECT * FROM research_literature_search_executions').get();
      assert.equal(execution.status, 'failed');
      assert.equal(execution.search_id, null);
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
      const receipt = f.db.prepare('SELECT * FROM research_literature_request_receipts').get();
      if (phase === 'started') assert.equal(receipt, undefined);
      if (phase === 'finished') {
        assert.equal(receipt.state, 'unknown');
        assert.equal(JSON.parse(receipt.receipt_json).status, null);
        assert.equal(JSON.parse(receipt.receipt_json).endedAt, null);
      }
      if (phase === 'snapshot') {
        assert.equal(receipt.state, 'received');
        assert.equal(JSON.parse(receipt.receipt_json).status, 200);
      }
    } finally { await search.shutdown(); f.close(); }
  }
});

test('restart marks dispatched receipts unknown without inventing completion and fences late outcomes', async () => {
  const f = setup();
  try {
    const ledger = new api.LiteratureSearchLedger(f.db, () => timestamp);
    const id = ledger.begin(f.scope, {query: 'interrupted search', sources: ['crossref'], limit: 5, projectId: f.project.id}, null);
    const receipt = {attempt: 1, method: 'GET', url: 'https://api.crossref.org/works?query=interrupted',
      startedAt: timestamp, endedAt: null, status: null, retryAfterMs: null, responseHash: null, errorCode: null};
    const audit = ledger.audit(id);
    audit('started', 'crossref', receipt);
    f.make().recover();
    const execution = f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(id);
    assert.equal(execution.status, 'interrupted');
    assert.equal(execution.error_code, 'literature_search_interrupted');
    assert.equal(execution.run_id, f.scope.runId);
    const interrupted = f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').get(id);
    assert.equal(interrupted.state, 'unknown');
    assert.deepEqual(JSON.parse(interrupted.receipt_json), receipt);
    assert.throws(() => audit('finished', 'crossref', {...receipt, endedAt: timestamp, status: 200}), /literature_request_audit_failed/u);
    assert.throws(() => ledger.finish(id, 'complete', 'invented', null), /literature_search_execution_not_active/u);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').get(id), interrupted);
    f.make().recover();
    assert.deepEqual(f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(id), execution);
  } finally { f.close(); }
});

test('candidate expiry removes only the preview and preserves the linked execution and original request hash', async () => {
  const search = new api.LiteratureSearchService(async () => Response.json({message: {items: []}}));
  const f = setup({search});
  try {
    const first = await f.run(() => f.service.search({query: 'retained retrieval', sources: ['crossref'], limit: 5}));
    const receipt = f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').get(first.executionId);
    const execution = f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(first.executionId);
    assert.equal(execution.search_id, first.searchId);
    assert.equal(execution.status, 'complete');
    f.setTime('2026-11-20T00:00:00.000Z');
    await f.run(() => f.service.search({query: 'new retrieval', sources: ['crossref'], limit: 5}));
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches WHERE id=?').pluck().get(first.searchId), 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_literature_search_executions WHERE id=?').get(first.executionId), execution);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_literature_request_receipts WHERE execution_id=?').get(first.executionId), receipt);
  } finally { await search.shutdown(); f.close(); }
});

test('import shutdown drains every source receipt before closing an interrupted search', async () => {
  let startedResolve, lateResolve, calls = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const late = new Promise(resolve => { lateResolve = resolve; });
  const search = new api.LiteratureSearchService(async (url, init) => {
    calls++;
    if (calls === 2) startedResolve();
    if (url.includes('openalex')) return late;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  const f = setup({search});
  const pending = f.run(() => f.service.search({query: 'shutdown receipts', sources: ['crossref', 'openalex'], limit: 5}));
  const rejection = assert.rejects(pending, /literature_service_closed/u);
  let shutdownFinished = false;
  try {
    await started;
    const shutdown = f.service.shutdown().then(() => { shutdownFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownFinished, false);
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions').pluck().get(), 'running');
    lateResolve(Response.json({results: []}));
    await shutdown;
    await rejection;
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions').pluck().get(), 'interrupted');
    const receipts = f.db.prepare('SELECT state,receipt_json FROM research_literature_request_receipts').all();
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(row => row.state === 'received' && JSON.parse(row.receipt_json).endedAt !== null));
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
  } finally {
    lateResolve(Response.json({results: []}));
    await Promise.allSettled([pending, rejection]);
    await search.shutdown();
    f.close();
  }
});

test('Provider coverage preserves declared hit counts and continuations without inventing academic recall', async () => {
  const payloads = {
    openalex: {meta: {count: 12}, results: [{id: 'W1', title: 'Coverage paper'}]},
    crossref: {message: {'total-results': 12, items: [{DOI: '10.1234/coverage', title: ['Coverage paper']}]}},
    semantic_scholar: {total: 12, next: 1, data: [{paperId: 'S1', title: 'Coverage paper'}]},
    europe_pmc: {hitCount: 12, nextCursorMark: 'opaque+cursor/=', resultList: {result: [{id: 'PMC1', source: 'PMC', title: 'Coverage paper'}]}},
    pubmed: {hitCount: 12, nextCursorMark: 'opaque-med-cursor', resultList: {result: [{id: '1', source: 'MED', title: 'Coverage paper'}]}}
  };
  for (const [source, payload] of Object.entries(payloads)) {
    const result = await new api.LiteratureSearchService(async () => Response.json(payload))
      .searchDetailed({query: 'coverage', sources: [source], limit: 1});
    assert.equal(result.sources[0].coverage.apiHitCount, 12);
    assert.equal(result.sources[0].coverage.validatedPages, 1);
    assert.equal(result.sources[0].coverage.state, 'limited');
    assert.ok(result.sources[0].coverage.nextPage);
    assert.equal(result.truncated, true);
    assert.match(result.warnings.join(' '), /全部 API 命中/u);
    assert.equal('recall' in result.sources[0].coverage, false);
  }
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
    <opensearch:totalResults>12</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Coverage paper</title><summary>Abstract</summary><published>2026-01-01T00:00:00Z</published><author><name>Author</name></author></entry></feed>`;
  const arxiv = await new api.LiteratureSearchService(async () => new Response(xml))
    .searchDetailed({query: 'coverage', sources: ['arxiv'], limit: 1});
  assert.deepEqual(arxiv.sources[0].coverage, {apiHitCount: 12, validatedPages: 1, state: 'limited', nextPage: {kind: 'offset', value: 1}});
});

test('missing hit metadata remains unknown while invalid counts and oversized pages fail explicitly', async () => {
  for (const [payload, status, state] of [
    [{results: [{id: 'W1', title: 'Unknown count'}]}, 'complete', 'unknown'],
    [{meta: {count: 1}, results: [{id: 'W1', title: 'Reported end'}]}, 'complete', 'reported_end'],
    [{meta: {count: -1}, results: []}, 'failed', 'failed'],
    [{meta: {count: '12'}, results: []}, 'failed', 'failed'],
    [{meta: {count: 12}, results: []}, 'failed', 'failed'],
    [{results: [{id: 'W1', title: 'One'}, {id: 'W2', title: 'Two'}]}, 'failed', 'failed']
  ]) {
    const result = await new api.LiteratureSearchService(async () => Response.json(payload))
      .searchDetailed({query: 'coverage shape', sources: ['openalex'], limit: 1});
    assert.equal(result.status, status);
    assert.equal(result.sources[0].coverage.state, state);
    if (status === 'failed') {
      assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
      assert.equal(result.sources[0].requests[0].status, 200);
      assert.deepEqual(result.records, []);
    }
    if (state === 'unknown') {
      assert.equal(result.sources[0].coverage.apiHitCount, null);
      assert.match(result.warnings.join(' '), /未报告/u);
    }
  }
});

test('cached and persisted coverage retains the reported API count and original opaque cursor', async () => {
  const search = new api.LiteratureSearchService(async () => Response.json({hitCount: 500,
    nextCursorMark: 'original+cursor/=', resultList: {result: [{id: 'PMC1', source: 'PMC', title: 'Cached coverage'}]}}));
  const f = setup({search});
  try {
    const request = {query: 'cached continuation', sources: ['europe_pmc'], limit: 1};
    const first = await f.run(() => f.service.search(request));
    const hit = await f.run(() => f.service.search(request));
    assert.equal(hit.sources[0].pages[0].cache.state, 'hit');
    assert.deepEqual(hit.sources[0].requests, []);
    assert.deepEqual(hit.sources[0].coverage, first.sources[0].coverage);
    const stored = f.run(() => f.service.readSearch({searchId: hit.searchId}));
    assert.deepEqual(stored.sources[0].coverage, {apiHitCount: 500, validatedPages: 1, state: 'limited',
      nextPage: {kind: 'cursor', value: 'original+cursor/='}});
    assert.equal(stored.truncated, true);
  } finally { await search.shutdown(); f.close(); }
});

test('bounded search fetches later pages and preserves exact source ranks and every page receipt', async () => {
  const g = governanceFixture();
  const offsets = [];
  const search = new api.LiteratureSearchService(async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    const items = offset === 0 ?
      [{DOI: '10.1234/page-a', title: ['First']}, {DOI: '10.1234/page-a', title: ['Repeated first']}]:
      [{DOI: '10.1234/page-b', title: ['Second distinct']}, {DOI: '10.1234/page-c', title: ['Third distinct']}];
    return Response.json({message: {'total-results': 4, items}});
  }, g.governor);
  const f = setup({search});
  try {
    const result = await f.run(() => f.service.search({query: 'paged ranks', sources: ['crossref'], limit: 2, maxPages: 2}));
    assert.deepEqual(offsets, [0, 2]);
    assert.equal(result.sources[0].pages.length, 2);
    assert.equal(result.sources[0].coverage.validatedPages, 2);
    assert.equal(result.sources[0].coverage.state, 'reported_end');
    assert.deepEqual(result.candidates.map(candidate => candidate.contributions[0].rank), [1, 3]);
    assert.equal(result.candidates[0].origins.length, 2);
    assert.deepEqual(result.sources[0].requests.map(receipt => new URL(receipt.url).searchParams.get('offset')), ['0', '2']);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_request_receipts WHERE execution_id=?')
      .pluck().get(result.executionId), 2);
  } finally { await search.shutdown(); f.close(); }
});

test('OpenAlex page cap keeps the query and page size frozen and reports the uncollected continuation', async () => {
  const urls = [];
  const search = new api.LiteratureSearchService(async url => {
    urls.push(new URL(url));
    const page = Number(urls.at(-1).searchParams.get('page'));
    return Response.json({meta: {count: 20}, results: [{id: `W${page}`, title: `Page ${page}`}]});
  }, governanceFixture().governor);
  try {
    const result = await search.searchDetailed({query: 'frozen + query/字段', sources: ['openalex'], limit: 1, maxPages: 3});
    assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2', '3']);
    assert.ok(urls.every(url => url.searchParams.get('search') === 'frozen + query/字段' && url.searchParams.get('per_page') === '1'));
    assert.deepEqual(result.records.map(item => item.rank), [1, 2, 3]);
    assert.equal(result.sources[0].stopReason, 'page_limit');
    assert.deepEqual(result.sources[0].coverage, {apiHitCount: 20, validatedPages: 3, state: 'limited', nextPage: {kind: 'page', value: 4}});
    assert.equal(result.truncated, true);
    await assert.rejects(search.searchDetailed({query: 'cap', sources: ['openalex'], maxPages: 4}));
    assert.equal(urls.length, 3);
  } finally { await search.shutdown(); }
});

test('Semantic Scholar offset gaps preserve actual ranks and cannot establish complete API coverage', async () => {
  const offsets = [];
  const search = new api.LiteratureSearchService(async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    return Response.json({total: 10, ...(offset === 0 ? {next: 8} : {}),
      data: [{paperId: `S${offset}`, title: `Rank ${offset + 1}`}, {paperId: `S${offset + 1}`, title: `Rank ${offset + 2}`}]});
  }, governanceFixture().governor);
  try {
    const result = await search.searchDetailed({query: 'offset gap', sources: ['semantic_scholar'], limit: 2, maxPages: 3});
    assert.deepEqual(offsets, [0, 8]);
    assert.deepEqual(result.records.map(item => item.rank), [1, 2, 9, 10]);
    assert.equal(result.sources[0].stopReason, 'reported_end');
    assert.equal(result.sources[0].coverage.state, 'unknown');
    assert.equal(result.sources[0].coverage.apiHitCount, 10);
    assert.equal(result.sources[0].returnedCount, 4);
    assert.equal(result.truncated, true);
    assert.match(result.warnings.join(' '), /未报告/u);
  } finally { await search.shutdown(); }
});

test('Semantic Scholar stops before dispatching a page that exceeds its 1000-result provider cap', async () => {
  let calls = 0;
  const search = new api.LiteratureSearchService(async () => {
    calls++;
    return Response.json({total: 3000, next: 999, data: [{paperId: 'S1', title: 'Capped paper'}]});
  }, governanceFixture().governor);
  try {
    const result = await search.searchDetailed({query: 'provider cap', sources: ['semantic_scholar'], limit: 2, maxPages: 3});
    assert.equal(calls, 1);
    assert.equal(result.sources[0].stopReason, 'provider_limit');
    assert.deepEqual(result.sources[0].coverage.nextPage, {kind: 'offset', value: 999});
    assert.equal(result.truncated, true);
  } finally { await search.shutdown(); }
});

test('EBI opaque cursors retain exact bytes and the original query and host across pages', async () => {
  for (const source of ['pubmed', 'europe_pmc']) {
    const urls = [];
    const cursor = 'opaque+cursor/=&? 字段';
    const search = new api.LiteratureSearchService(async url => {
      urls.push(new URL(url));
      return Response.json({hitCount: 2, ...(urls.length === 1 ? {nextCursorMark: cursor} : {}),
        resultList: {result: [{id: `${urls.length}`, source: source === 'pubmed' ? 'MED' : 'PMC', title: 'Cursor paper'}]}});
    }, governanceFixture().governor);
    try {
      const query = 'query + term/字段';
      const result = await search.searchDetailed({query, sources: [source], limit: 1, maxPages: 3});
      assert.deepEqual(urls.map(url => url.searchParams.get('cursorMark')), ['*', cursor]);
      assert.ok(urls.every(url => url.origin === 'https://www.ebi.ac.uk' &&
        url.pathname === '/europepmc/webservices/rest/search' && url.searchParams.get('pageSize') === '1' &&
        url.searchParams.get('query') === (source === 'pubmed' ? `(${query}) AND SRC:MED` : query)));
      assert.deepEqual(result.records.map(item => item.rank), [1, 2]);
      assert.equal(result.sources[0].coverage.state, 'reported_end');
      assert.equal(result.sources[0].stopReason, 'reported_end');
      assert.deepEqual(result.sources[0].pages[1].position, {kind: 'cursor', value: cursor});
    } finally { await search.shutdown(); }
  }
});

test('arXiv offsets preserve ranks and every page obeys the three-second host spacing', async () => {
  const g = governanceFixture({minIntervalMs: 3000});
  const starts = [], urls = [];
  const search = new api.LiteratureSearchService(async url => {
    starts.push(g.now());
    urls.push(new URL(url));
    const offset = Number(urls.at(-1).searchParams.get('start'));
    return new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>2</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.0000${offset + 1}v1</id>
      <title>Page ${offset + 1}</title><summary>Abstract</summary><published>2026-01-01T00:00:00Z</published><author><name>Author</name></author></entry></feed>`);
  }, g.governor);
  try {
    const result = await search.searchDetailed({query: 'frozen query', sources: ['arxiv'], limit: 1, maxPages: 3});
    assert.deepEqual(urls.map(url => url.searchParams.get('start')), ['0', '1']);
    assert.ok(urls.every(url => url.searchParams.get('search_query') === 'all:frozen query'));
    assert.equal(starts[1] - starts[0], 3000);
    assert.deepEqual(result.records.map(item => item.rank), [1, 2]);
    assert.equal(result.sources[0].coverage.state, 'reported_end');
  } finally { await search.shutdown(); }
});

test('per-page cache provenance keeps original ranks while retries create separate durable receipts', async () => {
  const g = governanceFixture();
  let calls = 0, secondPageAttempts = 0;
  const search = new api.LiteratureSearchService(async url => {
    calls++;
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (offset === 1 && ++secondPageAttempts === 1) return new Response('retry later', {status: 429, headers: {'Retry-After': '0'}});
    return Response.json({message: {'total-results': 2, items: [{DOI: `10.1234/cache-page-${offset}`, title: [`Page ${offset}`]}]}});
  }, g.governor);
  const f = setup({search});
  try {
    const request = {query: 'page cache', sources: ['crossref'], limit: 1};
    const first = await f.run(() => f.service.search({...request, maxPages: 1}));
    const extended = await f.run(() => f.service.search({...request, maxPages: 2}));
    assert.deepEqual(extended.sources[0].pages.map(page => page.cache.state), ['hit', 'miss']);
    assert.deepEqual(extended.sources[0].pages[0].cache,
      {state: 'hit', fetchedAt: first.candidates[0].origins[0].retrievedAt, responseHash: first.sources[0].requests[0].responseHash});
    assert.deepEqual(extended.sources[0].requests.map(receipt => [receipt.attempt, receipt.status]), [[1, 429], [2, 200]]);
    assert.equal(extended.sources[0].pages[1].rankOffset, 1);
    assert.equal(extended.sources[0].governance.remainingRequests, 297);
    const stored = f.run(() => f.service.readSearch({searchId: extended.searchId}));
    assert.deepEqual(stored.sources, extended.sources);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_request_receipts WHERE execution_id=?').pluck().get(extended.executionId), 2);
    const hit = await f.run(() => f.service.search({...request, maxPages: 2}));
    assert.deepEqual(hit.sources[0].pages.map(page => page.cache.state), ['hit', 'hit']);
    assert.deepEqual(hit.sources[0].requests, []);
    assert.equal(calls, 3);
  } finally { await search.shutdown(); f.close(); }
});

test('later-page HTTP or schema failure retains validated candidates and publishes an audited partial outcome', async () => {
  for (const kind of ['http', 'schema']) {
    let calls = 0;
    const search = new api.LiteratureSearchService(async () => {
      calls++;
      return calls === 1 ? Response.json({message: {'total-results': 2, items: [{DOI: '10.1234/partial-page', title: ['Retained page']}]}}) :
        kind === 'http' ? new Response('unavailable', {status: 403}) : Response.json({message: {items: [{title: ['No DOI']}] }});
    }, governanceFixture().governor);
    const f = setup({search});
    try {
      const result = await f.run(() => f.service.search({query: `partial ${kind}`, sources: ['crossref'], limit: 1, maxPages: 3}));
      assert.equal(calls, 2);
      assert.equal(result.status, 'partial');
      assert.equal(result.candidates[0].identity, 'doi:10.1234/partial-page');
      const source = result.sources[0];
      assert.equal(source.status, 'partial');
      assert.equal(source.stopReason, 'failed');
      assert.equal(source.coverage.validatedPages, 1);
      assert.equal(source.coverage.apiHitCount, 2);
      assert.deepEqual(source.coverage.nextPage, {kind: 'offset', value: 1});
      assert.equal(source.pages[1].coverage.state, 'failed');
      assert.equal(source.errorCode, kind === 'schema' ? 'literature_provider_response_invalid' : 'literature_provider_error');
      assert.deepEqual(source.requests.map(receipt => receipt.status), [200, kind === 'http' ? 403 : 200]);
      assert.ok(source.requests[0].responseHash !== null);
      if (kind === 'schema') assert.ok(source.requests[1].responseHash !== null);
      else assert.equal(source.requests[1].responseHash, null, 'HTTP failure body is cancelled without reading');
      assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions WHERE id=?').pluck().get(result.executionId), 'partial');
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_request_receipts WHERE execution_id=?').pluck().get(result.executionId), 2);
      assert.deepEqual(f.run(() => f.service.readSearch({searchId: result.searchId})).sources, result.sources);
    } finally { await search.shutdown(); f.close(); }
  }
});

test('repeated cursors and backward or overlapping offsets fail before another page is dispatched', async () => {
  for (const source of ['europe_pmc', 'semantic_scholar']) {
    for (const next of source === 'europe_pmc' ? ['*', 'cursor-a'] : [0, 1]) {
      let calls = 0;
      const search = new api.LiteratureSearchService(async () => {
        calls++;
        return Response.json(source === 'europe_pmc' ?
          {hitCount: 20, nextCursorMark: calls === 1 ? (next === '*' ? '*' : 'cursor-a') : next,
            resultList: {result: [{id: `${calls}`, source: 'PMC', title: 'Cursor'}]}} :
          {total: 20, next: calls === 1 && next === 0 ? 2 : next, data: [{paperId: `S${calls}a`, title: 'One'}, {paperId: `S${calls}b`, title: 'Two'}]});
      }, governanceFixture().governor);
      try {
        const result = await search.searchDetailed({query: 'bad continuation', sources: [source], limit: 2, maxPages: 3});
        assert.equal(result.sources[0].stopReason, 'failed');
        assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
        assert.equal(calls, source === 'europe_pmc' && next === '*' || source === 'semantic_scholar' && next === 1 ? 1 : 2);
      } finally { await search.shutdown(); }
    }
  }
});

test('cancellation between pages or during a later page stops dispatch and retains receipts without a snapshot', async () => {
  for (const when of ['between', 'during']) {
    const controller = new AbortController();
    const g = governanceFixture();
    let calls = 0, reachedResolve;
    const reached = new Promise(resolve => { reachedResolve = resolve; });
    const search = new api.LiteratureSearchService(async (_url, init) => {
      calls++;
      if (calls === 2) {
        reachedResolve();
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
      }
      const response = Response.json({message: {'total-results': 3, items: [{DOI: '10.1234/cancel-page', title: ['Cancel page']}] }});
      if (when === 'between') {
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = () => {
          const reader = getReader();
          const cancel = reader.cancel.bind(reader);
          reader.cancel = async () => { await cancel(); controller.abort(new Error('paging_cancelled')); };
          return reader;
        };
      }
      return response;
    }, g.governor);
    const f = setup({search});
    const pending = f.run(() => f.service.search({query: `cancel ${when}`, sources: ['crossref'], limit: 1, maxPages: 3}), {signal: controller.signal});
    const rejected = assert.rejects(pending, /paging_cancelled/u);
    try {
      if (when === 'during') { await reached; controller.abort(new Error('paging_cancelled')); }
      await rejected;
      assert.equal(calls, when === 'between' ? 1 : 2);
      assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions').pluck().get(), 'cancelled');
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
      const receipts = f.db.prepare('SELECT state, receipt_json FROM research_literature_request_receipts ORDER BY attempt').all();
      assert.equal(receipts.length, calls);
      assert.ok(receipts.every(row => row.state === 'received' && JSON.parse(row.receipt_json).endedAt !== null));
      if (when === 'during') assert.equal(JSON.parse(receipts[1].receipt_json).status, null);
      assert.equal(g.governor.observe('api.crossref.org').consecutiveFailures, 0);
    } finally { await Promise.allSettled([pending, rejected]); await search.shutdown(); f.close(); }
  }
});

test('main-process tool context is absent from schemas; unlimited searches preserve the cancellation boundary', async () => {
  const calls = [];
  const controller = new AbortController();
  const tools = api.createLiteratureTools({ invoke: async (name, input) => {
    calls.push({ name, input });
    return { schemaVersion: 14, strategy: null, executionId: 'search_exec_fixture', ranking: api.literatureRanking(['crossref']),
      searchId: 'search_fixture', createdAt: timestamp, expiresAt: timestamp, status: 'complete', candidates: [], sources: [], truncated: false, warnings: [], total: 0, nextOffset: null };
  } }, { owner: 'thread:a', projectId: 'project_a', signal: controller.signal }, { search: 'search', read: 'read', add: 'add', get: 'get', cancel: 'cancel' });
  assert.equal('projectId' in tools[0].schema.shape, false);
  await tools[0].invoke({ query: 'x', limit: 30 });
  await tools[0].invoke({ query: 'y', limit: 30 });
  await tools[0].invoke({ query: 'z', limit: 30 });
  await tools[0].invoke({ query: 'fourth', limit: 30 });
  controller.abort();
  await assert.rejects(tools[1].invoke({ searchId: 'search_fixture' }));
  assert.equal(calls.length, 4);
});

test('Europe PMC namespaces remain distinct while MED records and PubMed share the real PMID', async () => {
  const search = new api.LiteratureSearchService(async url => {
    const medOnly = new URL(url).searchParams.get('query').includes('SRC:MED');
    return Response.json({resultList: {result: medOnly ? [{id: '123', source: 'MED', title: 'MED article'}] :
      [{id: '123', source: 'MED', title: 'MED article'}, {id: '123', source: 'PMC', title: 'Different PMC record'}]}});
  }, governanceFixture().governor);
  try {
    const result = await search.searchDetailed({query: 'namespace', sources: ['pubmed', 'europe_pmc'], limit: 5});
    const candidates = api.fuseLiterature(result.records);
    assert.equal(api.fuseLiterature(result.records.filter(item => item.record.source === 'europe_pmc')).length, 2);
    assert.equal(candidates.length, 2);
    const med = candidates.find(candidate => candidate.identity === 'pmid:123');
    assert.equal(med.origins.length, 2);
    assert.deepEqual(med.contributions.map(contribution => contribution.source), ['pubmed', 'europe_pmc']);
    assert.equal(candidates.find(candidate => candidate.identity === 'europe_pmc:PMC:123').origins.length, 1);
    assert.deepEqual(result.records.map(item => item.record.externalId), ['123', 'MED:123', 'PMC:123']);
  } finally { await search.shutdown(); }
});

test('arXiv revisions retain original records, one source contribution and observed version relationships', () => {
  const records = ['http://arxiv.org/abs/2601.00001v1', 'https://arxiv.org/abs/2601.00001v3'].map((externalId, index) => ({
    record: {...record(`arxiv-${index}`, null), source: 'arxiv', externalId, id: externalId}, rank: index + 1,
    identifiers: [], rawIdentifiers: null, review: api.unknownLiteratureReview()
  }));
  const candidates = api.fuseLiterature(records);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].identity, 'arxiv:2601.00001');
  assert.equal(candidates[0].score, 1 / 61);
  assert.deepEqual(candidates[0].origins.map(origin => origin.record), records.map(item => item.record));
  assert.equal(candidates[0].versionRelations.length, 1);
  assert.equal(candidates[0].versionRelations[0].older.version, 1);
  assert.equal(candidates[0].versionRelations[0].newer.version, 3);
  assert.deepEqual(api.fuseLiterature(records.toReversed()), candidates);
});

test('arXiv identifiers enforce date-specific widths, exact revisions and original archive notation', () => {
  for (const [value, expected] of [
    ['arXiv:0704.0001', {id: '0704.0001', version: null}],
    ['1412.9999v12', {id: '1412.9999', version: 12}],
    ['https://arxiv.org/abs/1501.00001v2', {id: '1501.00001', version: 2}],
    ['HTTP://ARXIV.ORG/abs/HEP-TH/9107001v1', {id: 'hep-th/9107001', version: 1}],
    ['arXiv:math.gt/0301001', {id: 'math.GT/0301001', version: null}],
    ['cs.SE/0703001v3', {id: 'cs.SE/0703001', version: 3}]
  ]) assert.deepEqual(api.normalizeResearchArxiv(value), expected);
  for (const invalid of ['0703.0001', '1412.00001', '1501.0001', '2600.00001', '2613.00001',
    '2601.00000', 'hep-th/9106001', 'math.GT/0704001', 'hep-th/9107000', '2601.00001v0',
    '2601.00001v9007199254740992', 'https://arxiv.org/abs/2601.00001?download=1',
    'https://user@arxiv.org/abs/2601.00001', 'https://other.test/abs/2601.00001']) {
    assert.throws(() => api.normalizeResearchArxiv(invalid), /research_arxiv_identifier_invalid/u, invalid);
  }
});

test('PMID spellings canonicalize without numerical rounding; conflicting DOIs remain distinct', () => {
  for (const spelling of ['123', 'PMID:123', 'https://pubmed.ncbi.nlm.nih.gov/123/']) assert.equal(api.normalizeResearchPmid(spelling), '123');
  assert.equal(api.normalizeResearchPmid('9007199254740993'), '9007199254740993');
  for (const invalid of ['0', '00123', '1e3', '123/x', 'https://pubmed.ncbi.nlm.nih.gov/123/?x=1']) {
    assert.throws(() => api.normalizeResearchPmid(invalid), /research_pmid_identifier_invalid/u);
  }
  const samePmid = [
    {...record('pmid-a'), source: 'pubmed', externalId: '123'},
    {...record('pmid-b'), source: 'europe_pmc', externalId: 'MED:123'}
  ];
  assert.equal(api.fuseLiterature(rankedRecords(samePmid)).length, 2);
  const versions = ['2601.00001v1', '2601.00001v2'].map((externalId, index) => ({...record(`version-${index}`), source: 'arxiv', externalId}));
  assert.equal(api.fuseLiterature(rankedRecords(versions)).length, 2, 'different DOIs are not an implicit publication relation');
  const withSharedDoi = api.fuseLiterature(rankedRecords(versions.map(value => ({...value, doi: '10.1234/shared-version'}))));
  assert.equal(withSharedDoi.length, 1);
  assert.equal(withSharedDoi[0].versionRelations.length, 1);
});

test('PubMed search rejects a non-MED provider record before caching or candidate publication', async () => {
  let calls = 0;
  const search = new api.LiteratureSearchService(async () => {
    calls++;
    return Response.json({resultList: {result: [{source: 'PMC', id: '123', title: 'Wrong PubMed namespace'}]}});
  }, governanceFixture().governor);
  try {
    for (let index = 0; index < 2; index++) {
      const result = await search.searchDetailed({query: 'non MED', sources: ['pubmed'], limit: 1});
      assert.equal(result.status, 'failed');
      assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
      assert.equal(result.records.length, 0);
    }
    assert.equal(calls, 2, 'invalid metadata cannot enter the response cache');
  } finally { await search.shutdown(); }
});

test('candidate import retains all observed arXiv revisions after the search expires and skips archived identity', async () => {
  const originals = ['http://arxiv.org/abs/2601.00001v1', 'https://arxiv.org/abs/2601.00001v3'].map((externalId, index) =>
    ({...record(`revision-${index}`, null), source: 'arxiv', externalId}));
  const f = setup({records: originals, prepare: async original => {
    const metadata = {...original, title: original.title.toUpperCase(), authors: ['SMITH, Alice']};
    return {metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())};
  }});
  try {
    const {result, entry} = await candidate(f);
    const imported = await f.run(() => f.service.add({entries: [entry], requestId: 'all-revisions'}));
    assert.equal(imported.counts.created, 1);
    const id = imported.items[0].libraryItemId;
    assert.deepEqual(f.repo.library.get(id).sources.map(source => source.providerRecord), originals);
    f.setTime('2026-11-03T00:00:00.000Z');
    assert.throws(() => f.run(() => f.service.readSearch({searchId: result.searchId})), /literature_search_expired/u);
    const saved = f.repo.library.get(id);
    assert.equal(saved.metadata.title, originals[0].title.toUpperCase());
    assert.deepEqual(saved.metadata.authors, ['SMITH, Alice']);
    assert.deepEqual(saved.sources.map(source => source.providerRecord), originals);
    assert.deepEqual(api.fuseLiterature(rankedRecords(saved.sources.map(source => source.providerRecord)))[0].versionRelations,
      result.candidates[0].versionRelations);
    f.repo.library.archive(id, saved.revision, true);
    const next = await candidate(f);
    assert.equal(next.result.candidates[0].matchedLibraryItemId, id);
    assert.equal(next.result.candidates[0].archived, true);
    const skipped = await f.run(() => f.service.add({entries: [next.entry], requestId: 'skip-revisions'}));
    assert.equal(skipped.counts.skippedArchived, 1);
    assert.equal(f.repo.library.get(id).archived, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 1);
  } finally { f.close(); }
});

test('one failing alternate source preparation rolls back the complete candidate import', async () => {
  const sources = [record('primary'), {...record('alternate', '10.1234/primary'), source: 'openalex'}];
  const f = setup({records: sources, prepare: async metadata => {
    if (metadata.source === 'openalex') throw new Error('research_bibliography_response_count_invalid');
    return {metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())};
  }});
  try {
    const {entry} = await candidate(f);
    const imported = await f.run(() => f.service.add({entries: [entry], requestId: 'alternate-failure'}));
    assert.equal(imported.counts.failed, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_knowledge_documents').pluck().get(), 0);
  } finally { f.close(); }
});

test('bibliography preparation cannot change an approved candidate identity', async () => {
  const f = setup({prepare: async original => {
    const metadata = {...original, doi: '10.1234/another-paper'};
    return {metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())};
  }});
  try {
    const {entry} = await candidate(f);
    const imported = await f.run(() => f.service.add({entries: [entry], requestId: 'changed-identity'}));
    assert.equal(imported.items[0].errorCode, 'literature_import_identity_changed');
    assert.equal(imported.counts.failed, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
  } finally { f.close(); }
});

test('manual library import joins MED and PubMed identities while retaining separate original observations', () => {
  const f = setup();
  try {
    const records = [
      {...record('pubmed-observation', null), source: 'pubmed', externalId: 'PMID:123'},
      {...record('med-observation', null), source: 'europe_pmc', externalId: 'MED:123'}
    ];
    const entries = records.map(metadata => ({metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())}));
    const imported = f.repo.library.import(entries, f.project.id);
    assert.equal(imported.createdCount, 1);
    assert.equal(imported.duplicateCount, 1);
    assert.deepEqual(imported.items[0].sources.map(source => source.metadata), records);
    assert.equal(f.repo.library.findByIdentity('pmid:123').id, imported.items[0].id);
  } finally { f.close(); }
});

function insertHistoricalLibrary(f, id, metadata) {
  const bibliography = api.bibliographyFromRecord(metadata, new Set());
  const identity = metadata.doi === null ? `${metadata.source}:${metadata.externalId}` : `doi:${metadata.doi}`;
  f.db.prepare(`INSERT INTO research_library VALUES (?,?,?,?,?,1,0,?,?)`)
    .run(id, identity, JSON.stringify(metadata), JSON.stringify(bibliography),
      JSON.stringify([{metadata, bibliography}]), timestamp, timestamp);
  f.db.prepare('INSERT INTO research_library_projects VALUES (?,?)').run(id, f.project.id);
}

test('DOI-free observations join a unique declared identity anchor and preserve their original metadata', () => {
  const records = [
    {...record('pubmed-free', null), source: 'pubmed', externalId: '123'},
    {...record('med-anchor'), source: 'europe_pmc', externalId: 'MED:123'},
    {...record('arxiv-free', null), source: 'arxiv', externalId: '2601.00001v1'},
    {...record('arxiv-anchor'), source: 'arxiv', externalId: 'http://arxiv.org/abs/2601.00001v3'}
  ];
  const candidates = api.fuseLiterature(rankedRecords(records));
  assert.equal(candidates.length, 2);
  const med = candidates.find(candidate => candidate.identity === 'doi:10.1234/med-anchor');
  assert.deepEqual(med.aliases, ['doi:10.1234/med-anchor', 'pmid:123']);
  assert.deepEqual(med.record, records[0], 'canonical identity does not rewrite the displayed provider record');
  assert.equal(med.origins.length, 2);
  assert.equal(med.score, 2 / 61);
  const arxiv = candidates.find(candidate => candidate.identity === 'doi:10.1234/arxiv-anchor');
  assert.deepEqual(arxiv.aliases, ['arxiv:2601.00001', 'doi:10.1234/arxiv-anchor']);
  assert.equal(arxiv.versionRelations.length, 1);
  assert.equal(arxiv.score, 1 / 61);
  const interleaved = [records[2], records[0], records[3], records[1]];
  assert.deepEqual(api.fuseLiterature(rankedRecords(interleaved)), candidates);
});

test('competing DOI anchors preserve a separate DOI-free candidate and report the identity conflict', () => {
  const records = [
    {...record('anchor-b'), source: 'pubmed', externalId: '123'},
    {...record('anchor-a'), source: 'europe_pmc', externalId: 'MED:123'},
    {...record('unresolved', null), source: 'pubmed', externalId: '123'}
  ];
  const candidates = api.fuseLiterature(rankedRecords(records));
  assert.equal(candidates.length, 3);
  assert.equal(candidates.find(candidate => candidate.identity === 'pmid:123').origins.length, 1);
  for (const candidate of candidates) assert.deepEqual(candidate.identityConflicts, [{
    alias: 'pmid:123', doiIdentities: ['doi:10.1234/anchor-a', 'doi:10.1234/anchor-b']
  }]);
});

test('a DOI-free primary candidate imports one canonical paper with every raw origin and durable aliases', async () => {
  const originals = [
    {...record('pmid-primary', null), source: 'pubmed', externalId: '123'},
    {...record('doi-anchor'), source: 'europe_pmc', externalId: 'MED:123'}
  ];
  const f = setup({records: originals});
  try {
    const {result, entry} = await candidate(f);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].record.doi, null);
    assert.equal(result.candidates[0].identity, 'doi:10.1234/doi-anchor');
    const imported = await f.run(() => f.service.add({entries: [entry], requestId: 'anchored-candidate'}));
    assert.equal(imported.counts.created, 1);
    const saved = f.repo.library.get(imported.items[0].libraryItemId);
    assert.equal(saved.metadata.title, originals[0].title);
    assert.equal(saved.metadata.doi, originals[1].doi);
    assert.equal(saved.bibliography.doi, originals[1].doi);
    assert.deepEqual(saved.sources.map(source => source.providerRecord), originals);
    assert.equal(f.repo.library.findByIdentity('pmid:123').id, saved.id);
    assert.equal(f.repo.library.findByIdentity('doi:10.1234/doi-anchor').id, saved.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 1);
    f.setTime('2026-11-03T00:00:00.000Z');
    const next = await candidate(f);
    assert.equal(next.result.candidates[0].matchedLibraryItemId, saved.id);
  } finally { f.close(); }
});

test('library aliases promote a uniquely matching DOI-free paper and never downgrade it on later imports', () => {
  const f = setup();
  try {
    const without = {...record('without', null), source: 'pubmed', externalId: '123'};
    const withDoi = {...record('with'), source: 'pubmed', externalId: '123'};
    const prepare = metadata => ({metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())});
    const first = f.repo.library.import([prepare(without)], f.project.id).items[0];
    const linked = f.repo.library.import([prepare(withDoi)], f.project.id);
    assert.equal(linked.createdCount, 0);
    assert.equal(linked.items[0].id, first.id);
    assert.equal(linked.items[0].metadata.doi, withDoi.doi);
    assert.equal(linked.items[0].bibliography.citationKey, first.bibliography.citationKey);
    const later = f.repo.library.import([prepare(without)], f.project.id);
    assert.equal(later.items[0].id, first.id);
    assert.equal(later.items[0].metadata.doi, withDoi.doi);
    assert.equal(f.db.prepare('SELECT identity_key FROM research_library').pluck().get(), `doi:${withDoi.doi}`);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 1);
    const archived = f.repo.library.archive(first.id, later.items[0].revision, true);
    assert.equal(f.repo.library.findByIdentity('pmid:123').archived, true);
    assert.throws(() => f.repo.library.import([prepare(without)], f.project.id, {skipArchived: true}), /research_library_item_archived/u);
    assert.equal(f.repo.library.get(archived.id).archived, true);
  } finally { f.close(); }
});

test('distinct library DOIs keep their own rows and make shared DOI-free aliases explicitly ambiguous', () => {
  const f = setup();
  try {
    const papers = ['a', 'b'].map(id => ({...record(id), source: 'pubmed', externalId: '123'}));
    for (const metadata of papers) f.repo.library.import([{metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())}], f.project.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 2);
    assert.throws(() => f.repo.library.findByIdentity('pmid:123'), /research_literature_identity_ambiguous/u);
    for (const metadata of papers) assert.equal(f.repo.library.findByIdentity(`doi:${metadata.doi}`, ['pmid:123']).metadata.doi, metadata.doi);
    const metadata = {...papers[0], doi: null};
    assert.throws(() => f.repo.library.import([{metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())}], f.project.id),
      /research_literature_identity_ambiguous/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 2);
  } finally { f.close(); }
});

test('ambiguous library matching retains the actual raw search pool without choosing or mutating a library item', async () => {
  const metadata = {...record('raw-ambiguous', null), source: 'pubmed', externalId: '123'};
  const f = setup({records: [metadata]});
  try {
    for (const suffix of ['a', 'b']) {
      const stored = {...metadata, doi: `10.1234/${suffix}`};
      f.repo.library.import([{metadata: stored, bibliography: api.bibliographyFromRecord(stored, new Set())}], f.project.id);
    }
    const before = f.db.prepare('SELECT * FROM research_library ORDER BY id').all();
    await assert.rejects(candidate(f), /research_literature_identity_ambiguous/u);
    const execution = f.db.prepare('SELECT * FROM research_literature_search_executions').get();
    assert.equal(execution.status, 'failed');
    const pool = f.run(() => f.service.readPool({executionId: execution.id, offset: 0, limit: 10}));
    assert.equal(pool.total, 1, 'a preview conflict must not erase retrieved source records');
    assert.deepEqual(pool.records[0].record, metadata);
    assert.equal(pool.sources.length, 1);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library ORDER BY id').all(), before);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_literature_searches').pluck().get(), 0);
    assert.throws(() => f.repo.library.findByIdentity('pmid:123'), /research_literature_identity_ambiguous/u);
  } finally { f.close(); }
});

test('a DOI-free observation cannot attach through a query anchor that conflicts with the stored library', () => {
  const f = setup();
  const known = {...record('stored-anchor'), source: 'pubmed', externalId: '123'};
  try {
    f.repo.library.import([{metadata: known, bibliography: api.bibliographyFromRecord(known, new Set())}], f.project.id);
    const candidates = [
      {...known, doi: '10.1234/current-query-anchor'},
      {...known, doi: null}
    ];
    const before = f.db.prepare('SELECT * FROM research_library').all();
    assert.throws(() => f.repo.library.import(candidates.map(metadata => ({metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())})), f.project.id),
      /research_literature_identity_ambiguous/u);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 1);
  } finally { f.close(); }
});

test('candidate import reports conflicting stored anchors without automatic retry or source mutation', async () => {
  const without = {...record('without', null), source: 'pubmed', externalId: '123'};
  const current = {...record('current'), source: 'europe_pmc', externalId: 'MED:123'};
  const f = setup({records: [without, current]});
  try {
    const stored = [{...without, doi: '10.1234/other-stored'}, current];
    for (const metadata of stored) f.repo.library.import([{metadata, bibliography: api.bibliographyFromRecord(metadata, new Set())}], f.project.id);
    const {entry} = await candidate(f);
    const before = f.db.prepare('SELECT * FROM research_library ORDER BY id').all();
    const result = await f.run(() => f.service.add({entries: [entry], requestId: 'ambiguous-stored-candidate'}));
    assert.equal(result.status, 'failed');
    assert.equal(result.items[0].errorCode, 'research_literature_identity_ambiguous');
    assert.equal(result.items[0].retryable, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library ORDER BY id').all(), before);
  } finally { f.close(); }
});

test('OpenAlex PMID observations bridge PubMed, retain raw fields on cache hits and survive candidate expiry', async () => {
  const raw = {openalex: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/OBSERVED',
    pmid: 'https://pubmed.ncbi.nlm.nih.gov/123/', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC456/',
    future: {nested: ['original', 7]}};
  let calls = 0;
  const search = new api.LiteratureSearchService(async url => {
    calls++;
    return Response.json(new URL(url).hostname === 'api.openalex.org' ?
      {meta: {count: 1}, results: [{id: 'https://openalex.org/W1', title: 'Observed IDs', ids: raw}]} :
      {hitCount: 1, resultList: {result: [{source: 'MED', id: '123', title: 'PubMed observation'}]}});
  }, governanceFixture().governor);
  const f = setup({search, prepare: async metadata => ({metadata,
    bibliography: {...api.bibliographyFromRecord(metadata, new Set()), csl: {type: 'article-journal', title: metadata.title}}})});
  try {
    const request = {query: 'observed IDs', sources: ['openalex', 'pubmed'], limit: 5};
    const first = await f.run(() => f.service.search(request));
    assert.equal(first.candidates.length, 1);
    const paper = first.candidates[0];
    assert.equal(paper.identity, 'doi:10.1234/observed');
    assert.equal(paper.record.doi, null, 'primary Provider record stays original');
    assert.deepEqual(paper.aliases, ['doi:10.1234/observed', 'openalex:https://openalex.org/W1', 'pmid:123']);
    assert.deepEqual(paper.origins[0].rawIdentifiers, raw);
    assert.deepEqual(paper.origins[0].identifiers, [
      {kind: 'doi', value: raw.doi, identity: 'doi:10.1234/observed', field: 'ids.doi'},
      {kind: 'pmid', value: raw.pmid, identity: 'pmid:123', field: 'ids.pmid'}
    ]);
    const hit = await f.run(() => f.service.search(request));
    assert.equal(calls, 2);
    assert.ok(hit.sources.every(source => source.pages[0].cache.state === 'hit'));
    assert.deepEqual(hit.candidates, first.candidates);
    const added = await f.run(() => f.service.add({requestId: 'observed-add', entries: [
      {kind: 'candidate', searchId: hit.searchId, candidateId: paper.candidateId}
    ]}));
    assert.equal(added.status, 'completed');
    const itemId = added.items[0].libraryItemId;
    const item = f.repo.library.get(itemId);
    assert.equal(item.metadata.doi, '10.1234/observed');
    assert.equal(item.bibliography.doi, item.metadata.doi);
    assert.equal(item.bibliography.fields.doi, item.metadata.doi);
    assert.equal(item.bibliography.csl.DOI, item.metadata.doi);
    assert.equal(item.sources[0].providerRecord.doi, null);
    const saved = f.repo.library.getIdentifiers({id: itemId});
    assert.equal(saved.total, 1);
    assert.deepEqual(saved.records[0], {metadataHash: paper.origins[0].metadataHash, executionId: hit.executionId,
      source: 'openalex', externalId: paper.origins[0].externalId, rank: 1, retrievedAt: paper.origins[0].retrievedAt,
      raw, identifiers: paper.origins[0].identifiers});
    f.setTime('2026-11-04T00:00:00.000Z');
    assert.throws(() => f.run(() => f.service.readSearch({searchId: hit.searchId})), /literature_search_expired/u);
    f.repo.library.archive(itemId, item.revision, true);
    assert.deepEqual(f.repo.library.getIdentifiers({id: itemId}), saved);
    assert.equal('rawIdentifiers' in item, false);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally { await search.shutdown(); f.close(); }
});

test('Semantic ArXiv observations bridge direct records without claiming fetched revisions or guessing PubMed keys', async () => {
  const raw = {DOI: '10.1234/SEMANTIC', ArXiv: 'arXiv:2601.00001v9', PubMed: '123', unknown: 'retain'};
  const search = new api.LiteratureSearchService(async url => {
    if (new URL(url).hostname === 'api.semanticscholar.org') {
      return Response.json({total: 1, data: [{paperId: 'S1', title: 'Semantic record', externalIds: raw}]});
    }
    return new Response(`<feed><totalResults>1</totalResults><entry><id>http://arxiv.org/abs/2601.00001v2</id>
      <title>Direct revision</title><summary>Direct abstract</summary><published>2026-01-01T00:00:00Z</published>
      <author><name>Author</name></author></entry></feed>`);
  }, governanceFixture().governor);
  try {
    const result = await search.searchDetailed({query: 'Semantic IDs', sources: ['semantic_scholar', 'arxiv'], limit: 5});
    const paper = api.fuseLiterature(result.records)[0];
    assert.equal(paper.origins.length, 2);
    assert.equal(paper.identity, 'doi:10.1234/semantic');
    assert.ok(paper.aliases.includes('arxiv:2601.00001'));
    assert.equal(paper.aliases.includes('pmid:123'), false);
    assert.deepEqual(paper.origins[0].rawIdentifiers, raw);
    assert.equal(paper.origins[0].identifiers[1].value, raw.ArXiv);
    assert.deepEqual(paper.versionRelations, [], 'only one revision was observed at the arXiv endpoint');
  } finally { await search.shutdown(); }
});

test('invalid known external identifiers fail before cache admission; unknown keys remain opaque', async () => {
  for (const [source, raw] of [
    ['openalex', {pmid: '00123'}], ['openalex', {doi: 'invalid'}],
    ['semantic_scholar', {ArXiv: '2601.0001'}], ['semantic_scholar', {DOI: 'invalid'}]
  ]) {
    let calls = 0;
    const search = new api.LiteratureSearchService(async () => {
      calls++;
      return Response.json(source === 'openalex' ? {results: [{id: 'W1', title: 'Invalid', ids: raw}]} :
        {data: [{paperId: 'S1', title: 'Invalid', externalIds: raw}]});
    }, governanceFixture({failureThreshold: 10}).governor);
    try {
      const request = {query: 'invalid identifiers', sources: [source], limit: 5};
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await search.searchDetailed(request);
        assert.equal(result.status, 'failed');
        assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
        assert.deepEqual(result.records, []);
      }
      assert.equal(calls, 2, 'invalid response was not cached');
    } finally { await search.shutdown(); }
  }
  assert.deepEqual(api.providerIdentifierObservations('semantic_scholar', {PubMed: 'invalid'}), []);
});

function observedRecord(metadata, raw, rank = 1) {
  return {record: metadata, rank, rawIdentifiers: raw, identifiers: api.providerIdentifierObservations(metadata.source, raw),
    review: api.unknownLiteratureReview()};
}
function identifierEntry(origin, executionId) {
  const metadata = origin.record;
  return {metadata, providerRecord: metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()),
    identifierRecord: {metadataHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'), executionId,
      source: metadata.source, externalId: metadata.externalId, rank: origin.rank, retrievedAt: metadata.importedAt,
      raw: origin.rawIdentifiers, identifiers: origin.identifiers}};
}

test('conflicting primary DOI and external DOI preserve conflict and cannot bridge a supplemental PMID', () => {
  const external = observedRecord({...record('W1'), source: 'openalex'},
    {doi: '10.1234/other', pmid: '123'});
  const pubmed = {...rankedRecords([{...record('MED', null), source: 'pubmed', externalId: '123'}])[0]};
  const papers = api.fuseLiterature([external, pubmed]);
  assert.equal(papers.length, 2);
  const anchored = papers.find(paper => paper.identity === 'doi:10.1234/W1'.toLowerCase());
  assert.ok(anchored);
  assert.equal(anchored.aliases.includes('pmid:123'), false);
  assert.deepEqual(anchored.identityConflicts[0].doiIdentities, ['doi:10.1234/other', 'doi:10.1234/w1']);
  const records = [
    observedRecord({...record('W1', '10.1234/a'), source: 'openalex'}, {pmid: '123'}),
    observedRecord({...record('W2', '10.1234/b'), source: 'openalex'}, {pmid: '123'}, 2),
    pubmed
  ];
  assert.equal(api.fuseLiterature(records).length, 3);
  assert.deepEqual(api.fuseLiterature(records), api.fuseLiterature(records.toReversed()));
});

test('durable identifier replay is idempotent and changed provenance rolls back all library changes', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const origin = observedRecord({...record('W1', null), source: 'openalex'}, {doi: '10.1234/declared', pmid: '123', unknown: 'one'});
    const entry = identifierEntry(origin, result.executionId);
    const added = f.repo.library.import([entry], f.project.id);
    const id = added.items[0].id;
    const before = f.db.prepare('SELECT * FROM research_library').all();
    f.repo.library.import([entry], f.project.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.repo.library.getIdentifiers({id}).total, 1);
    const different = {...entry, identifierRecord: {...entry.identifierRecord, raw: {...origin.rawIdentifiers, unknown: 'two'}}};
    assert.throws(() => f.repo.library.import([different], f.project.id), /research_library_identifier_observation_conflict/u);
    const otherRecord = observedRecord({...record('W2', '10.1234/other'), source: 'openalex'}, {});
    assert.throws(() => f.repo.library.import([identifierEntry(otherRecord, result.executionId)], f.project.id),
      /research_library_identifier_observation_conflict/u);
    for (const change of [{metadataHash: '0'.repeat(64)}, {externalId: 'fake'}, {retrievedAt: 'other'},
      {identifiers: []}]) {
      assert.throws(() => f.repo.library.import([{...entry, identifierRecord: {...entry.identifierRecord, ...change}}], f.project.id),
        /research_library_identifier_observation_mismatch/u);
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library_provider_identifiers').pluck().get(), 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally { f.close(); }
});

test('identifier API uses stable bounded pages, explicit missing-item errors and generated IPC defaults', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const origin = observedRecord({...record('W1', null), source: 'openalex'}, {pmid: '123'});
    const entries = [1, 2, 3].map(rank => identifierEntry({...origin, rank}, result.executionId));
    const id = f.repo.library.import(entries, f.project.id).items[0].id;
    const first = f.repo.library.getIdentifiers({id, limit: 2});
    assert.equal(first.total, 3);
    assert.deepEqual(first.records.map(record => record.rank), [1, 2]);
    assert.equal(first.nextOffset, 2);
    const second = f.repo.library.getIdentifiers({id, offset: first.nextOffset, limit: 2});
    assert.deepEqual(second.records.map(record => record.rank), [3]);
    assert.equal(second.nextOffset, null);
    assert.throws(() => f.repo.library.getIdentifiers({id: 'missing'}), /research_library_item_not_found/u);
    assert.throws(() => f.repo.library.getIdentifiers({id, limit: 51}));
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:library-identifiers', [{id}]), [{id, offset: 0, limit: 20}]);
    const handlers = new Map();
    api.registerResearchLibraryCapabilities({pluginId: 'research',
      capabilities: {register: (_plugin, descriptor, handler) => handlers.set(descriptor.name, handler)}}, f.repo.library, {});
    assert.deepEqual(await handlers.get('research.library.getIdentifiers')({id, limit: 2}), first);
    await assert.rejects(handlers.get('research.library.getIdentifiers')({id: 'missing'}),
      error => error.code === 'research_library_item_not_found' && error.retryable === false);
  } finally { f.close(); }
});

test('repeated PMID-only external observation preserves the canonical key and library revision', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const entry = identifierEntry(observedRecord({...record('W1', null), source: 'openalex'}, {pmid: '123'}), result.executionId);
    const item = f.repo.library.import([entry], f.project.id).items[0];
    assert.equal(f.db.prepare('SELECT identity_key FROM research_library WHERE id=?').pluck().get(item.id), 'pmid:123');
    assert.equal(item.metadata.doi, null);
    const repeated = f.repo.library.import([entry], f.project.id).items[0];
    assert.deepEqual(repeated, item);
    f.repo.library.import([{metadata: entry.metadata, bibliography: entry.bibliography}], f.project.id);
    assert.equal(f.db.prepare('SELECT identity_key FROM research_library WHERE id=?').pluck().get(item.id), 'pmid:123');
    assert.equal(f.repo.library.get(item.id).metadata.doi, null);
  } finally { f.close(); }
});

test('model previews omit raw identifier dictionaries while scoped snapshots keep unknown original values', async () => {
  const origin = observedRecord({...record('W1', null), source: 'openalex'}, {pmid: '123', huge: 'x'.repeat(10000)});
  const f = setup({rankedRecords: [origin]});
  try {
    const tools = api.createLiteratureTools({invoke: (name, input) => name === 'research.literature.search' ?
      f.service.search(input) : f.service.readSearch(input)}, f.scope,
      {search: 'search', read: 'read', add: 'add', get: 'get', cancel: 'cancel'});
    const result = await tools[0].invoke({query: 'bounded raw', sources: ['openalex'], limit: 5});
    for (const preview of [result, await tools[1].invoke({searchId: result.searchId})]) {
      assert.equal('rawIdentifiers' in preview.candidates[0].origins[0], false);
      assert.deepEqual(preview.candidates[0].origins[0].identifiers, origin.identifiers);
    }
    assert.equal(f.run(() => f.service.readSearch({searchId: result.searchId})).candidates[0].origins[0].rawIdentifiers.huge.length, 10000);
  } finally { f.close(); }
});

test('identifier persistence failure rolls back the candidate import and exposes no success-shaped item', async () => {
  const search = new api.LiteratureSearchService(async () => Response.json({
    results: [{id: 'W1', title: 'Rollback IDs', ids: {pmid: '123'}}]
  }), governanceFixture().governor);
  const f = setup({search});
  try {
    f.db.exec(`CREATE TRIGGER reject_identifier BEFORE INSERT ON research_library_provider_identifiers
      BEGIN SELECT RAISE(ABORT,'research_library_identifier_observation_conflict'); END`);
    const result = await f.run(() => f.service.search({query: 'rollback', sources: ['openalex'], limit: 5}));
    const added = await f.run(() => f.service.add({requestId: 'identifier-rollback', entries: [
      {kind: 'candidate', searchId: result.searchId, candidateId: result.candidates[0].candidateId}
    ]}));
    assert.equal(added.status, 'failed');
    assert.equal(added.items[0].errorCode, 'research_library_identifier_observation_conflict');
    assert.equal(added.items[0].retryable, false);
    assert.equal(added.items[0].libraryItemId, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library_aliases').pluck().get(), 0);
    assert.equal(f.changes.length, 0);
  } finally { await search.shutdown(); f.close(); }
});

test('candidate review retains declared copy scope, updates and retraction observations through cache and import', async () => {
  let calls = 0;
  const search = new api.LiteratureSearchService(async url => {
    calls++;
    if (new URL(url).hostname === 'api.openalex.org') await delay(10);
    return Response.json(new URL(url).hostname === 'api.openalex.org' ?
      {results: [{id: 'W1', doi: '10.1234/review', title: 'Review paper', type: 'article', is_retracted: true,
        primary_location: {landing_page_url: 'https://example.test/published', version: 'publishedVersion', license: 'cc-by'}}]} :
      {message: {items: [{DOI: '10.1234/review', title: ['Review paper'], type: 'journal-article',
        license: [{URL: 'https://example.test/accepted-license', 'content-version': 'am'}],
        'update-to': [{DOI: '10.1234/target', type: 'correction', label: 'Correction', source: 'publisher'}]}]}});
  }, governanceFixture().governor);
  const f = setup({search});
  try {
    const request = {query: 'review metadata', sources: ['openalex', 'crossref'], limit: 5};
    const first = await f.run(() => f.service.search(request));
    const hit = await f.run(() => f.service.search(request));
    assert.equal(calls, 2);
    assert.deepEqual(hit.candidates, first.candidates);
    const paper = hit.candidates[0];
    const [crossref, openalex] = paper.origins;
    assert.equal(crossref.review.publicationType, 'journal-article');
    assert.deepEqual(crossref.review.copies, [{field: 'license[0]', locationUrl: null, version: 'am', license: 'https://example.test/accepted-license'}]);
    assert.deepEqual(crossref.review.updates, [{type: 'correction', doi: '10.1234/target', label: 'Correction', source: 'publisher'}]);
    assert.equal(crossref.review.retraction.status, 'unknown', 'update target is not current-paper retraction');
    assert.deepEqual(openalex.review.copies, [{field: 'primary_location', locationUrl: 'https://example.test/published',
      version: 'publishedVersion', license: 'cc-by'}]);
    assert.deepEqual(openalex.review.retraction, {status: 'retracted', field: 'is_retracted'});
    const added = await f.run(() => f.service.add({requestId: 'review-import', entries: [
      {kind: 'candidate', searchId: hit.searchId, candidateId: paper.candidateId}
    ]}));
    assert.equal(added.status, 'completed');
    const id = added.items[0].libraryItemId;
    const reviews = f.repo.library.getReviews({id, limit: 1});
    assert.equal(reviews.total, 2);
    assert.equal(reviews.nextOffset, 1);
    assert.equal(f.repo.library.getReviews({id, offset: 1, limit: 1}).nextOffset, null);
    const all = f.repo.library.getReviews({id});
    const observed = [...paper.origins].sort((a,b) => b.retrievedAt.localeCompare(a.retrievedAt) ||
      a.source.localeCompare(b.source) || a.rank-b.rank);
    assert.deepEqual(all.records.map(({source,rank,retrievedAt,review}) => ({source,rank,retrievedAt,review})),
      observed.map(({source,rank,retrievedAt,review}) => ({source,rank,retrievedAt,review})));
    assert.ok(all.records.every(record => record.executionId === hit.executionId));
    f.setTime('2026-11-05T00:00:00.000Z');
    const item = f.repo.library.get(id);
    f.repo.library.archive(id, item.revision, true);
    assert.deepEqual(f.repo.library.getReviews({id}), all);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:library-reviews', [{id}]), [{id, offset: 0, limit: 20}]);
  } finally { await search.shutdown(); f.close(); }
});

test('false and absent retraction flags stay distinct; invalid review metadata never enters cache', async () => {
  for (const [flag, expected] of [[false, 'not_reported'], [undefined, 'unknown']]) {
    const search = new api.LiteratureSearchService(async () => Response.json({
      results: [{id: 'W1', title: 'Status', is_retracted: flag}]
    }), governanceFixture().governor);
    try {
      const result = await search.searchDetailed({query: 'status', sources: ['openalex'], limit: 5});
      assert.equal(result.records[0].review.retraction.status, expected);
      assert.deepEqual(result.records[0].review.copies, []);
    } finally { await search.shutdown(); }
  }
  for (const invalid of [{is_retracted: 'false'}, {type: ''}, {primary_location: {version: 'invented'}}]) {
    let calls = 0;
    const search = new api.LiteratureSearchService(async () => {calls++; return Response.json({
      results: [{id: 'W1', title: 'Invalid', ...invalid}]
    });}, governanceFixture({failureThreshold: 10}).governor);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await search.searchDetailed({query: 'invalid review', sources: ['openalex'], limit: 5});
        assert.equal(result.status, 'failed');
        assert.equal(result.sources[0].errorCode, 'literature_provider_response_invalid');
      }
      assert.equal(calls, 2);
    } finally { await search.shutdown(); }
  }
});

test('review replay refuses conflicting observations and mismatched metadata without partial library writes', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const metadata = {...record('review-durable'), source: 'openalex'};
    const entry = {...identifierEntry(observedRecord(metadata, {}), result.executionId),
      reviewRecord: {metadataHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'), executionId: result.executionId,
        source: metadata.source, externalId: metadata.externalId, rank: 1, retrievedAt: metadata.importedAt,
        review: api.unknownLiteratureReview()}};
    const item = f.repo.library.import([entry], f.project.id).items[0];
    f.repo.library.import([entry], f.project.id);
    assert.equal(f.repo.library.getReviews({id: item.id}).total, 1);
    const before = f.db.prepare('SELECT * FROM research_library').all();
    assert.throws(() => f.repo.library.import([{...entry, reviewRecord: {...entry.reviewRecord,
      review: {...entry.reviewRecord.review, publicationType: 'different'}}}], f.project.id), /research_library_review_observation_conflict/u);
    assert.throws(() => f.repo.library.import([{...entry, reviewRecord: {...entry.reviewRecord, metadataHash: '0'.repeat(64)}}], f.project.id),
      /research_library_review_observation_mismatch/u);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library').all(), before);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.throws(() => f.repo.library.getReviews({id: 'missing'}), /research_library_item_not_found/u);
  } finally { f.close(); }
});

test('review observation insertion failure rolls back the import operation and marks a nonretryable conflict', async () => {
  const f = setup();
  try {
    f.db.exec(`CREATE TRIGGER reject_review BEFORE INSERT ON research_library_provider_reviews
      BEGIN SELECT RAISE(ABORT,'research_library_review_observation_conflict'); END`);
    const {entry} = await candidate(f);
    const result = await f.run(() => f.service.add({requestId: 'review-rollback', entries: [entry]}));
    assert.equal(result.status, 'failed');
    assert.equal(result.items[0].retryable, false);
    assert.equal(result.items[0].errorCode, 'research_library_review_observation_conflict');
    assert.equal(result.items[0].libraryItemId, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
  } finally { f.close(); }
});

test('complete captured pool retains excluded and lower-ranked records beyond candidate limit and expiry', async () => {
  const records = [
    {...record('old'), publishedYear: 2019}, {...record('first'), publishedYear: 2026},
    {...record('second'), publishedYear: 2026}, {...record('unknown-year'), publishedYear: null}
  ];
  const f = setup({records});
  try {
    const result = await f.run(() => f.service.search({query: 'complete pool', sources: ['crossref'],
      limit: 1, yearFrom: 2020}));
    assert.equal(result.candidates.length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_search_pools WHERE execution_id=?').pluck().get(result.executionId), 1);
    const first = f.run(() => f.service.readPool({executionId: result.executionId, limit: 2}));
    assert.equal(first.total, 4);
    assert.deepEqual(first.records.map(item => item.record), records.slice(0, 2));
    assert.equal(first.nextOffset, 2);
    const next = f.run(() => f.service.readPool({executionId: result.executionId, offset: 2, limit: 2}));
    assert.deepEqual(next.records.map(item => item.record), records.slice(2));
    assert.equal(next.nextOffset, null);
    assert.equal(next.contentHash, first.contentHash);
    const {contentHash, total: _total, nextOffset: _next, ...body} = {...first, records: [...first.records, ...next.records]};
    assert.equal(contentHash, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.equal(first.request.yearFrom, 2020);
    f.setTime('2026-11-12T00:00:00.000Z');
    await f.run(() => f.service.search({query: 'next query', sources: ['crossref'], limit: 1}));
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches WHERE id=?').pluck().get(result.searchId), 0);
    assert.deepEqual(f.run(() => f.service.readPool({executionId: result.executionId, limit: 2})), first);
    assert.throws(() => f.run(() => f.service.readPool({executionId: result.executionId}), {owner: 'thread:other'}), /literature_pool_not_found/u);
    assert.throws(() => f.run(() => f.service.readPool({executionId: result.executionId}), {projectId: 'other-project'}), /literature_pool_not_found/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
  } finally { f.close(); }
});

test('pool reads reject tampered data and historical missing pools instead of inventing originals', async () => {
  const f = setup();
  try {
    const {result} = await candidate(f);
    const row = f.db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(result.executionId);
    const pool = JSON.parse(row);
    pool.records[0].rank = 99;
    f.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(JSON.stringify(pool), result.executionId);
    assert.throws(() => f.run(() => f.service.readPool({executionId: result.executionId})), /literature_pool_integrity_invalid/u);
    f.db.prepare('DELETE FROM research_literature_search_pools WHERE execution_id=?').run(result.executionId);
    assert.throws(() => f.run(() => f.service.readPool({executionId: result.executionId})), /literature_pool_not_found/u);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:literature-pool', [{executionId: result.executionId}]),
      [{executionId: result.executionId, offset: 0, limit: 20}]);
  } finally { f.close(); }
});

test('pool insertion failure atomically prevents candidate publication and preserves failed execution receipts', async () => {
  const f = setup();
  try {
    f.db.exec(`CREATE TRIGGER reject_pool BEFORE INSERT ON research_literature_search_pools
      BEGIN SELECT RAISE(ABORT,'pool_write_failure'); END`);
    await assert.rejects(f.run(() => f.service.search({query: 'rollback pool', sources: ['crossref'], limit: 5})), /pool_write_failure/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_searches').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_literature_search_pools').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT status FROM research_literature_search_executions').pluck().get(), 'failed');
  } finally { f.close(); }
});
