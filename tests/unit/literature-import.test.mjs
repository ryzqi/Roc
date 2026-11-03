import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as esbuild from 'esbuild';

let directory;
let api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-literature-import-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'fixture.mjs');
  await esbuild.build({ stdin: { contents: `
    export { ResearchRepository } from './src/main/plugins/research/repository';
    export { applyResearchDatabaseSchema, agentMigrations } from './src/main/infrastructure/database-schemas';
    export { applyDatabaseMigrations } from './src/main/infrastructure/database-migrations';
    export { ResearchTaskRepository } from './src/main/plugins/research/research-task-repository';
    export { LiteratureImportService } from './src/main/plugins/research/literature-import-service';
    export { LiteratureSearchService, bibliographyFromRecord } from './src/main/plugins/research/literature-service';
    export { fuseLiterature, literatureRanking } from './src/main/plugins/research/literature-fusion';
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
    assert.equal(result.schemaVersion, 3);
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
    { source: 'crossref', status: 'ok', returnedCount: 1, errorCode: null, retryAfterMs: null, requests: [] }
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
    assert.equal(result.schemaVersion, 3);
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

test('main-process tool context is absent from schemas; budgets and cancellation enforce execution boundary', async () => {
  const calls = [];
  const controller = new AbortController();
  const tools = api.createLiteratureTools({ invoke: async (name, input) => {
    calls.push({ name, input });
    return { schemaVersion: 3, ranking: api.literatureRanking(['crossref']),
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
