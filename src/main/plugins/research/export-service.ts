import { constants, linkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import { researchExportPrepareSchema, researchExportWriteRequestSchema, type ResearchExportDelivery, type ResearchExportExecution,
  type ResearchExportFile, type researchExportFileContentSchema, type ResearchExportPrepare, type ResearchExportSources } from '../../../shared/schemas/research-exports';
import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { buildExportFiles } from './export-builder';
import { archiveSource, createExportArchive, exportFileLimit, exportStorage, hashExportArchive, ResearchExportFiles, type ExportToolchain } from './export-files';
import { exportSourceHash, type ResearchExportSourceService } from './export-sources';
import { ResearchProcessError } from './process-runner';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';

type Task = { controller: AbortController; promise: Promise<unknown> };

export class ResearchExportService {
  private readonly tasks = new Set<Task>();
  private readonly preparing = new Map<string, Task & { projectId: string; scope: string }>();
  private closed = false;

  constructor(private readonly repository: ResearchRepository, private readonly sources: Pick<ResearchExportSourceService, 'capture' | 'assertCurrent'>,
    private readonly tools: ExportToolchain, private readonly rootPath: string | null, private readonly logger: RocPluginContext['logger'],
    private readonly archive: typeof createExportArchive = createExportArchive) {}

  recover(): void { this.repository.exports.recover(); }

  async prepare(input: ResearchExportPrepare): Promise<ResearchExportExecution> {
    const request = researchExportPrepareSchema.parse(input);
    return await this.task(async (signal) => {
      const storage = await exportStorage(this.rootPath);
      this.requireActive(signal);
      const record = this.repository.exports.create(request, storage);
      if (record.status === 'preparing' && !this.preparing.has(record.id)) this.schedule(record);
      return record;
    });
  }

  async cancel(projectId: string, id: string): Promise<ResearchExportExecution> {
    this.requireOpen();
    const record = this.repository.exports.get(projectId, id);
    if (record.status !== 'preparing') return record;
    const task = this.preparing.get(id);
    if (task !== undefined) { task.controller.abort(); await task.promise; return this.repository.exports.get(projectId, id); }
    return this.repository.exports.finish(projectId, id, { ...record, status: 'cancelled', error: 'research_export_cancelled' });
  }

  projectChanged(projectId: string): void {
    if (this.closed) return;
    const scope = this.projectScope(projectId);
    for (const task of this.preparing.values()) if (task.projectId === projectId && task.scope !== scope) task.controller.abort();
  }

  async publish(projectId: string, id: string, replacesExportId: string | null): Promise<ResearchExportExecution> {
    return await this.task(async (signal) => {
      const record = this.repository.exports.get(projectId, id);
      await this.verify(record, signal);
      this.requireActive(signal);
      if (record.sources === null) throw new Error('research_export_sources_required');
      this.sources.assertCurrent(record.request, record.sources);
      return this.repository.exports.publish(projectId, id, replacesExportId);
    });
  }

  async transition(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot> {
    if (request.expectedStage !== 'export' || (request.action !== 'complete' && request.action !== 'approve')) throw new Error('research_export_transition_invalid');
    return await this.task(async (signal) => {
      const signature = this.reviewSignature(request.projectId);
      const stage = this.repository.getWorkflow(request.projectId).stages.find((entry) => entry.stage === 'export');
      if (stage === undefined) throw new Error('research_stage_not_found');
      const records = stage.artifactIds.map((id) => this.repository.exports.forArtifact(this.repository.getArtifact(id)));
      for (const record of records) await this.verify(record, signal);
      this.requireActive(signal);
      for (const record of records) {
        if (record.sources === null) throw new Error('research_export_sources_required');
        this.sources.assertCurrent(record.request, record.sources);
      }
      if (signature !== this.reviewSignature(request.projectId)) throw new Error('research_export_review_changed');
      return this.repository.transitionWorkflow(request);
    });
  }

  async source(projectId: string, id: string, sha256: string): Promise<Buffer> {
    const record = this.repository.exports.get(projectId, id);
    if (record.status !== 'ready') throw new Error('research_export_ready_required');
    const { file, bytes } = await this.file(record, 'paper.pdf');
    if (file.sha256 !== sha256) throw new Error('research_export_snapshot_changed');
    return bytes;
  }

  async read(projectId: string, id: string, path: string): Promise<z.infer<typeof researchExportFileContentSchema>> {
    const record = this.repository.exports.get(projectId, id);
    const expected = record.files.find((file) => file.path === path);
    if (expected !== undefined && expected.size > 4 * 1024 * 1024) throw new Error('research_export_preview_limit');
    const { file, bytes } = await this.file(record, path);
    try { return { file, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' }; }
    catch { return { file, content: bytes.toString('base64'), encoding: 'base64' }; }
  }

  async write(input: z.infer<typeof researchExportWriteRequestSchema>): Promise<ResearchExportDelivery> {
    const request = researchExportWriteRequestSchema.parse(input);
    return await this.task(async (signal) => {
      const record = this.requireApproved(request.projectId, request.exportId);
      await this.verify(record, signal);
      if (record.archive === null || record.sources === null) throw new Error('research_export_sources_required');
      const parent = await researchWorkspace(dirname(request.destinationPath));
      const destinationPath = join(parent, basename(request.destinationPath));
      const temporary = await mkdtemp(join(parent, '.roc-export-'));
      try {
        const staged = join(temporary, 'export.zip');
        await copyFile(join(this.repository.exports.root(record.projectId, record.id), record.archive.path), staged, constants.COPYFILE_EXCL);
        await hashExportArchive(temporary, { ...record.archive, path: 'export.zip' }, signal);
        this.requireActive(signal);
        this.sources.assertCurrent(record.request, record.sources);
        this.requireApproved(record.projectId, record.id);
        // 最后只执行同一文件系统上的排他链接，已有文件不会被替换；检查与提交之间不让出事件循环。
        try { linkSync(staged, destinationPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('research_export_destination_exists');
          throw error;
        }
        return { projectId: record.projectId, exportId: record.id, destinationPath, sha256: record.archive.sha256, size: record.archive.size, createdAt: new Date().toISOString() };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks) task.controller.abort();
    await Promise.allSettled([...this.tasks].map((task) => task.promise));
  }

  private schedule(record: ResearchExportExecution): void {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(record, controller.signal));
    const task = { controller, promise, projectId: record.projectId, scope: this.projectScope(record.projectId) };
    this.tasks.add(task); this.preparing.set(record.id, task);
    void promise.catch((error: unknown) => this.logger.error('Research export could not persist its final state.', { exportId: record.id, error: exportError(error) }))
      .finally(() => { this.tasks.delete(task); this.preparing.delete(record.id); });
  }

  private async execute(record: ResearchExportExecution, signal: AbortSignal): Promise<void> {
    const root = this.repository.exports.root(record.projectId, record.id);
    let scratch: string | null = null;
    let writer: ResearchExportFiles | null = null;
    let sources: ResearchExportSources | null = null;
    let sourceHash: string | null = null;
    let toolchainHash: string | null = null;
    let archive: ResearchExportFile | null = null;
    try {
      this.requireActive(signal); this.repository.exports.requireCurrent(record.request);
      await mkdir(root, { mode: 0o700 });
      writer = new ResearchExportFiles(await createResearchDirectory(root, 'bundle'));
      scratch = await createResearchDirectory(root, 'scratch');
      sources = await this.sources.capture(record.request, signal);
      sourceHash = exportSourceHash(sources);
      toolchainHash = await this.tools.identity();
      const toolchain = await this.tools.status();
      if (!toolchain.available || toolchain.versions === null) throw new Error('research_export_toolchain_unavailable');
      await buildExportFiles({ record, sources, writer, repository: this.repository, tools: this.tools, scratch, signal });
      await writer.write('manifest.json', JSON.stringify({ version: 1, exportId: record.id, request: record.request, sourceHash, toolchainHash,
        toolchainVersions: toolchain.versions, archiveBuilderHash: researchContentHash(archiveSource), files: writer.list() }, null, 2));
      archive = await this.archive({ root, bundle: writer, scratch, tools: this.tools, signal });
      const current = await this.sources.capture(record.request, signal);
      if (exportSourceHash(current) !== sourceHash || await this.tools.identity() !== toolchainHash) throw new Error('research_export_sources_changed');
      this.requireActive(signal); this.sources.assertCurrent(record.request, sources);
      this.repository.exports.finish(record.projectId, record.id, { status: 'ready', sources, sourceHash, toolchainHash, files: writer.list(), archive, error: null });
    } catch (error) {
      if (writer !== null) {
        const diagnostics = error instanceof ResearchProcessError ? `${error.code}\n${error.stdout}\n${error.stderr}` : exportError(error);
        try { await writer.write('logs/export-error.txt', diagnostics); }
        catch (failure) { this.logger.warn('Research export diagnostic file could not be saved.', { exportId: record.id, error: exportError(failure) }); }
      }
      this.repository.exports.finish(record.projectId, record.id, { status: signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : 'failed',
        sources, sourceHash, toolchainHash, files: writer === null ? [] : writer.list(), archive,
        error: signal.aborted ? this.closed ? 'research_export_interrupted' : 'research_export_cancelled' : exportError(error) });
    } finally { if (scratch !== null) await rm(scratch, { recursive: true, force: true }); }
  }

  private async verify(record: ResearchExportExecution, signal: AbortSignal): Promise<void> {
    if (record.status !== 'ready' || record.sources === null || record.sourceHash === null || record.archive === null) throw new Error('research_export_ready_required');
    this.repository.exports.requireCurrent(record.request);
    const current = await this.sources.capture(record.request, signal);
    if (exportSourceHash(current) !== record.sourceHash || exportSourceHash(record.sources) !== record.sourceHash) throw new Error('research_export_sources_changed');
    for (const file of record.files) { this.requireActive(signal); await this.file(record, file.path); }
    await hashExportArchive(this.repository.exports.root(record.projectId, record.id), record.archive, signal);
    this.requireActive(signal);
  }

  private async file(record: ResearchExportExecution, path: string): Promise<{ file: ResearchExportFile; bytes: Buffer }> {
    const file = record.files.find((file) => file.path === path);
    if (file === undefined) throw new Error('research_export_file_not_found');
    const bytes = await readResearchFile(join(this.repository.exports.root(record.projectId, record.id), 'bundle'), file.path, exportFileLimit);
    if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_export_snapshot_changed');
    return { file, bytes };
  }

  private requireApproved(projectId: string, id: string): ResearchExportExecution {
    const record = this.repository.exports.get(projectId, id);
    if (record.status !== 'ready' || record.approval !== 'approved') throw new Error('research_export_approval_required');
    this.repository.exports.requireCurrent(record.request);
    return record;
  }

  private reviewSignature(projectId: string): string {
    const workflow = this.repository.getWorkflow(projectId);
    const stage = workflow.stages.find((entry) => entry.stage === 'export');
    if (stage === undefined) throw new Error('research_stage_not_found');
    return researchContentHash(JSON.stringify({ currentStage: workflow.currentStage, projectStatus: workflow.projectStatus, stage,
      artifacts: stage.artifactIds.map((id) => this.repository.getArtifact(id)) }));
  }

  private projectScope(projectId: string): string {
    const project = this.repository.getProject(projectId);
    return JSON.stringify({ title: project.title, description: project.description, workspacePath: project.workspacePath,
      stage: project.currentStage, status: project.status, review: this.repository.reviews.get(projectId) });
  }

  private async task<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.requireOpen();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => { this.requireActive(controller.signal); return operation(controller.signal); });
    const task = { controller, promise }; this.tasks.add(task);
    try { return await promise; }
    finally { this.tasks.delete(task); }
  }
  private requireOpen(): void { if (this.closed) throw new Error('research_export_closed'); }
  private requireActive(signal: AbortSignal): void { this.requireOpen(); signal.throwIfAborted(); }
}

function exportError(error: unknown): string {
  if (error instanceof ResearchProcessError) return error.code;
  if (error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message)) return error.message;
  return 'research_export_failed';
}
