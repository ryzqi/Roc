import Database from 'better-sqlite3';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { researchEvidenceSchema } from '../../../../src/shared/schemas/research-evidence';
import { researchKnowledgeSearchResultSchema, researchProjectSchema, researchTemplateSchema } from '../../../../src/shared/schemas/research';
import { researchIndexedFileSchema, researchIndexedSourceSchema, researchIndexJobSchema, researchIndexStatusSchema } from '../../../../src/shared/schemas/research-index';
import { researchIndexedSourceUrl } from '../../../../src/shared/research-preview';

let db: Database.Database;
let root: string;
let workspace: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let capabilities: CapabilityRegistry;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let failure: unknown;
const toolchainRoot = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;

beforeEach(async () => {
  if (artifacts !== undefined) {
    if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute');
    await mkdir(artifacts, { recursive: true });
  }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc project index integration-')));
  workspace = join(root, 'workspace');
  await mkdir(workspace);
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin({
    indexRoot: join(root, 'index'),
    libraryRoot: join(root, 'library'),
    toolchainRoot,
    modelsRoot: process.env.ROC_RESEARCH_MODELS ?? (toolchainRoot === undefined ? undefined : join(toolchainRoot, 'models'))
  });
  capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({ pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    config: { get: () => null, set: () => {} }, secrets: { get: () => null, set: () => {}, clear: () => {} },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  adapter = createPluginCapabilityAdapter({ invokeCapability: async <TInput, TOutput>(name: string, input: TInput) => {
    try { return await capabilities.invoke<TInput, TOutput>(name, input); }
    catch (error) { failure = error; throw error; }
  } });
});
afterEach(async () => {
  await plugin.shutdown();
  db.close();
  if (artifacts === undefined) await rm(root, { recursive: true, force: true });
});

async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  failure = undefined;
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: failure });
  return schema.parse(result.data);
}
async function status(projectId: string) { return await call('getIndexStatus', { projectId }, researchIndexStatusSchema); }
async function files(projectId: string) { return await call('listIndexedFiles', { projectId, query: '', includeMissing: false, limit: 100 }, researchIndexedFileSchema.array()); }

