import { randomUUID } from 'node:crypto';
import { link, lstat, mkdtemp, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { z } from 'zod';
import type { ResearchTemplate, ResearchTemplateCompileRequest, ResearchTemplateImportRequest } from '../../../shared/types';
import type { researchTemplateEntryRequestSchema, researchTemplateFileContentSchema, researchTemplateFileRequestSchema, researchTemplateFileSaveRequestSchema } from '../../../shared/schemas/research-production';
import { compileLatex, discoverLatexEntry } from './latex-service';
import { ResearchProcessError } from './process-runner';
import { createResearchDirectory, readResearchFile, researchAbsolutePath, researchContentHash, researchWorkspace } from './research-files';
import { copyTemplateFiles, editableTemplateExtensions, listTemplateFiles, requireTemplateRoot, templateDigest, type TemplateFile } from './template-files';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';

type CompileState = { template: ResearchTemplate; workspace: string; root: string; job: string; source: string; runId: string; controller: AbortController; ownerRunId: string | null };

export class ResearchTemplateService {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, { runId: string; controller: AbortController; ownerRunId: string | null }>();
  private readonly imports = new Set<AbortController>();
  private readonly completions = new Set<Promise<ResearchTemplate>>();
  private closed = false;

  constructor(private readonly repository: ResearchRepository, private readonly tools: Pick<ResearchToolchain, 'compile' | 'extractTemplate'>) {}

  async importTemplate(request: ResearchTemplateImportRequest): Promise<ResearchTemplate> {
    const controller = new AbortController();
    this.imports.add(controller);
    const completion = this.importFiles(request, controller.signal);
    this.completions.add(completion);
    try { return await completion; }
    finally { this.imports.delete(controller); this.completions.delete(completion); }
  }

  private async importFiles(request: ResearchTemplateImportRequest, signal: AbortSignal): Promise<ResearchTemplate> {
    this.requireOpen();
    const workspace = await this.workspace(request.projectId, true);
    if (!isAbsolute(request.sourcePath)) throw new Error('research_absolute_path_required');
    const info = await lstat(request.sourcePath);
    if (info.isSymbolicLink()) throw new Error('research_template_symlink');
    const job = await this.job(workspace);
    let destination: string | null = null;
    let published = false;
    try {
      let source = request.sourcePath;
      if (!info.isDirectory()) {
        if (!info.isFile() || extname(source).toLowerCase() !== '.zip') throw new Error('latex_template_source_must_be_directory_or_zip');
        const bytes = await readResearchFile(await researchWorkspace(dirname(source)), basename(source), 256 * 1024 * 1024);
        const archive = join(job, 'template.zip');
        await writeFile(archive, bytes, { flag: 'wx' });
        source = join(job, 'extracted');
        await this.tools.extractTemplate({ projectRoot: workspace, sourcePath: archive, outputDir: source, jobDir: job, signal });
      }
      const files = await listTemplateFiles(source);
      const entryPath = await discoverLatexEntry(source, files);
      const parent = await createResearchDirectory(workspace, '.roc-research/templates');
      const id = `template_${randomUUID()}`;
      const target = join(parent, id);
      await copyTemplateFiles(source, target, files);
      destination = target;
      this.requireOpen();
      const template = this.repository.createTemplate({ id, projectId: request.projectId, rootPath: target, entryPath, sourceDigest: templateDigest(entryPath, files) });
      published = true;
      return template;
    } finally {
      if (!published && destination !== null) await rm(destination, { recursive: true, force: true });
      await rm(job, { recursive: true, force: true });
    }
  }

  list(projectId: string): ResearchTemplate[] { return this.repository.listTemplates(projectId); }
  get(request: ResearchTemplateCompileRequest): ResearchTemplate { return this.repository.getTemplate(request); }

  async files(request: ResearchTemplateCompileRequest): Promise<TemplateFile[]> {
    return await this.serial(request.templateId, async () => {
      const { template, root } = await this.current(request);
      const files = await listTemplateFiles(root);
      this.refresh(template, templateDigest(template.entryPath, files));
      return files;
    });
  }

  async readFile(request: z.infer<typeof researchTemplateFileRequestSchema>): Promise<z.infer<typeof researchTemplateFileContentSchema>> {
    const { root } = await this.current(request);
    this.requireEditablePath(request.path);
    const bytes = await readResearchFile(root, request.path, 1024 * 1024);
    return { path: request.path, size: bytes.byteLength, sha256: researchContentHash(bytes), editable: true,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }

  async saveFile(request: z.infer<typeof researchTemplateFileSaveRequestSchema>, ownerRunId: string | null = null): Promise<z.infer<typeof researchTemplateFileContentSchema>> {
    return await this.serial(request.templateId, async () => {
      this.requireOpen();
      if (ownerRunId !== null) this.repository.runs.requireActive(ownerRunId, request.projectId);
      const { template, root } = await this.current(request, true);
      this.requireEditablePath(request.path);
      const bytes = Buffer.from(request.content, 'utf8');
      if (bytes.byteLength > 1024 * 1024) throw new Error('research_template_file_too_large');
      const target = researchAbsolutePath(root, request.path);
      let original: Buffer | null = null;
      if (request.expectedHash === null) {
        try { await lstat(target); throw new Error('research_template_file_exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else {
        original = await readResearchFile(root, request.path, 1024 * 1024);
        if (researchContentHash(original) !== request.expectedHash) throw new Error('research_template_file_conflict');
      }
      await listTemplateFiles(root);
      if (dirname(request.path) !== '.') await createResearchDirectory(root, dirname(request.path));
      const temporary = join(dirname(target), `.roc-edit-${randomUUID()}`);
      const handle = await open(temporary, 'wx', 0o600);
      let published = false;
      try {
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        if (request.expectedHash === null) {
          await link(temporary, target);
        } else {
          if (researchContentHash(await readResearchFile(root, request.path, 1024 * 1024)) !== request.expectedHash) {
            throw new Error('research_template_file_conflict');
          }
          await rename(temporary, target);
        }
        published = true;
        await rm(temporary, { force: true });
        const files = await listTemplateFiles(root);
        if (ownerRunId !== null) this.repository.runs.requireActive(ownerRunId, request.projectId);
        this.repository.saveTemplate({ ...template, revision: template.revision + 1, status: 'imported', activeCompileId: null,
          sourceDigest: templateDigest(template.entryPath, files), errors: [], diagnostics: [] }, template.revision);
        this.active.get(template.id)?.controller.abort();
      } catch (error) {
        if (published) await this.restoreFile(root, request.path, researchContentHash(bytes), original);
        throw error;
      } finally { await rm(temporary, { force: true }); }
      return { path: request.path, size: bytes.byteLength, sha256: researchContentHash(bytes), editable: true, content: request.content };
    });
  }

  async setEntry(request: z.infer<typeof researchTemplateEntryRequestSchema>): Promise<ResearchTemplate> {
    return await this.serial(request.templateId, async () => {
      this.requireOpen();
      const { template, root } = await this.current(request, true);
      if (request.expectedRevision !== template.revision) throw new Error('research_template_version_conflict');
      if (extname(request.entryPath).toLowerCase() !== '.tex') throw new Error('latex_template_entry_invalid');
      await readResearchFile(root, request.entryPath, 1024 * 1024);
      const files = await listTemplateFiles(root);
      const saved = this.repository.saveTemplate({ ...template, entryPath: request.entryPath, revision: template.revision + 1,
        status: 'imported', activeCompileId: null, sourceDigest: templateDigest(request.entryPath, files), errors: [], diagnostics: [] }, template.revision);
      this.active.get(template.id)?.controller.abort();
      return saved;
    });
  }

  async compile(request: ResearchTemplateCompileRequest, ownerRunId: string | null = null): Promise<ResearchTemplate> {
    const state = await this.serial(request.templateId, async (): Promise<CompileState> => {
      this.requireOpen();
      if (ownerRunId !== null) this.repository.runs.requireActive(ownerRunId, request.projectId);
      const current = await this.current(request, true);
      const files = await listTemplateFiles(current.root);
      const template = this.refresh(current.template, templateDigest(current.template.entryPath, files));
      const previous = this.active.get(template.id);
      const job = await this.job(current.workspace);
      try {
        const source = join(job, 'source');
        await copyTemplateFiles(current.root, source, files);
        this.requireOpen();
        const runId = randomUUID();
        const controller = new AbortController();
        const running = this.repository.saveTemplate({ ...template, status: 'compiling', activeCompileId: runId, errors: [], diagnostics: [] }, template.revision);
        this.active.set(template.id, { runId, controller, ownerRunId });
        previous?.controller.abort();
        return { ...current, template: running, job, source, runId, controller, ownerRunId };
      } catch (error) {
        await rm(job, { recursive: true, force: true });
        throw error;
      }
    });
    const completion = this.finishCompile(state);
    this.completions.add(completion);
    const remove = (): void => { this.completions.delete(completion); };
    void completion.then(remove, remove);
    return await completion;
  }

  abortOwned(ownerRunId: string): void {
    for (const active of this.active.values()) if (active.ownerRunId === ownerRunId) active.controller.abort();
  }

  async cancel(request: ResearchTemplateCompileRequest): Promise<ResearchTemplate> {
    return await this.serial(request.templateId, async () => {
      const template = this.repository.getTemplate(request);
      this.active.get(template.id)?.controller.abort();
      if (template.activeCompileId === null) return template;
      return this.repository.saveTemplate({ ...template, status: 'failed', activeCompileId: null,
        errors: ['research_process_cancelled'], diagnostics: [{ severity: 'info', message: '编译已取消。', file: null, line: null }] }, template.revision);
    });
  }

  async pdf(request: ResearchTemplateCompileRequest & { pdfHash: string }): Promise<Buffer> {
    const { template, workspace } = await this.current(request);
    if (template.pdfPath === null || template.pdfHash !== request.pdfHash) throw new Error('research_template_preview_stale');
    const bytes = await readResearchFile(workspace, relative(workspace, template.pdfPath), 64 * 1024 * 1024);
    if (researchContentHash(bytes) !== template.pdfHash) throw new Error('research_template_pdf_changed');
    return bytes;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const controller of this.imports) controller.abort();
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.operations.values()]);
    await Promise.allSettled([...this.completions]);
  }

  private async finishCompile(state: CompileState): Promise<ResearchTemplate> {
    let published = false;
    try {
      const result = await compileLatex({ rootPath: state.source, entryPath: state.template.entryPath, outputDir: join(state.job, 'output'),
        jobDir: state.job, signal: state.controller.signal, runner: (input) => this.tools.compile(input) });
      return await this.serial(state.template.id, async () => {
        let current = this.repository.getTemplate({ projectId: state.template.projectId, templateId: state.template.id });
        if (current.activeCompileId !== state.runId) return current;
        if (state.controller.signal.aborted) throw new ResearchProcessError('research_process_cancelled');
        if (await this.workspace(current.projectId, false) !== state.workspace) throw new Error('research_project_workspace_changed');
        const files = await listTemplateFiles(state.root);
        current = this.refresh(current, templateDigest(current.entryPath, files));
        if (current.activeCompileId !== state.runId) return current;
        if (state.ownerRunId !== null) this.repository.runs.requireActive(state.ownerRunId, current.projectId);
        const next = this.repository.saveTemplate({ ...current, status: result.status, activeCompileId: null,
          errors: result.errors, diagnostics: result.diagnostics, lastCompiledAt: new Date().toISOString(),
          ...(result.status === 'ready' ? { pdfPath: result.pdfPath, pdfHash: result.pdfHash,
            compiledRevision: current.revision, compiledDigest: current.sourceDigest } : {}) }, current.revision);
        published = result.status === 'ready';
        return next;
      });
    } catch (error) {
      return await this.serial(state.template.id, async () => {
        const current = this.repository.getTemplate({ projectId: state.template.projectId, templateId: state.template.id });
        if (current.activeCompileId !== state.runId) return current;
        const code = error instanceof Error ? error.message : 'research_compile_failed';
        const message = code === 'research_process_timeout' ? '编译超时，请检查模板。' : code === 'research_process_cancelled' ? '编译已取消。' : `编译失败：${code}`;
        const next = this.repository.saveTemplate({ ...current, status: 'failed', activeCompileId: null, errors: [code],
          diagnostics: [{ severity: 'error', message, file: null, line: null }], lastCompiledAt: new Date().toISOString() }, current.revision);
        return next;
      });
    } finally {
      if (this.active.get(state.template.id)?.runId === state.runId) this.active.delete(state.template.id);
      if (!published) await rm(state.job, { recursive: true, force: true });
    }
  }

  private refresh(template: ResearchTemplate, digest: string): ResearchTemplate {
    if (template.sourceDigest === digest) return template;
    const saved = this.repository.saveTemplate({ ...template, sourceDigest: digest,
      revision: template.sourceDigest === null ? template.revision : template.revision + 1,
      status: 'imported', activeCompileId: null, errors: [], diagnostics: [] }, template.revision);
    this.active.get(template.id)?.controller.abort();
    return saved;
  }

  private async restoreFile(root: string, path: string, writtenHash: string, original: Buffer | null): Promise<void> {
    const matches = async (): Promise<boolean> => {
      try { return researchContentHash(await readResearchFile(root, path, 1024 * 1024)) === writtenHash; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    // 外部编辑已产生新内容时保留该内容，不用旧版本回滚覆盖。
    if (!await matches()) return;
    const target = researchAbsolutePath(root, path);
    if (original === null) { await unlink(target); return; }
    const temporary = join(dirname(target), `.roc-rollback-${randomUUID()}`);
    try {
      await writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
      if (await matches()) await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  private async current(request: ResearchTemplateCompileRequest, writable = false): Promise<{ template: ResearchTemplate; workspace: string; root: string }> {
    const workspace = await this.workspace(request.projectId, writable);
    const template = this.repository.getTemplate(request);
    return { template, workspace, root: await requireTemplateRoot(workspace, template.rootPath) };
  }

  private async workspace(projectId: string, writable: boolean): Promise<string> {
    const project = this.repository.getProject(projectId);
    if (writable && project.status === 'archived') throw new Error('research_project_archived');
    return await researchWorkspace(project.workspacePath);
  }

  private async job(workspace: string): Promise<string> {
    const parent = await createResearchDirectory(workspace, '.roc-research/jobs');
    return await mkdtemp(join(parent, 'template-'));
  }

  private requireEditablePath(path: string): void {
    if (!editableTemplateExtensions.has(extname(path).toLowerCase()) || path.split('/').some((part) => part.startsWith('.'))) {
      throw new Error('research_template_file_not_editable');
    }
  }

  private requireOpen(): void { if (this.closed) throw new ResearchProcessError('research_templates_closed'); }

  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    // 上一次失败不阻断下一次独立操作，但调用者仍会收到各自的错误。
    const current = previous.then(operation, operation);
    this.operations.set(id, current);
    const clear = (): void => { if (this.operations.get(id) === current) this.operations.delete(id); };
    void current.then(clear, clear);
    return await current;
  }
}
