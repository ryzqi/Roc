import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {after, before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi, unknownExperiment} from './fixtures/research-test-kit.mjs';

const ts = path => importTypeScriptModule(`src/main/plugins/research/${path}.ts`, {
  platform: 'node', external: ['better-sqlite3', '@napi-rs/canvas', 'pino', 'onnxruntime-node'], tempDir: resolve('.runtime/deletion-tests')
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = path => assert.rejects(stat(path), {code: 'ENOENT'});
const date = '2026-11-27T00:00:00.000Z';
let api, LibraryDeletionRepository, LibraryDeletionService, PdfDownloadService, LiteratureAcquisitionRepository, LiteratureAcquisitionService;
before(async () => {
  [api, {LibraryDeletionRepository}, {LibraryDeletionService}, {PdfDownloadService}, {LiteratureAcquisitionRepository},
    {LiteratureAcquisitionService}] = await Promise.all([loadResearchTestApi(), ts('library-deletion-repository'),
    ts('library-deletion-service'), ts('pdf-download-service'), ts('literature-acquisition-repository'), ts('literature-acquisition-service')]);
});
after(() => api?.dispose());

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'roc-library-delete-'));
  const roots = {library: join(root, 'library'), resource: join(root, 'resources'), index: join(root, 'index')};
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace);
  const deletionRepository = new LibraryDeletionRepository(f.db, f.repository);
  const jobs = new LiteratureAcquisitionRepository(f.db);
  const acquisition = new LiteratureAcquisitionService(jobs);
  const changes = [];
  const service = (release = async () => {}) => new LibraryDeletionService(deletionRepository, acquisition, roots,
    event => changes.push(event), () => {}, release, async (_project, action) => action(), async () => {}, () => {});
  t.after(async () => {
    await acquisition.shutdown();
    await f.repository.wiki.shutdown();
    await f.close();
    await rm(root, {recursive: true, force: true});
  });
  const paper = (title, key) => {
    const metadata = {id: `local:${key}`, source: 'local', externalId: key, doi: null, title,
      authors: [], abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null, importedAt: date, updatedAt: date};
    const bibliography = {citationKey: key, entryType: 'article', fields: {title}, preambles: [], csl: null,
      title, authors: [], doi: null, publishedYear: 2026, abstract: null, url: null};
    return f.repository.library.import([{metadata, bibliography}], f.project.id).items[0];
  };
  return {...f, workspace, roots, paper, deletionRepository, acquisition, jobs, changes, service};
}

function index(f, id, sourceType, sourceId, content, projectId = null) {
  f.repository.knowledge.upsertFromSource({id, sourceType, sourceId, projectId, title: content,
    content, chunks: [{content, locator: 'page:1'}], embeddingPolicy: 'none'});
  f.repository.knowledgeJobs.enqueue(id);
  return f.repository.evidence.capture({projectId: f.project.id, chunkId: `${id}:chunk:0`});
}

async function file(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, value);
}

function addDocument(f, paper) {
  const id = 'document_fixture';
  const sourcePath = `documents/${id}/source.pdf`;
  f.repository.documents.import({id, libraryItemId: paper.id, entry: null, projectId: f.project.id,
    filename: 'source.pdf', mediaType: 'application/pdf', sourcePath, sourceHash: sha('input'), size: 5}, false);
  f.repository.documents.begin(id, 'parse_fixture');
  return {id, sourcePath, ir: `paper-ir/${sha(`${id}\nparse_fixture`)}/parse.json`};
}

