import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchIndexService, type ResearchIndexWatch } from '../../../../src/main/plugins/research/index-service';
import { ResearchEmbeddingService } from '../../../../src/main/plugins/research/embedding-service';
import { OpenAICompatibleEmbeddingClient, type EmbeddingFetch } from '../../../../src/main/plugins/research/embedding-client';
import type { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { knowledgeId } from '../../../../src/main/plugins/research/index-repository';
import { scanIndexFiles } from '../../../../src/main/plugins/research/index-files';

let db: Database.Database;
let repository: ResearchRepository;
let service: ResearchIndexService;
let embeddings: ResearchEmbeddingService;
let directory: string;
let workspace: string;
let cache: string;
let projectId: string;
const parse = vi.fn<ResearchToolchain['parseDocument']>();
const identity = vi.fn<ResearchToolchain['identity']>();
const fetchEmbedding = vi.fn<EmbeddingFetch>();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const watches: Array<{ path: string; notify: Parameters<ResearchIndexWatch>[1]; error: (error: Error) => void; closed: boolean }> = [];
const watchFactory: ResearchIndexWatch = (path, notify) => {
  const entry = { path, notify, error: (_error: Error): void => {}, closed: false };
  watches.push(entry);
  return { close: () => { entry.closed = true; }, on: (_event, listener) => { entry.error = listener; } };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function files() { return repository.indexing.listFiles(projectId, '', false, 100); }
function act(action: 'scan' | 'rebuild' | 'pause' | 'resume') {
  return service.control({ projectId, action, expectedRevision: repository.indexing.settings(projectId).revision });
}
async function idle() {
  await vi.waitFor(() => expect(service.status(projectId)).toMatchObject({ phase: 'idle', counts: { queued: 0, running: 0, failed: 0 } }), { timeout: 5000 });
}
async function parsed(input: Parameters<ResearchToolchain['parseDocument']>[0]) {
  await mkdir(input.outputDir, { recursive: true });
  return { sourceHash: researchContentHash(await readFile(input.sourcePath)), parserVersion: 'test-parser', pageCount: 1,
    content: 'Measured signal 42.', blocks: [{ id: '#/texts/0', kind: 'paragraph' as const, label: 'text', text: 'Measured signal 42.', locator: 'pages 1; #/texts/0', imagePath: null,
      locations: [{ page: 1, bbox: [0, 0, 10, 10] as [number, number, number, number], coordinateOrigin: 'TOPLEFT' as const }] }], assets: [], warnings: [] };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-project-index-')));
  workspace = join(directory, 'workspace');
  cache = join(directory, 'cache');
  await mkdir(workspace);
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Indexed project', description: 'File lifecycle.', workspacePath: workspace }).id;
  watches.length = 0;
  logger.warn.mockClear();
  const secrets = new Map<string, string>();
  fetchEmbedding.mockReset().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
  });
  embeddings = new ResearchEmbeddingService(repository.knowledge, new OpenAICompatibleEmbeddingClient(fetchEmbedding), {
    logger, secrets: { get: (key) => secrets.get(key) ?? null, set: (key, value) => { secrets.set(key, value); }, clear: (key) => { secrets.delete(key); } }
  });
  parse.mockReset().mockImplementation(parsed);
  identity.mockReset().mockResolvedValue('test-toolchain');
  service = new ResearchIndexService(repository, { parseDocument: parse, identity }, embeddings, cache, logger, watchFactory);
});
afterEach(async () => { await service.shutdown(); await embeddings.shutdown(); db.close(); await rm(directory, { recursive: true, force: true }); });

