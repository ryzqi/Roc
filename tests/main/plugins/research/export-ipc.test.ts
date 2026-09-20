import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';
import { researchProjectSchema, researchTemplateSchema, researchWorkflowSnapshotSchema } from '../../../../src/shared/schemas/research';
import { researchExperimentEnvironmentSchema, researchExperimentExecutionSchema } from '../../../../src/shared/schemas/research-experiments';
import { researchExportDeliverySchema, researchExportExecutionSchema, type ResearchExportPrepare } from '../../../../src/shared/schemas/research-exports';
import { researchFigurePublicationSchema } from '../../../../src/shared/schemas/research-figures';
import { researchProductionInputContentSchema, researchProductionInputSchema } from '../../../../src/shared/schemas/research-production-inputs';
import { approveExportManuscript, crossrefLibraryEntries } from './export-test-helpers';
import { libraryEntry } from './library-fixtures';

const toolchain = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;
const execute = promisify(execFile);
let db: Database.Database;
let repository: ResearchRepository;
let root: string;
let workspace: string;
let projectId: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let capabilities: CapabilityRegistry;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let failure: unknown;

beforeEach(async () => {
  if (artifacts !== undefined) { if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute'); await mkdir(artifacts, { recursive: true }); }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc export integration-')));
  workspace = join(root, 'workspace'); await mkdir(workspace);
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  plugin = createResearchPlugin({ experimentRoot: join(root, 'runs'), exportRoot: join(root, 'exports'), toolchainRoot: toolchain });
  capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({ pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    config: { get: () => null, set: () => {} }, secrets: { get: () => null, set: () => {}, clear: () => {} },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  adapter = createPluginCapabilityAdapter({ invokeCapability: async <TInput, TOutput>(name: string, input: TInput) => {
    try { return await capabilities.invoke<TInput, TOutput>(name, input); }
    catch (error) { failure = error; throw error; }
  } });
  projectId = (await call('createProject', { title: 'Export integration', description: 'Approved PDF, bibliography and figures.', workspacePath: workspace }, researchProjectSchema)).id;
});
afterEach(async () => { await plugin.shutdown(); db.close(); if (artifacts === undefined) await rm(root, { recursive: true, force: true }); });
async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  failure = undefined;
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: failure });
  return schema.parse(result.data);
}
async function prepare(request: Omit<ResearchExportPrepare, 'projectId' | 'requestId'>) {
  let record = await call('prepareExport', { ...request, projectId, requestId: randomUUID() }, researchExportExecutionSchema);
  await vi.waitFor(async () => {
    record = await call('getExport', { projectId, exportId: record.id }, researchExportExecutionSchema);
    expect(record.status).not.toBe('preparing');
  }, { timeout: 240000, interval: 100 });
  await writeFile(join(root, `${record.id}-result.json`), JSON.stringify(record, null, 2));
  return record;
}
async function pdfText(exportId: string) {
  const job = join(root, `pdf-check-${randomUUID()}`); await mkdir(job);
  const result = await new ResearchToolchain(toolchain ?? null).renderPdf({ projectRoot: root, sourcePath: join(root, 'exports', exportId, 'bundle/paper.pdf'),
    outputDir: join(job, 'preview'), jobDir: job, page: 1, scale: 1 });
  await writeFile(join(job, 'result.json'), JSON.stringify(result, null, 2));
  return result.text;
}

async function approvedFigure() {
  await writeFile(join(workspace, 'data.csv'), 'improvement\n20\n');
  await writeFile(join(workspace, 'plot.py'), `import json, os
from pathlib import Path
import matplotlib.pyplot as plt
value = float(Path('data.csv').read_text().splitlines()[1])
figure, axes = plt.subplots(layout='constrained')
axes.bar(['Measured'], [value])
axes.set_ylabel('Improvement (%)')
Path(os.environ['ROC_OUTPUT_DIR'], 'measurements.json').write_text(json.dumps({'improvement': value}), encoding='utf-8')
`);
  const runtime = { kind: 'bundled-python' };
  const environment = await call('inspectFigureEnvironment', { projectId, runtime }, researchExperimentEnvironmentSchema);
  let run = await call('startFigure', { projectId, requestId: randomUUID(), label: 'Measured improvement', runtime, sourcePath: 'plot.py',
    inputPaths: ['data.csv'], arguments: [], parameters: {}, expectedEnvironmentHash: environment.hash, timeoutMs: 30000,
    figure: { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 } }, researchExperimentExecutionSchema);
  await vi.waitFor(async () => { run = await call('getFigureRun', { projectId, runId: run.id }, researchExperimentExecutionSchema); expect(['preparing', 'running']).not.toContain(run.status); }, { timeout: 45000, interval: 100 });
  expect(run.status).toBe('completed');
  const evidence = repository.evidence.capture({ projectId, chunkId: `experiment:${run.id}:output:measurements.json:chunk:0` });
  repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'figure' });
  const figure = await call('publishFigure', { projectId, runId: run.id, replacesFigureId: null }, researchFigurePublicationSchema);
  repository.evidence.createClaim({ projectId, artifactId: figure.artifactId, subjectType: 'figure', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
  repository.transitionWorkflow({ projectId, expectedStage: 'figure', action: 'start' });
  await call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'complete' }, researchWorkflowSnapshotSchema);
  await call('transitionWorkflow', { projectId, expectedStage: 'figure', action: 'approve' }, researchWorkflowSnapshotSchema);
  return { figure, evidence, run };
}