test('purges library records, indexes, evidence and Wiki history while preserving a second paper', async t => {
  const f = await fixture(t);
  const paper = f.paper('Removal fixture', 'removed');
  const remaining = f.paper('Independent fixture', 'independent');
  const document = addDocument(f, paper);
  const text = 'removalonlyphrase';
  f.repository.documents.complete(document.id, 'parse_fixture', {
    outputPath: `documents/${document.id}/runs/parse_fixture/output`, files: {},
    content: {contractVersion: 6, engine: 'paddleocr.js', engineVersion: 'deletion-test',
      parserVersion: 'roc-research-parser/2', parserFingerprint: sha('parser'), sourceHash: sha('input'),
      modelManifest: '', runtime: {node: 'synthetic'}, tier: 'compact', parseMode: 'native-text', device: 'cpu',
      pageCount: 1, content: text, blocks: [{id: 'body', kind: 'paragraph', label: 'Body', text, locator: 'page:1',
        imageAssetId: null, locations: [{page: 1, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]}], assets: [],
      artifacts: {middleJson: 'middle.json', markdown: 'document.md', structuredContent: 'structured.json'}, warnings: []}
  }, null);
  const source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:parse_fixture:chunk:0'});
  const other = index(f, `library:${remaining.id}`, 'literature', remaining.id, 'independentphrase');
  const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading',
    kind: 'reading_notes', title: 'Independent draft', path: null});
  const claim = f.repository.evidence.createClaim({experiment: unknownExperiment, projectId: f.project.id,
    artifactId: artifact.id, subjectType: 'claim', content: 'Check evidence before publishing.',
    status: 'supported', evidenceIds: [source.id, other.id]});
  const wiki = f.repository.wiki;
  const topic = wiki.create({projectId: f.project.id, kind: 'topic', title: 'Mixed sources',
    evidenceIds: [source.id, other.id], claimIds: [claim.id]});
  await wiki.idle();

  await file(join(f.roots.library, document.sourcePath), 'input');
  await file(join(f.roots.library, document.ir), 'old parse');
  const original = join(f.workspace, 'user-original.pdf');
  await file(original, 'user-owned');

  const deletion = f.service();
  await assert.rejects(deletion.delete(paper.id, paper.revision + 1), /research_library_version_conflict/);
  assert.equal(f.repository.library.get(paper.id).id, paper.id);
  assert.deepEqual(await deletion.delete(paper.id, paper.revision), {cleanupPending: false, preservedFiles: 0});
  assert.deepEqual(f.changes, [{id: paper.id, projectIds: [f.project.id]}]);
  assert.throws(() => f.repository.library.get(paper.id), /not_found/);
  assert.throws(() => f.repository.documents.get(document.id), /not_found/);
  assert.equal(f.repository.library.get(remaining.id).id, remaining.id);
  const revised = f.repository.evidence.getClaim(claim.id);
  assert.deepEqual(revised.evidenceIds, [other.id]);
  assert.equal(revised.status, 'pending');
  assert.deepEqual(f.repository.evidence.claimHistory(claim.id).map(claim => claim.evidenceIds), [[other.id], [other.id]]);
  assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_chunks_fts WHERE research_knowledge_chunks_fts MATCH 'removalonlyphrase'").pluck().get(), 0);
  assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'independentphrase'").pluck().get(), 1);
  await wiki.idle();
  assert.deepEqual((await wiki.search(f.project.id, 'removalonlyphrase')).pages, []);
  assert.deepEqual(wiki.read(f.project.id, topic.page.id).sources.map(source => source.evidenceId), [other.id]);
  assert.ok(!JSON.stringify(wiki.revision(f.project.id, topic.page.id, 1)).includes(source.id));
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  await absent(join(f.roots.library, document.sourcePath));
  await absent(join(f.roots.library, document.ir));
  assert.equal(await readFile(original, 'utf8'), 'user-owned');
  assert.deepEqual(await deletion.delete(paper.id, paper.revision), {cleanupPending: false, preservedFiles: 0});
  await deletion.shutdown();
});

test('resumes a committed deletion and removes the managed workspace copy, project index and cache', async t => {
  const f = await fixture(t);
  const paper = f.paper('Published fixture', 'published');
  const document = addDocument(f, paper);
  await file(join(f.roots.library, document.sourcePath), 'input');
  f.db.transaction(() => f.jobs.enqueue(f.project.id, paper.id))();
  const job = f.jobs.claim();
  const downloader = new PdfDownloadService(f.roots.resource);
  await downloader.initialize();
  const bytes = Buffer.from(`%PDF-1.4\n${'x'.repeat(100)}\n%%EOF\n`);
  const input = {jobId: job.id, generation: job.generation, libraryItemId: paper.id, title: paper.metadata.title,
    year: 2026, workspacePath: f.workspace, bytes, signal: new AbortController().signal,
    requireCurrent: () => f.jobs.requireCurrent(job), notifyWorkspaceChanged: () => {},
    recordPublication: publication => f.deletionRepository.recordPublication(job, publication)};
  const pdf = await downloader.publishExisting(input);
  f.jobs.complete(job, {stage: 'import', status: 'queued', receipt: pdf.receipt});

  const projectFile = 'indexed-copy';
  const cachedPath = `sources/${f.project.id}/${pdf.sha256}/source.pdf`;
  await file(join(f.roots.index, cachedPath), bytes);
  // A real index scan binds its canonical root before publishing indexed files.
  f.repository.indexing.bindRoot(f.project.id, await realpath(f.workspace));
  f.db.prepare(`INSERT INTO research_index_files
    (id,project_id,path,kind,size,signature,status,indexed_chunks,embedding_key,force_needed,updated_at)
    VALUES (?,?,?,'pdf',?,'sig','ready',1,'none',0,?)`).run(projectFile, f.project.id, pdf.relativePath, bytes.length, date);
  f.db.prepare(`INSERT INTO research_index_sources(file_id,source_hash,cache_path,size,kind,created_at) VALUES (?,?,?,?,'pdf',?)`)
    .run(projectFile, pdf.sha256, cachedPath, bytes.length, date);
  const knowledgeId = `project-index:${projectFile}`;
  index(f, knowledgeId, 'file', pdf.relativePath, 'workspacecopyphrase', f.project.id);

  const interrupted = f.service(async () => {throw new Error('worker_cleanup_interrupted');});
  assert.deepEqual(await interrupted.delete(paper.id, paper.revision), {cleanupPending: true, preservedFiles: 0});
  assert.equal(f.deletionRepository.pendingIds()[0], paper.id);
  assert.deepEqual(await readFile(join(f.workspace, pdf.relativePath)), bytes);
  await interrupted.shutdown();

  const recovered = f.service();
  recovered.start();
  assert.deepEqual(await recovered.delete(paper.id, paper.revision), {cleanupPending: false, preservedFiles: 0});
  assert.deepEqual(f.deletionRepository.pendingIds(), []);
  await absent(join(f.workspace, pdf.relativePath));
  await absent(join(f.roots.index, cachedPath));
  assert.equal(f.db.prepare('SELECT 1 FROM research_knowledge_documents WHERE id=?').get(knowledgeId), undefined);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  await recovered.shutdown();
});