describe('research project index', () => {
  it('indexes project text and preserves captured source versions after edits and deletion', async () => {
    await writeFile(join(workspace, 'study.md'), 'Measured result: 42.');
    service.start();
    await idle();
    const first = files()[0];
    expect(first).toMatchObject({ path: 'study.md', status: 'ready', textIndexed: true });
    const evidence = repository.evidence.capture({ projectId, chunkId: `${knowledgeId(first.id)}:chunk:0` });
    const origin = service.evidenceSource(projectId, evidence.id);
    if (origin === null) throw new Error('source_reference_required');
    await writeFile(join(workspace, 'study.md'), 'Measured result: 50.');
    watches.at(-1)?.notify('change', 'study.md');
    await idle();
    expect(repository.knowledge.knowledgeChunks(knowledgeId(first.id))[0].content).toContain('50');
    await rm(join(workspace, 'study.md'));
    watches.at(-1)?.notify('rename', 'study.md');
    await idle();
    expect(files()).toEqual([]);
    expect(repository.evidence.list(projectId)).toEqual([evidence]);
    expect((await service.source(projectId, origin.fileId, origin.sourceHash)).bytes.toString()).toBe('Measured result: 42.');
    expect(repository.indexing.listFiles(projectId, '', true, 100)[0].status).toBe('missing');
  });

  it('keeps unchanged vectors and reparses only when the parser changes or rebuild is explicit', async () => {
    embeddings.saveConfig({ id: 'vectors', name: 'Vectors', baseUrl: 'https://embedding.test/v1', model: 'model', dimensions: 3, apiKey: 'sample-key', enabled: true });
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    service.start();
    await idle();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetchEmbedding).toHaveBeenCalledTimes(1);
    act('scan'); await idle();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetchEmbedding).toHaveBeenCalledTimes(1);
    identity.mockResolvedValue('updated-toolchain');
    act('scan'); await idle();
    expect(parse).toHaveBeenCalledTimes(2);
    act('rebuild'); await idle();
    expect(parse).toHaveBeenCalledTimes(3);
    expect(fetchEmbedding).toHaveBeenCalledTimes(3);
  });

  it('rebuilds vectors from stored text after configuration changes without reparsing PDF', async () => {
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    service.start(); await idle();
    const first = files()[0];
    const evidence = repository.evidence.capture({ projectId, chunkId: `${knowledgeId(first.id)}:chunk:0` });
    embeddings.saveConfig({ id: 'vectors', name: 'Vectors', baseUrl: 'https://embedding.test/v1', model: 'model', dimensions: 3, apiKey: 'sample-key', enabled: true });
    service.configurationChanged(); await idle();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetchEmbedding).toHaveBeenCalledTimes(1);
    expect(repository.evidence.capture({ projectId, chunkId: `${knowledgeId(first.id)}:chunk:0` })).toEqual(evidence);
  });

  it.each([true, false])('refreshes a queued cached parse after restarting with a new toolchain (watch=%s)', async (watch) => {
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    service.start(); await idle();
    await service.shutdown();
    const { projectId: _id, revision, ...options } = repository.indexing.settings(projectId);
    repository.indexing.saveSettings(projectId, revision, { ...options, watch });
    const settings = repository.indexing.settings(projectId);
    const scanned = await scanIndexFiles(workspace, settings, cache, new AbortController().signal);
    repository.indexing.reconcile(projectId, repository.indexing.beginScan(projectId), scanned, false, null, new Map([['pdf', 'docling:test-toolchain']]));
    const previous = repository.indexing.nextJob();
    if (previous === null) throw new Error('expected_index_job');
    expect(repository.indexing.cached(previous.fileId).payload?.parserKey).toBe('docling:test-toolchain');
    identity.mockResolvedValue('updated-toolchain');
    service = new ResearchIndexService(repository, { parseDocument: parse, identity }, embeddings, cache, logger, watchFactory);
    service.start(); await idle();
    expect(repository.indexing.job(previous.id).status).toBe('cancelled');
    expect(parse).toHaveBeenCalledTimes(2);
    expect(repository.indexing.cached(previous.fileId).payload?.parserKey).toBe('docling:updated-toolchain');
  });

  it('retries failed parses after a toolchain upgrade and keeps the replacement failure visible', async () => {
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    service.start(); await idle();
    parse.mockRejectedValueOnce(new Error('research_parser_failed'));
    act('rebuild');
    await vi.waitFor(() => expect(files()[0]).toMatchObject({ status: 'failed', error: 'research_parser_failed' }));
    identity.mockResolvedValue('updated-toolchain');
    parse.mockRejectedValueOnce(new Error('research_updated_parser_failed'));
    act('scan');
    await vi.waitFor(() => expect(files()[0]).toMatchObject({ status: 'failed', error: 'research_updated_parser_failed' }));
    expect(parse).toHaveBeenCalledTimes(3);
    act('scan');
    await vi.waitFor(() => expect(service.status(projectId).phase).toBe('failed'));
    expect(parse).toHaveBeenCalledTimes(3);
    identity.mockResolvedValue('third-toolchain');
    act('scan'); await idle();
    expect(parse).toHaveBeenCalledTimes(4);
    expect(repository.indexing.cached(files()[0].id).payload?.parserKey).toBe('docling:third-toolchain');
  });

  it('stops a late parser result on pause and resumes with a new task', async () => {
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    const entered = deferred<void>();
    const release = deferred<void>();
    parse.mockImplementationOnce(async (input) => { entered.resolve(); await release.promise; return await parsed(input); });
    service.start();
    try {
      await entered.promise;
      const oldJob = repository.indexing.listJobs(projectId, 10)[0];
      act('pause');
      expect(service.status(projectId).phase).toBe('paused');
      expect(parse.mock.calls[0][0].signal?.aborted).toBe(true);
      act('resume');
      release.resolve();
      await idle();
      expect(repository.indexing.job(oldJob.id).status).toBe('cancelled');
      expect(files()[0].status).toBe('ready');
      expect(parse).toHaveBeenCalledTimes(2);
    } finally { release.resolve(); }
  });

  it('retains pending manual work across shutdown with filesystem watching disabled', async () => {
    const { projectId: _id, revision, ...options } = repository.indexing.settings(projectId);
    repository.indexing.saveSettings(projectId, revision, { ...options, watch: false });
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    const entered = deferred<void>();
    const release = deferred<void>();
    parse.mockImplementationOnce(async (input) => { entered.resolve(); await release.promise; return await parsed(input); });
    service.start(); act('rebuild');
    await entered.promise;
    const closing = service.shutdown();
    release.resolve();
    await closing;
    service = new ResearchIndexService(repository, { parseDocument: parse, identity }, embeddings, cache, logger, watchFactory);
    service.start(); await idle();
    expect(files()[0]).toMatchObject({ status: 'ready', textIndexed: true });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(watches).toEqual([]);
  });

  it('retries embedding failures while retaining searchable text and a reusable parse', async () => {
    embeddings.saveConfig({ id: 'vectors', name: 'Vectors', baseUrl: 'https://embedding.test/v1', model: 'model', dimensions: 3, apiKey: 'sample-key', enabled: true });
    fetchEmbedding.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    service.start();
    await vi.waitFor(() => expect(service.status(projectId)).toMatchObject({ phase: 'failed', counts: { failed: 1 } }), { timeout: 5000 });
    const file = files()[0];
    expect(file).toMatchObject({ textIndexed: true, error: 'embedding_provider_http_503' });
    service.control({ projectId, action: 'retry', fileId: file.id, expectedRevision: repository.indexing.settings(projectId).revision });
    await idle();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetchEmbedding).toHaveBeenCalledTimes(2);
  });

  it('keeps watcher failures visible when they occur during a scan and recovers on rescan', async () => {
    await writeFile(join(workspace, 'paper.pdf'), '%PDF fixture');
    const entered = deferred<void>();
    const release = deferred<string>();
    identity.mockImplementationOnce(async () => { entered.resolve(); return await release.promise; });
    service.start();
    await entered.promise;
    watches.at(-1)?.error(new Error('watch failed'));
    release.resolve('test-toolchain');
    await vi.waitFor(() => expect(service.status(projectId)).toMatchObject({ phase: 'failed', error: 'research_index_watch_failed', counts: { ready: 1 } }), { timeout: 5000 });
    act('scan'); await idle();
    expect(watches.filter((watch) => !watch.closed)).toHaveLength(1);
  });

  it('does not retry a missing workspace indefinitely and respects scope changes', async () => {
    await rm(workspace, { recursive: true });
    service.start();
    await vi.waitFor(() => expect(service.status(projectId).phase).toBe('failed'), { timeout: 5000 });
    expect(repository.indexing.scope(projectId).scan_requested).toBe(0);
    await mkdir(workspace);
    await writeFile(join(workspace, 'first.md'), 'First scope');
    act('scan'); await idle();
    const second = join(directory, 'second');
    await mkdir(second);
    await writeFile(join(second, 'second.md'), 'Second scope');
    repository.updateProject({ id: projectId, workspacePath: second });
    service.projectChanged(projectId); await idle();
    expect(files().map((file) => file.path)).toEqual(['second.md']);
    expect(repository.indexing.listFiles(projectId, '', true, 100).find((file) => file.path === 'first.md')?.textIndexed).toBe(false);
  });

  it('reports a failed rescan instead of indexing when invalidated files have no runnable jobs', async () => {
    await writeFile(join(workspace, 'study.md'), 'Measured result: 42.');
    service.start(); await idle();
    await rm(workspace, { recursive: true });
    const { projectId: _id, revision, ...options } = repository.indexing.settings(projectId);
    service.configure({ ...options, projectId, expectedRevision: revision, exclude: [...options.exclude, '**/private/**'] });
    await vi.waitFor(() => expect(repository.indexing.scope(projectId)).toMatchObject({ phase: 'failed', scan_requested: 0 }));
    expect(repository.indexing.nextJob()).toBeNull();
    expect(service.status(projectId)).toMatchObject({ phase: 'failed', counts: { queued: 1, running: 0 } });
    await mkdir(workspace);
    await writeFile(join(workspace, 'study.md'), 'Measured result: 50.');
    act('scan'); await idle();
    expect(repository.knowledge.knowledgeChunks(knowledgeId(files()[0].id))[0].content).toContain('50');
  });
});
