import assert from 'node:assert/strict';
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
    export { applyResearchDatabaseSchema } from './src/main/infrastructure/database-schemas';
    export { LiteratureImportService } from './src/main/plugins/research/literature-import-service';
    export { LiteratureSearchService, bibliographyFromRecord } from './src/main/plugins/research/literature-service';
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
function setup(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  api.applyResearchDatabaseSchema(db, () => timestamp);
  const repo = new api.ResearchRepository(db, () => timestamp);
  const project = repo.createProject({ title: 'Import', description: '', workspacePath: `/tmp/roc-${crypto.randomUUID()}` });
  let time = timestamp;
  const changes = [];
  const prepare = options.prepare ?? (async (metadata) => ({ metadata, bibliography: api.bibliographyFromRecord(metadata, new Set()) }));
  const search = options.search ?? { searchDetailed: async () => ({ records: options.records ?? [record()], sources: [
    { source: 'crossref', status: 'ok', returnedCount: 1, errorCode: null, retryAfterMs: null }
  ], status: 'complete', truncated: false, warnings: [] }) };
  const make = () => new api.LiteratureImportService(db, repo.library, search, { prepareRecord: prepare,
    prepareDoi: async (doi, signal) => prepare(record(doi.split('/')[1], doi), signal) }, async (event) => changes.push(structuredClone(event)), () => time);
  const service = make();
  const scope = { owner: 'thread:a', projectId: project.id, runId: 'run_a' };
  return { db, repo, service, project, scope, changes, make, setTime: (next) => { time = next; },
    run: (action, override = {}) => api.withLiteratureContext({ ...scope, ...override }, action),
    close: () => db.close() };
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
  assert.deepEqual(result.sources.map((s) => s.status), ['empty', 'rate_limited', 'error']);
  assert.equal(result.sources[1].retryAfterMs, 2000);
});

test('main-process tool context is absent from schemas; budgets and cancellation enforce execution boundary', async () => {
  const calls = [];
  const controller = new AbortController();
  const tools = api.createLiteratureTools({ invoke: async (name, input) => {
    calls.push({ name, input });
    return { searchId: 'search_fixture', createdAt: timestamp, expiresAt: timestamp, status: 'complete', candidates: [], sources: [], truncated: false, warnings: [], total: 0, nextOffset: null };
  } }, { owner: 'thread:a', projectId: 'project_a', signal: controller.signal }, { search: 'search', read: 'read', add: 'add', get: 'get', cancel: 'cancel' });
  assert.equal('projectId' in tools[0].schema.shape, false);
  await tools[0].invoke({ query: 'x', limit: 30 });
  await tools[0].invoke({ query: 'y', limit: 30 });
  await assert.rejects(tools[0].invoke({ query: 'z', limit: 1 }), /literature_search_budget_exhausted/);
  controller.abort();
  await assert.rejects(tools[1].invoke({ searchId: 'search_fixture' }));
  assert.equal(calls.length, 2);
});