describe('project index IPC and filesystem integration', () => {
  it('observes actual file changes and keeps evidence sources through pause, resume and deletion', async () => {
    await writeFile(join(workspace, 'note.md'), 'Measured result: 42 units.');
    await writeFile(join(workspace, 'data.csv'), 'Group,Value\nControl,41\n');
    const project = await call('createProject', { title: 'Filesystem study', description: 'Actual filesystem watcher.', workspacePath: workspace }, researchProjectSchema);
    await vi.waitFor(async () => expect(await status(project.id)).toMatchObject({ phase: 'idle', counts: { ready: 2 } }), { timeout: 10000 });
    const initial = await files(project.id);
    const note = initial.find((file) => file.path === 'note.md');
    if (note === undefined) throw new Error('note_required');
    const search = await call('searchKnowledge', { projectId: project.id, query: 'Measured', limit: 10, embeddingConfigId: null }, researchKnowledgeSearchResultSchema);
    const evidence = await call('captureEvidence', { projectId: project.id, chunkId: search.hits[0].chunkId }, researchEvidenceSchema);
    const origin = await call('getEvidenceIndexSource', { projectId: project.id, evidenceId: evidence.id }, researchIndexedSourceSchema.nullable());
    if (origin === null) throw new Error('source_required');
    await writeFile(join(workspace, 'note.md'), 'Measured result: 55 units.');
    await vi.waitFor(async () => expect((await files(project.id)).find((file) => file.id === note.id)).toMatchObject({ status: 'ready', sourceHash: researchContentHash('Measured result: 55 units.') }), { timeout: 10000 });
    const beforePause = await status(project.id);
    const paused = await call('controlIndex', { projectId: project.id, action: 'pause', expectedRevision: beforePause.settings.revision }, researchIndexStatusSchema);
    expect(paused.phase).toBe('paused');
    await writeFile(join(workspace, 'note.md'), 'Measured result: 56 units.');
    expect((await files(project.id)).find((file) => file.id === note.id)?.sourceHash).toBe(researchContentHash('Measured result: 55 units.'));
    await call('controlIndex', { projectId: project.id, action: 'resume', expectedRevision: paused.settings.revision }, researchIndexStatusSchema);
    await vi.waitFor(async () => expect((await files(project.id)).find((file) => file.id === note.id)).toMatchObject({ status: 'ready', sourceHash: researchContentHash('Measured result: 56 units.') }), { timeout: 10000 });
    await rm(join(workspace, 'note.md'));
    await vi.waitFor(async () => expect((await files(project.id)).map((file) => file.path)).toEqual(['data.csv']), { timeout: 10000 });
    const resource = await capabilities.invoke<unknown, Response>('research.index.source', { projectId: origin.projectId, fileId: origin.fileId, sourceHash: origin.sourceHash });
    expect(resource.headers.get('content-type')).toBe('application/octet-stream');
    expect(resource.headers.get('content-disposition')).toContain('attachment');
    expect(await resource.text()).toBe('Measured result: 42 units.');
    expect(researchIndexedSourceUrl(origin)).toContain(origin.sourceHash);
    const jobs = await call('listIndexJobs', { projectId: project.id, limit: 100 }, researchIndexJobSchema.array());
    expect(jobs.some((job) => job.status === 'ready')).toBe(true);
    const { projectId: _id, revision, ...options } = (await status(project.id)).settings;
    await call('saveIndexSettings', { ...options, projectId: project.id, expectedRevision: revision, exclude: [...options.exclude, '**/*.csv'] }, researchIndexStatusSchema);
    await vi.waitFor(async () => expect(await files(project.id)).toEqual([]), { timeout: 10000 });
    expect((await adapter.invoke('research.saveIndexSettings', [{ ...options, projectId: project.id, expectedRevision: revision }]))).toMatchObject({ ok: false, error: { code: 'research_index_settings_changed' } });
    const other = await call('createProject', { title: 'Other project', description: 'Isolation.', workspacePath: '/tmp/index-ipc.test-1' }, researchProjectSchema);
    await expect(capabilities.invoke('research.index.source', { projectId: other.id, fileId: origin.fileId, sourceHash: origin.sourceHash })).rejects.toThrow('research_index_project_mismatch');
    if (artifacts !== undefined) await writeFile(join(root, 'filesystem-result.json'), JSON.stringify({ project, initial, evidence, origin, jobs }, null, 2));
  });

  it.skipIf(toolchainRoot === undefined)('indexes a real PDF via the bundled parser and preserves its original snapshot', async () => {
    const project = await call('createProject', { title: 'PDF index', description: 'Actual parser and index worker.', workspacePath: workspace }, researchProjectSchema);
    const templateRoot = join(root, 'template');
    await mkdir(templateRoot);
    await writeFile(join(templateRoot, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nReference signal measured at 42 units.\\par Source data are preserved.\n\\end{document}\n');
    const template = await call('importTemplate', { projectId: project.id, sourcePath: templateRoot }, researchTemplateSchema);
    const compiled = await call('compileTemplate', { projectId: project.id, templateId: template.id }, researchTemplateSchema);
    expect(compiled.status).toBe('ready');
    if (compiled.pdfPath === null) throw new Error('pdf_required');
    await copyFile(compiled.pdfPath, join(workspace, 'paper.pdf'));
    await vi.waitFor(async () => expect((await files(project.id)).find((file) => file.path === 'paper.pdf')).toMatchObject({ status: 'ready', textIndexed: true }), { timeout: 240000, interval: 500 });
    const search = await call('searchKnowledge', { projectId: project.id, query: 'Reference signal', limit: 10, embeddingConfigId: null }, researchKnowledgeSearchResultSchema);
    const hit = search.hits.find((item) => item.content.includes('42'));
    if (hit === undefined) throw new Error('pdf_text_required');
    const evidence = await call('captureEvidence', { projectId: project.id, chunkId: hit.chunkId }, researchEvidenceSchema);
    expect(evidence.locator).toContain('pages 1');
    const origin = await call('getEvidenceIndexSource', { projectId: project.id, evidenceId: evidence.id }, researchIndexedSourceSchema.nullable());
    if (origin === null) throw new Error('pdf_source_required');
    const resource = await capabilities.invoke<unknown, Response>('research.index.source', { projectId: project.id, fileId: origin.fileId, sourceHash: origin.sourceHash });
    expect(resource.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await resource.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    if (artifacts !== undefined) await writeFile(join(root, 'pdf-result.json'), JSON.stringify({ project, evidence, origin, files: await files(project.id), jobs: await call('listIndexJobs', { projectId: project.id, limit: 100 }, researchIndexJobSchema.array()) }, null, 2));
  }, 300000);
});