describe.skipIf(toolchain === undefined)('actual final export IPC and bundled tools', () => {
  it('builds and approves a Chinese PDF with real figures and saves a verifiable ZIP', async () => {
    if (toolchain === undefined) throw new Error('toolchain_required');
    const { figure, evidence, run } = await approvedFigure();
    const manuscriptArtifactId = await approveExportManuscript(repository, projectId, evidence.id);
    const record = await prepare({ title: '实验结果报告', manuscriptArtifactId, figureIds: [figure.id], template: { kind: 'default', language: 'zh' } });
    expect(record).toMatchObject({ status: 'ready', error: null, approval: 'unpublished' });
    const text = await pdfText(record.id);
    expect(text).toContain('20%'); expect(text).toContain('实验结果报告'); expect(text).not.toContain('[?]');
    const pdf = record.files.find((file) => file.path === 'paper.pdf')!;
    const response = await capabilities.invoke<unknown, Response>('research.export.source', { projectId, exportId: record.id, sha256: pdf.sha256 });
    expect(researchContentHash(Buffer.from(await response.arrayBuffer()))).toBe(pdf.sha256);
    const published = await call('publishExport', { projectId, exportId: record.id, replacesExportId: null }, researchExportExecutionSchema);
    await expect(call('inspectProductionInput', { projectId, artifactId: published.artifactId }, researchProductionInputSchema))
      .rejects.toMatchObject({ cause: { message: 'research_production_approval_required' } });
    const destinationPath = join(root, 'study.zip');
    await expect(call('writeExport', { projectId, exportId: record.id, destinationPath }, researchExportDeliverySchema)).rejects.toMatchObject({ cause: { message: 'research_export_approval_required' } });
    repository.transitionWorkflow({ projectId, expectedStage: 'export', action: 'start' });
    await call('transitionWorkflow', { projectId, expectedStage: 'export', action: 'complete' }, researchWorkflowSnapshotSchema);
    await call('transitionWorkflow', { projectId, expectedStage: 'export', action: 'approve' }, researchWorkflowSnapshotSchema);
    const input = await call('inspectProductionInput', { projectId, artifactId: published.artifactId }, researchProductionInputSchema);
    expect(input.source).toMatchObject({ kind: 'export', execution: { id: record.id, approval: 'approved' } });
    const manuscript = await call('readProductionInputFile', { projectId, artifactId: published.artifactId, area: 'bundle', path: 'source/roc-manuscript.tex' }, researchProductionInputContentSchema);
    expect(manuscript.encoding).toBe('utf8'); expect(manuscript.content).toContain('20\\%');
    expect(input.files).toContainEqual(manuscript.file);
    const data = await call('readProductionInputFile', { projectId, artifactId: published.artifactId, area: 'bundle', path: `provenance/experiments/${run.id}/input/data.csv` }, researchProductionInputContentSchema);
    expect(data.content).toBe('improvement\n20\n');
    const delivery = await call('writeExport', { projectId, exportId: record.id, destinationPath }, researchExportDeliverySchema);
    const result = await execute(join(toolchain, 'python/bin/python3'), ['-I', '-B', '-c', `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest=json.loads(archive.read('manifest.json'))
    assert set(archive.namelist()) == {entry['path'] for entry in manifest['files']} | {'manifest.json'}
    for entry in manifest['files']:
        content=archive.read(entry['path'])
        assert len(content)==entry['size'] and hashlib.sha256(content).hexdigest()==entry['sha256']
    assert archive.testzip() is None
    print(json.dumps({'files':archive.namelist(),'toolchainVersions':manifest['toolchainVersions']}))
`, destinationPath], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const contents = JSON.parse(result.stdout) as { files: string[]; toolchainVersions: { python: string } };
    expect(contents.files).toContain(`source/figures/${figure.id}.svg`);
    expect(contents.files).toContain(`provenance/experiments/${run.id}/input/data.csv`);
    expect(contents.toolchainVersions.python).toBe('3.12.14');
    expect(delivery.sha256).toBe(researchContentHash(await readFile(destinationPath)));
    await writeFile(join(root, 'delivery-result.json'), JSON.stringify({ delivery, contents }, null, 2));
  }, 300000);

  it('uses an imported template while preserving its original placeholders and source hashes', async () => {
    const paper = repository.library.import([libraryEntry({ abstract: 'Measured improvement: 20%.' }, { journal: 'Example Journal' })], projectId).items[0];
    const evidence = repository.evidence.capture({ projectId, chunkId: `library:${paper.id}:chunk:1` });
    const manuscriptArtifactId = await approveExportManuscript(repository, projectId, evidence.id);
    const source = join(root, 'custom-template'); await mkdir(source);
    await writeFile(join(source, 'main.tex'), '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nCustom template\n\\input{roc-manuscript.tex}\n\\bibliographystyle{plain}\n\\bibliography{roc-references}\n\\end{document}\n');
    await writeFile(join(source, 'roc-manuscript.tex'), 'Original placeholder');
    await writeFile(join(source, 'roc-references.bib'), '% Original bibliography placeholder');
    const template = researchTemplateSchema.parse(await capabilities.invoke('research.template.import', { projectId, sourcePath: source }));
    if (template.sourceDigest === null) throw new Error('template_digest_required');
    const record = await prepare({ title: 'Custom delivery', manuscriptArtifactId, figureIds: [], template: { kind: 'imported', templateId: template.id, expectedRevision: template.revision, expectedSourceDigest: template.sourceDigest } });
    expect(record).toMatchObject({ status: 'ready', error: null });
    const text = await pdfText(record.id);
    expect(text).toContain('Custom template'); expect(text).toContain('20%'); expect(text).not.toContain('Original placeholder'); expect(text).not.toContain('[?]');
    expect(text).toContain('Doe'); expect(text).toContain('2026');
    expect(await readFile(join(root, 'exports', record.id, 'bundle/source/roc-manuscript.tex'), 'utf8')).toContain('\\cite{original}');
    expect(await readFile(join(template.rootPath, 'roc-manuscript.tex'), 'utf8')).toBe('Original placeholder');
    expect(await readFile(join(root, 'exports', record.id, 'bundle/provenance/template/roc-manuscript.tex'), 'utf8')).toBe('Original placeholder');
  }, 240000);

  it('injects approved text, bibliography and figures beside a nested template entry', async () => {
    const { figure, evidence } = await approvedFigure();
    const manuscriptArtifactId = await approveExportManuscript(repository, projectId, evidence.id);
    const source = join(root, 'nested-template'); await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'nested/main.tex'), '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nNested template\n\\input{roc-manuscript.tex}\n\\bibliographystyle{plain}\n\\bibliography{roc-references}\n\\end{document}\n');
    await writeFile(join(source, 'nested/roc-manuscript.tex'), 'ORIGINAL UNAPPROVED PLACEHOLDER\\cite{old}');
    await writeFile(join(source, 'nested/roc-references.bib'), '@misc{old,title={Old bibliography}}');
    const template = researchTemplateSchema.parse(await capabilities.invoke('research.template.import', { projectId, sourcePath: source }));
    if (template.sourceDigest === null) throw new Error('template_digest_required');
    expect(template.entryPath).toBe('nested/main.tex');
    const record = await prepare({ title: 'Nested delivery', manuscriptArtifactId, figureIds: [figure.id], template: { kind: 'imported', templateId: template.id, expectedRevision: template.revision, expectedSourceDigest: template.sourceDigest } });
    expect(record).toMatchObject({ status: 'ready', error: null });
    const text = await pdfText(record.id);
    expect(text).not.toContain('ORIGINAL UNAPPROVED PLACEHOLDER');
    expect(text).toContain('20%'); expect(text).toContain('Improvement (%)'); expect(text).not.toContain('[?]');
    const bundle = join(root, 'exports', record.id, 'bundle');
    expect(await readFile(join(bundle, 'provenance/template/nested/roc-manuscript.tex'), 'utf8')).toContain('ORIGINAL UNAPPROVED PLACEHOLDER');
    expect(record.files.map((file) => file.path)).toContain(`source/nested/figures/${figure.id}.pdf`);
  }, 240000);

  it('preserves inherited crossref bibliography fields and records the parent revision', async () => {
    const [parent, child] = crossrefLibraryEntries();
    const [parentItem, childItem] = repository.library.import([parent, child], projectId).items;
    const evidence = repository.evidence.capture({ projectId, chunkId: `library:${childItem.id}:chunk:1` });
    const manuscriptArtifactId = await approveExportManuscript(repository, projectId, evidence.id);
    const record = await prepare({ title: 'Crossref delivery', manuscriptArtifactId, figureIds: [], template: { kind: 'default', language: 'en' } });
    expect(record).toMatchObject({ status: 'ready', error: null });
    const text = await pdfText(record.id);
    expect(text).toContain('Methods Conference'); expect(text).toContain('Editor'); expect(text).toContain('2026');
    expect(record.sources?.libraryRevisions).toContainEqual({ id: parentItem.id, revision: parentItem.revision });
    const bibliography = await readFile(join(root, 'exports', record.id, 'bundle/references.bib'), 'utf8');
    expect(bibliography.indexOf('study')).toBeLessThan(bibliography.indexOf('@proceedings'));
  }, 240000);
});
