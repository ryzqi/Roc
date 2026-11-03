import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    export { ResearchRepository } from './src/main/plugins/research/repository';
    export { applyResearchDatabaseSchema, agentMigrations, researchMigrations } from './src/main/infrastructure/database-schemas';
    export { applyDatabaseMigrations } from './src/main/infrastructure/database-migrations';
    export { ResearchTaskRepository } from './src/main/plugins/research/research-task-repository';
    export { LiteratureImportService } from './src/main/plugins/research/literature-import-service';
    export { LiteratureSearchService, bibliographyFromRecord } from './src/main/plugins/research/literature-service';
    export { fuseLiterature, literatureRanking } from './src/main/plugins/research/literature-fusion';
    export { LiteratureResponseCache } from './src/main/plugins/research/literature-response-cache';
    export { LiteratureProviderGovernor, createLiteratureProviderGovernor } from './src/main/plugins/research/literature-provider-governor';
    export { LiteratureSearchLedger } from './src/main/plugins/research/literature-search-ledger';
    export { ResearchStageRuntime } from './src/main/plugins/research/stage-runtime';
    export { shutdownResearchPlugin } from './src/main/plugins/research/research-plugin-lifecycle';
    export { withLiteratureContext } from './src/main/services/literature-context';
    export { createLiteratureTools } from './src/main/plugins/agent/literature-tools';
  `, resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', loader: { '.md': 'text' }, logLevel: 'silent' });
  api = await import(outfile);
});
after(() => rmSync(directory, { recursive: true, force: true }));
const timestamp = '2026-10-23T00:00:00.000Z';
function record(id = '1', doi = `10.1234/${id}`) {
  return { id: `crossref:${id}`, source: 'crossref', externalId: id, doi, title: `Literature ${id}`, authors: ['Alice Smith'],
    abstract: 'A source abstract.', publishedYear: 2024, citationCount: 4, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp };
}

test('RRF gives one contribution per source, keeps provider ranks and resolves ties without arrival order', () => {
  const sharedCrossref = record('shared');
  const duplicateCrossref = {...sharedCrossref, id: 'crossref:duplicate', externalId: 'duplicate', title: 'Conflicting source title'};
  const soloCrossref = record('solo-crossref', null);
  const sharedOpenalex = {...sharedCrossref, source: 'openalex', id: 'openalex:shared', externalId: 'shared',
    publishedYear: 2023, authors: ['Another Author']};
  const soloOpenalex = {...record('solo-openalex', null), source: 'openalex'};
  const first = api.fuseLiterature([sharedCrossref, duplicateCrossref, soloCrossref, sharedOpenalex, soloOpenalex]);
  const interleaved = api.fuseLiterature([sharedOpenalex, sharedCrossref, soloOpenalex, duplicateCrossref, soloCrossref]);
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
  const sameTitles = api.fuseLiterature([
    {...record('a', null), title: 'Identical title'}, {...record('b', null), title: 'Identical title'}
  ]);
  assert.equal(sameTitles.length, 2, 'titles cannot merge distinct papers');
  const tied = api.fuseLiterature([record('z'), {...record('a'), source: 'openalex'}]);
  assert.deepEqual(tied.map(candidate => candidate.identity), ['doi:10.1234/a', 'doi:10.1234/z']);
  const doiVariants = api.fuseLiterature([record('case', '10.1234/CASE'),
    {...record('case', 'https://doi.org/10.1234/case'), source: 'openalex'}]);
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
    assert.equal(result.schemaVersion, 7);
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
  api.applyDatabaseMigrations(agentDb, { dbName: 'agent', migrations: api.agentMigrations });
  const repo = new api.ResearchRepository(db, new api.ResearchTaskRepository(agentDb), () => timestamp);
  const project = repo.createProject({ title: 'Import', description: '', workspacePath: `/tmp/roc-${crypto.randomUUID()}` });
  let time = timestamp;
  const changes = [];
  const prepare = options.prepare ?? (async (metadata) => ({ metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()) }));
  const search = options.search ?? { searchDetailed: async () => ({ records: options.records ?? [record()], sources: [
    { source: 'crossref', status: 'ok', returnedCount: 1, errorCode: null, retryAfterMs: null, requests: [], cache: {state: 'miss'},
      governance: api.createLiteratureProviderGovernor().observe('api.crossref.org'),
      coverage: {state: 'unknown', apiHitCount: null, validatedPages: 1, nextPage: null} }
  ], status: 'complete', truncated: false, warnings: [] }) };
  const make = () => new api.LiteratureImportService(db, repo.library, search, { prepareRecord: prepare,
    prepareDoi: async (doi, signal) => prepare(record(doi.split('/')[1], doi), signal) }, async (event) => changes.push(structuredClone(event)), () => time);
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
      assert.equal(result.records[0].doi, '10.1234/located');
      assert.equal(result.records[0].publishedYear, 2026);
      assert.equal(result.records[0].title, 'Located paper');
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
    assert.equal(result.schemaVersion, 7);
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
    assert.equal(first.sources[0].cache.state, 'miss');
    assert.equal(cached.sources[0].requests.length, 0);
    assert.deepEqual(cached.candidates, first.candidates);
    assert.deepEqual(cached.sources[0].cache, {state: 'hit',
      fetchedAt: first.candidates[0].record.importedAt, responseHash: first.sources[0].requests[0].responseHash});
    const persisted = JSON.parse(f.db.prepare('SELECT request_json FROM research_literature_searches WHERE id=?')
      .pluck().get(cached.searchId));
    assert.equal(persisted.projectId, f.project.id);
    const other = f.repo.createProject({title: 'Another cache scope', description: '', workspacePath: '/tmp/roc-other-cache-scope'});
    const otherResult = await f.run(() => f.service.search(request), {projectId: other.id});
    assert.equal(otherResult.sources[0].cache.state, 'miss');
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
  assert.equal((await search.searchDetailed(request)).sources[0].cache.state, 'hit');
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
  }, {complete: async () => { throw new Error('late_gate_must_not_execute'); }});
  try {
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
    const current = runtime.retry({projectId: f.project.id, runId: f.run.id, requestId: 'shutdown-parent'});
    await started;
    await api.shutdownResearchPlugin({stageRuntime: runtime, literature: search, literatureImports: null,
      productionInputs: null, exports: null, figures: null, experiments: null, indexer: null,
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
    assert.equal(hit.sources[0].cache.state, 'hit');
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
    assert.equal(JSON.parse(execution.request_json).query, 'cancelled original query');
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
    const id = ledger.begin(f.scope, {query: 'interrupted search', sources: ['crossref'], limit: 5, projectId: f.project.id});
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

test('research v6 upgrade adds receipt tables without fabricating executions or rewriting old candidates', () => {
  const db = new Database(':memory:');
  try {
    api.applyDatabaseMigrations(db, {dbName: 'research', migrations: api.researchMigrations.filter(entry => entry.version <= 6)});
    const old = JSON.stringify({schemaVersion: 5, searchId: 'old-search', candidates: []});
    db.prepare(`INSERT INTO research_literature_searches VALUES ('old-search','thread:old',NULL,'{}',?,'2030-01-01')`).run(old);
    api.applyDatabaseMigrations(db, {dbName: 'research', migrations: api.researchMigrations});
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_literature_search_executions').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_literature_request_receipts').pluck().get(), 0);
    assert.equal(db.prepare('SELECT result_json FROM research_literature_searches').pluck().get(), old);
  } finally { db.close(); }
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
    assert.equal(hit.sources[0].cache.state, 'hit');
    assert.deepEqual(hit.sources[0].requests, []);
    assert.deepEqual(hit.sources[0].coverage, first.sources[0].coverage);
    const stored = f.run(() => f.service.readSearch({searchId: hit.searchId}));
    assert.deepEqual(stored.sources[0].coverage, {apiHitCount: 500, validatedPages: 1, state: 'limited',
      nextPage: {kind: 'cursor', value: 'original+cursor/='}});
    assert.equal(stored.truncated, true);
  } finally { await search.shutdown(); f.close(); }
});

test('main-process tool context is absent from schemas; budgets and cancellation enforce execution boundary', async () => {
  const calls = [];
  const controller = new AbortController();
  const tools = api.createLiteratureTools({ invoke: async (name, input) => {
    calls.push({ name, input });
    return { schemaVersion: 7, executionId: 'search_exec_fixture', ranking: api.literatureRanking(['crossref']),
      searchId: 'search_fixture', createdAt: timestamp, expiresAt: timestamp, status: 'complete', candidates: [], sources: [], truncated: false, warnings: [], total: 0, nextOffset: null };
  } }, { owner: 'thread:a', projectId: 'project_a', signal: controller.signal }, { search: 'search', read: 'read', add: 'add', get: 'get', cancel: 'cancel' });
  assert.equal('projectId' in tools[0].schema.shape, false);
  await tools[0].invoke({ query: 'x', limit: 30 });
  await tools[0].invoke({ query: 'y', limit: 30 });
  await assert.rejects(tools[0].invoke({ query: 'z', limit: 1 }), /literature_search_budget_exhausted/);
  controller.abort();
  await assert.rejects(tools[1].invoke({ searchId: 'search_fixture' }));
  assert.equal(calls.length, 2);
});
