import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import { ResearchFigureService } from '../../../../src/main/plugins/research/figure-service';
import { ResearchTemplateService } from '../../../../src/main/plugins/research/template-service';
import { ResearchExportSourceService } from '../../../../src/main/plugins/research/export-sources';
import { ResearchExportService } from '../../../../src/main/plugins/research/export-service';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { createResearchProductionJob } from '../../../../src/main/plugins/research/research-production-job';
import { type createExportArchive, type ExportToolchain } from '../../../../src/main/plugins/research/export-files';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import type { ResearchExportPrepare } from '../../../../src/shared/schemas/research-exports';
import { approveExportManuscript, crossrefLibraryEntries } from './export-test-helpers';
import { libraryEntry } from './library-fixtures';

let db: Database.Database;
let repository: ResearchRepository;
let service: ResearchExportService;
let gate: ReturnType<typeof createResearchHumanGate>;
let sources: ResearchExportSourceService;
let experiments: ResearchExperimentService;
let figures: ResearchFigureService;
let templates: ResearchTemplateService;
let root: string;
let workspace: string;
let projectId: string;
let manuscriptArtifactId: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const compile = vi.fn<ExportToolchain['compile']>();
const archive = vi.fn<typeof createExportArchive>();
const tools: ExportToolchain = {
  status: async () => ({ available: true, versions: { python: 'test-python', uv: 'test-uv', tectonic: 'test-tectonic' }, error: null }),
  identity: async () => 'a'.repeat(64), experimentRuntime: async () => { throw new Error('unexpected_python'); }, compile,
  writeBibliography: async () => ({ filename: 'references.bib', content: '@misc{fixture,title={Recorded measurements}}' }),
  renderPdf: async (input) => ({ path: 'page.png', page: 1, pageCount: 1, width: 100, height: 100, text: 'Measured improvement: 20%.', sourceHash: researchContentHash(await readFile(input.sourcePath)) })
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-export-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Export study', description: 'Traceable delivery.', workspacePath: workspace }).id;
  manuscriptArtifactId = await approveExportManuscript(repository, projectId);
  experiments = new ResearchExperimentService(repository, { inspect: async () => { throw new Error('unexpected_environment'); } }, join(root, 'runs'), logger);
  figures = new ResearchFigureService(repository, experiments, join(root, 'runs'), logger);
  templates = new ResearchTemplateService(repository, { compile, extractTemplate: async () => { throw new Error('unexpected_archive'); } });
  sources = new ResearchExportSourceService(repository, figures, experiments, templates);
  compile.mockReset().mockImplementation(async (input) => {
    await writeFile(join(input.outputDir, `${basename(input.entryPath, extname(input.entryPath))}.pdf`), '%PDF-export-fixture');
    return { exitCode: 0, stdout: 'compiled successfully', stderr: '' };
  });
  archive.mockReset().mockImplementation(async (input) => {
    await mkdir(join(input.root, 'archive'));
    const content = 'archive fixture';
    await writeFile(join(input.root, 'archive/export.zip'), content);
    return { path: 'archive/export.zip', sha256: researchContentHash(content), size: Buffer.byteLength(content) };
  });
  service = new ResearchExportService(repository, sources, tools, join(root, 'exports'), logger, archive);
  gate = createResearchHumanGate({
    repository,
    production: createResearchProductionJob({
      repository,
      experiments,
      figures,
      exports: service
    })
  });
});
afterEach(async () => { await Promise.all([service.shutdown(), figures.shutdown(), experiments.shutdown(), templates.shutdown()]); db.close(); await rm(root, { recursive: true, force: true }); });
function request(): ResearchExportPrepare { return { projectId, requestId: randomUUID(), title: 'Verified study', manuscriptArtifactId, figureIds: [], template: { kind: 'default', language: 'en' } }; }
async function prepared(input = request()) {
  const record = await service.prepare(input);
  await vi.waitFor(() => expect(repository.exports.get(input.projectId, record.id).status).not.toBe('preparing'), { timeout: 5000 });
  return repository.exports.get(input.projectId, record.id);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('final export lifecycle', () => {
  it('freezes sources, requires final approval and creates a new delivery without replacing an existing file', async () => {
    const input = request(); const record = await prepared(input);
    expect(record).toMatchObject({ status: 'ready', approval: 'unpublished', error: null });
    expect((await service.prepare(input)).id).toBe(record.id);
    expect(record.sources?.modelRuns).toHaveLength(4);
    expect(record.files.map((file) => file.path)).toEqual(expect.arrayContaining(['paper.pdf', 'references.bib', 'source/roc-manuscript.tex', 'provenance/sources.json', 'manifest.json']));
    const destinationPath = join(root, 'delivery.zip');
    await expect(service.write({ projectId, exportId: record.id, destinationPath })).rejects.toThrow('research_export_approval_required');
    const published = await service.publish(projectId, record.id, null);
    expect(published.approval).toBe('draft');
    expect(() => repository.updateArtifact({ id: published.artifactId!, path: '/other.pdf' })).toThrow('research_export_publication_immutable');
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'start' });
    await gate.complete({ projectId, expectedStage: 'export', action: 'complete' });
    expect(repository.exports.get(projectId, record.id).approval).toBe('draft');
    await gate.approve({ projectId, expectedStage: 'export', action: 'approve' });
    const delivered = await service.write({ projectId, exportId: record.id, destinationPath });
    expect(delivered.sha256).toBe(researchContentHash(await readFile(destinationPath)));
    await expect(service.write({ projectId, exportId: record.id, destinationPath })).rejects.toThrow('research_export_destination_exists');
    expect(await readFile(destinationPath, 'utf8')).toBe('archive fixture');
  });

  it('rejects changed requests and an unaccepted or different manuscript', async () => {
    const input = request(); const record = await prepared(input);
    await expect(service.prepare({ ...input, title: 'Different' })).rejects.toThrow('research_export_request_conflict');
    await expect(service.prepare({ ...request(), manuscriptArtifactId: 'different' })).rejects.toThrow('research_export_manuscript_changed');
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'move', targetStage: 'review' });
    await expect(service.publish(projectId, record.id, null)).rejects.toThrow('research_export_stage_inactive');
  });

  it('rejects modified bundle files and archives at publication and final approval', async () => {
    const record = await prepared();
    const bundle = join(repository.exports.root(projectId, record.id), 'bundle');
    const pdf = await readFile(join(bundle, 'paper.pdf'));
    await chmod(join(bundle, 'paper.pdf'), 0o600); await writeFile(join(bundle, 'paper.pdf'), '%PDF-modified');
    await expect(service.publish(projectId, record.id, null)).rejects.toThrow('research_export_snapshot_changed');
    await writeFile(join(bundle, 'paper.pdf'), pdf);
    await service.publish(projectId, record.id, null);
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'start' });
    await gate.complete({ projectId, expectedStage: 'export', action: 'complete' });
    await writeFile(join(repository.exports.root(projectId, record.id), 'archive/export.zip'), 'modified archive');
    await expect(gate.approve({ projectId, expectedStage: 'export', action: 'approve' })).rejects.toThrow('research_export_snapshot_changed');
    expect(repository.exports.get(projectId, record.id).approval).toBe('draft');
  });

  it('retains compile diagnostics and rejects a template without the required content and reference slots', async () => {
    compile.mockResolvedValueOnce({ exitCode: 1, stdout: 'before failure', stderr: '! Undefined control sequence.' });
    const failed = await prepared();
    expect(failed).toMatchObject({ status: 'failed', error: 'research_export_compile_failed' });
    expect((await service.read(projectId, failed.id, 'logs/compile-stderr.txt')).content).toContain('Undefined control sequence');
    const source = join(root, 'template'); await mkdir(source); await writeFile(join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}empty\\end{document}');
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    if (template.sourceDigest === null) throw new Error('template_digest_required');
    const missing = await prepared({ ...request(), template: { kind: 'imported', templateId: template.id, expectedRevision: template.revision, expectedSourceDigest: template.sourceDigest } });
    expect(missing).toMatchObject({ status: 'failed', error: 'research_export_template_slots_required' });
  });

  it('refuses a compiler success that reports ignored BibTeX errors', async () => {
    const compileNormally = compile.getMockImplementation()!;
    compile.mockImplementationOnce(async (input) => ({ ...await compileNormally(input),
      stderr: 'warning: errors were issued by BibTeX, but were ignored; use --print and/or --keep-logs for details.\n' }));
    const record = await prepared();
    expect(record).toMatchObject({ status: 'failed', error: 'research_export_bibliography_failed' });
    expect((await service.read(projectId, record.id, 'logs/compile-stderr.txt')).content).toContain('errors were issued by BibTeX');
  });

  it('requires all crossref parents and rejects cyclic reference inheritance before compilation', async () => {
    const other = repository.createProject({ title: 'Reference errors', description: '', workspacePath: join(root, 'other-reference-errors') });
    const [parent, child] = crossrefLibraryEntries();
    const childItem = repository.library.import([child], other.id).items[0];
    const evidence = repository.evidence.capture({ projectId: other.id, chunkId: `library:${childItem.id}:chunk:1` });
    const manuscript = await approveExportManuscript(repository, other.id, evidence.id);
    const input = { ...request(), projectId: other.id, manuscriptArtifactId: manuscript };
    expect(await prepared(input)).toMatchObject({ status: 'failed', error: 'research_library_citation_key_missing' });
    parent.bibliography.fields.crossref = 'study';
    repository.library.import([parent], other.id);
    expect(await prepared({ ...input, requestId: randomUUID() })).toMatchObject({ status: 'failed', error: 'research_export_reference_cycle' });
    expect(compile).not.toHaveBeenCalled();
  });

  it('includes parent versions and rejects a changed crossref parent after preparation', async () => {
    const other = repository.createProject({ title: 'Inherited metadata', description: '', workspacePath: join(root, 'other-inherited') });
    const [parent, child] = crossrefLibraryEntries();
    const [parentItem, childItem] = repository.library.import([parent, child], other.id).items;
    const evidence = repository.evidence.capture({ projectId: other.id, chunkId: `library:${childItem.id}:chunk:1` });
    const manuscript = await approveExportManuscript(repository, other.id, evidence.id);
    const record = await prepared({ ...request(), projectId: other.id, manuscriptArtifactId: manuscript });
    expect(record.sources?.bibliography.map((entry) => entry.citationKey)).toEqual(['study', 'conf']);
    expect(record.sources?.libraryRevisions).toContainEqual({ id: parentItem.id, revision: parentItem.revision });
    parent.bibliography.fields.publisher = 'Example Press';
    repository.library.import([parent], other.id);
    await expect(service.publish(other.id, record.id, null)).rejects.toThrow('research_export_sources_changed');
  });

  it('resolves project reference parents first and rejects ambiguous global citation keys', () => {
    const [parent] = crossrefLibraryEntries();
    const local = repository.library.import([parent], projectId).items[0];
    const duplicate = libraryEntry({ id: 'local:other-conf', source: 'local', externalId: 'other-conf', doi: null, title: 'Different conference' });
    duplicate.bibliography.citationKey = 'conf';
    repository.library.import([duplicate], null);
    expect(repository.library.resolveCitationKey(projectId, 'conf').id).toBe(local.id);
    repository.library.link(local.id, projectId, false);
    expect(() => repository.library.resolveCitationKey(projectId, 'conf')).toThrow('research_library_citation_key_ambiguous');
  });

  it('cancels a late preparation result, preserves logs and recovers interrupted work without rerunning', async () => {
    const entered = deferred(); const release = deferred(); const original = compile.getMockImplementation()!;
    compile.mockImplementationOnce(async (input) => { entered.resolve(); await release.promise; return await original(input); });
    const record = await service.prepare(request()); await entered.promise;
    const cancellation = service.cancel(projectId, record.id); release.resolve();
    expect(await cancellation).toMatchObject({ status: 'cancelled', artifactId: null });
    const pending = repository.exports.create(request(), join(root, 'exports'));
    service.recover();
    expect(repository.exports.get(projectId, pending.id)).toMatchObject({ status: 'interrupted', artifactId: null });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('rejects late source changes before a preparation becomes publishable', async () => {
    const original = archive.getMockImplementation()!;
    archive.mockImplementationOnce(async (input) => {
      const result = await original(input);
      repository.updateProject({ id: projectId, title: 'Changed during preparation' });
      return result;
    });
    expect(await prepared()).toMatchObject({ status: 'failed', error: 'research_export_sources_changed', artifactId: null });
    expect(repository.listArtifacts(projectId, 'export')).toEqual([]);
  });

  it('keeps another project update from cancelling the active export', async () => {
    const entered = deferred(); const release = deferred(); const original = compile.getMockImplementation()!;
    compile.mockImplementationOnce(async (input) => { entered.resolve(); await release.promise; return await original(input); });
    const pending = prepared(); await entered.promise;
    const other = repository.createProject({ title: 'Other', description: '', workspacePath: join(root, 'other-export-active') });
    service.projectChanged(other.id);
    release.resolve(); expect((await pending).status).toBe('ready');
  });

  it('maps library citation keys and rejects changed bibliography revisions after preparation', async () => {
    const other = repository.createProject({ title: 'Cited study', description: '', workspacePath: join(root, 'other-cited') });
    const paper = repository.library.import([libraryEntry({ abstract: 'Measured improvement: 20%.' })], other.id).items[0];
    const evidence = repository.evidence.capture({ projectId: other.id, chunkId: `library:${paper.id}:chunk:1` });
    const manuscript = await approveExportManuscript(repository, other.id, evidence.id);
    const record = await prepared({ ...request(), projectId: other.id, manuscriptArtifactId: manuscript });
    expect(record.status).toBe('ready');
    expect(record.sources?.citationKeys[evidence.id]).toBe('original');
    expect((await service.read(other.id, record.id, 'source/roc-manuscript.tex')).content).toContain('\\cite{original}');
    repository.library.setCitationKey(paper.id, paper.revision, 'changed-key');
    await expect(service.publish(other.id, record.id, null)).rejects.toThrow('research_export_sources_changed');
  });

  it('rejects cross-project access before creating a destination', async () => {
    const record = await prepared();
    const other = repository.createProject({ title: 'Other', description: '', workspacePath: join(root, 'other-export-mismatch') });
    expect(() => repository.exports.get(other.id, record.id)).toThrow('research_export_project_mismatch');
    await expect(service.write({ projectId: other.id, exportId: record.id, destinationPath: join(root, 'forbidden.zip') })).rejects.toThrow('research_export_project_mismatch');
    await expect(readFile(join(root, 'forbidden.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves v11 export metadata without inventing a prepared archive', () => {
    const old = new Database(':memory:');
    try {
      applyDatabaseMigrations(old, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((migration) => migration.version <= 11) });
      const legacy = new ResearchRepository(old);
      const project = legacy.createProject({ title: 'Legacy', description: '', workspacePath: '/tmp/export-service.test-1' });
      legacy.transitionWorkflow({ projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'export' });
      const artifact = legacy.createArtifact({ projectId: project.id, stage: 'export', kind: 'export_package', title: 'Legacy export', path: '/legacy/export.zip' });
      applyResearchDatabaseSchema(old); applyResearchDatabaseSchema(old);
      expect(legacy.exports.list(project.id, 10)).toEqual([]);
      expect(legacy.getArtifact(artifact.id)).toEqual(artifact);
    } finally { old.close(); }
  });

  it('replaces a rejected export while retaining its version and prevents a stale approval', async () => {
    const first = await prepared(); const second = await prepared();
    await service.publish(projectId, first.id, null);
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'start' });
    await gate.complete({ projectId, expectedStage: 'export', action: 'complete' });
    const entered = deferred(); const release = deferred(); const capture = sources.capture.bind(sources);
    vi.spyOn(sources, 'capture').mockImplementationOnce(async (...args) => { const result = await capture(...args); entered.resolve(); await release.promise; return result; });
    const approving = gate.approve({ projectId, expectedStage: 'export', action: 'approve' });
    const assertion = expect(approving).rejects.toThrow('research_export_review_changed');
    await entered.promise;
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'reject' });
    const replacement = await service.publish(projectId, second.id, first.id);
    await gate.complete({ projectId, expectedStage: 'export', action: 'complete' });
    release.resolve(); await assertion;
    expect(repository.exports.get(projectId, first.id).approval).toBe('superseded');
    expect(repository.getWorkflow(projectId).stages.find((stage) => stage.stage === 'export')?.artifactIds).toEqual([replacement.artifactId]);
    expect(repository.exports.get(projectId, second.id).approval).toBe('draft');
  });

  it('waits for a pending approval on shutdown and leaves the prepared version unapproved', async () => {
    const record = await prepared(); await service.publish(projectId, record.id, null);
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'start' });
    await gate.complete({ projectId, expectedStage: 'export', action: 'complete' });
    const entered = deferred(); const release = deferred(); const capture = sources.capture.bind(sources);
    vi.spyOn(sources, 'capture').mockImplementationOnce(async (...args) => { const value = await capture(...args); entered.resolve(); await release.promise; return value; });
    const approving = gate.approve({ projectId, expectedStage: 'export', action: 'approve' });
    const assertion = expect(approving).rejects.toThrow('research_export_closed');
    await entered.promise;
    let closed = false;
    const closing = service.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await closing; await assertion;
    expect(repository.exports.get(projectId, record.id).approval).toBe('draft');
  });

  it('rejects a bibliography change after the source capture but before approval commits', async () => {
    const other = repository.createProject({ title: 'Late citation change', description: '', workspacePath: join(root, 'other-late-citation') });
    const paper = repository.library.import([libraryEntry({ abstract: 'Measured improvement: 20%.' })], other.id).items[0];
    const evidence = repository.evidence.capture({ projectId: other.id, chunkId: `library:${paper.id}:chunk:1` });
    const manuscript = await approveExportManuscript(repository, other.id, evidence.id);
    const record = await prepared({ ...request(), projectId: other.id, manuscriptArtifactId: manuscript });
    await service.publish(other.id, record.id, null);
    repository.transitionWorkflow({ projectId: other.id, expectedStage: 'export', action: 'start' });
    await gate.complete({ projectId: other.id, expectedStage: 'export', action: 'complete' });
    const entered = deferred(); const release = deferred(); const capture = sources.capture.bind(sources);
    vi.spyOn(sources, 'capture').mockImplementationOnce(async (...args) => { const value = await capture(...args); entered.resolve(); await release.promise; return value; });
    const approving = gate.approve({ projectId: other.id, expectedStage: 'export', action: 'approve' });
    const assertion = expect(approving).rejects.toThrow('research_export_sources_changed');
    await entered.promise;
    repository.library.setCitationKey(paper.id, paper.revision, 'late-change');
    release.resolve(); await assertion;
    expect(repository.exports.get(other.id, record.id).approval).toBe('draft');
  });
});