test('a download that reused an identical pre-existing PDF does not acquire deletion ownership', async t => {
  const f = await fixture(t);
  const paper = f.paper('Reused fixture', 'reused');
  f.db.transaction(() => f.jobs.enqueue(f.project.id, paper.id))();
  const job = f.jobs.claim();
  const downloader = new PdfDownloadService(f.roots.resource);
  await downloader.initialize();
  const bytes = Buffer.from(`%PDF-1.4\n${'x'.repeat(100)}\n%%EOF\n`);
  const input = {jobId: job.id, generation: job.generation, libraryItemId: paper.id, title: paper.metadata.title,
    year: 2026, workspacePath: f.workspace, bytes, signal: new AbortController().signal,
    requireCurrent: () => f.jobs.requireCurrent(job), notifyWorkspaceChanged: () => {}};
  const relativePath = `papers/2026/reused-fixture--${sha(paper.id).slice(0, 12)}.pdf`;
  const source = join(f.workspace, relativePath);
  await file(source, bytes);
  const pdf = await downloader.publishExisting({...input, recordPublication: publication => f.deletionRepository.recordPublication(job, publication)});
  assert.equal(pdf.created, false);
  f.jobs.complete(job, {stage: 'import', status: 'queued', receipt: pdf.receipt});
  const deletion = f.service();
  assert.deepEqual(await deletion.delete(paper.id, paper.revision), {cleanupPending: false, preservedFiles: 1});
  assert.deepEqual(await readFile(source), bytes);
  await deletion.shutdown();
});

test('deletion is accepted only from a validated human IPC sender', async t => {
  const f = await fixture(t);
  const paper = f.paper('IPC fixture', 'ipc');
  const deletion = f.service();
  const registry = new api.CapabilityRegistry();
  const capability = api.researchLibraryCapabilities.find(capability => capability.name === 'research.library.delete');
  registry.declare('research', capability);
  api.registerResearchLibraryDeletion({pluginId: 'research', capabilities: registry}, deletion);
  const run = input => registry.invoke(capability.name, input);
  const adapter = api.createPluginCapabilityAdapter({invokeCapability: (_name, input) => run(input)});
  const input = {id: paper.id, expectedRevision: paper.revision};

  await assert.rejects(run(input), /research_human_required/);
  const missingWindow = await adapter.invoke('research.deleteLibraryItem', [input]);
  assert.equal(missingWindow.ok, false);
  assert.equal(missingWindow.error.code, 'research_sender_required');
  assert.equal(f.repository.library.get(paper.id).id, paper.id);
  const result = await adapter.invoke('research.deleteLibraryItem', [input], 7);
  assert.deepEqual(result, {ok: true, data: {cleanupPending: false, preservedFiles: 0}});
  assert.throws(() => f.repository.library.get(paper.id), /not_found/);
  await deletion.shutdown();
});

test('a running acquisition exits before deletion completes and cannot publish an old generation', async t => {
  const f = await fixture(t);
  const paper = f.paper('In-flight fixture', 'inflight');
  f.db.transaction(() => f.jobs.enqueue(f.project.id, paper.id))();
  const started = Promise.withResolvers();
  let ended = false;
  f.acquisition.start(async (job, signal, requireCurrent) => {
    started.resolve(job);
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    ended = true;
    assert.throws(requireCurrent);
    return {status: 'queued'};
  });
  const gate = setTimeout(() => started.reject(new Error('acquisition did not start')), 3000);
  const job = await started.promise.finally(() => clearTimeout(gate));
  const deletion = f.service();
  assert.deepEqual(await deletion.delete(paper.id, paper.revision), {cleanupPending: false, preservedFiles: 0});
  assert.equal(ended, true);
  assert.throws(() => f.jobs.requireCurrent(job), /changed/);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_paper_acquisition_jobs').pluck().get(), 0);
  await deletion.shutdown();
});
