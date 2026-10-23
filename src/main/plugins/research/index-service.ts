import { watch } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, matchesGlob, relative } from 'node:path';
import type { z } from 'zod';
import {
  researchIndexOptionsSchema, researchIndexSourceMetadataSchema,
  type researchIndexControlRequestSchema, type researchIndexSettingsSaveSchema, type researchIndexStatusSchema, type researchIndexedSourceSchema
} from '../../../shared/schemas/research-index';
import { researchParsedDocumentSchema } from '../../../shared/schemas/research-production';
import type { RocPluginContext } from '../../kernel/types';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';
import type { ResearchEmbeddingService } from './embedding-service';
import { embeddingKey, knowledgeId, type IndexJob, type IndexPayload } from './index-repository';
import { indexFileSignature, indexLocatedText, indexText, readIndexFile, scanIndexFiles, type IndexFileKind } from './index-files';
import { maximumArtifactBytes } from './document-files';
import { pruneResearchArtifacts } from './artifact-gc';
import type { ResearchArtifactGcReport } from './artifact-gc';
import { ResearchParseBudget } from './parse-budget';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath, researchWorkspace } from './research-files';

type WatchHandle = { close(): void; on(event: 'error', listener: (error: Error) => void): WatchHandle };
export type ResearchIndexWatch = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => WatchHandle;
type ScanTask = { controller: AbortController; promise: Promise<void> };
type ActiveJob = { job: IndexJob; controller: AbortController };


export const maxResearchIndexWatchers = 4;

export function watcherIdsToEvict(idsInOrder: readonly string[], incomingId: string, maxEntries = maxResearchIndexWatchers): string[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('research_index_watcher_limit_invalid');
  }
  const next = idsInOrder.filter((id) => id !== incomingId);
  next.push(incomingId);
  const overflow = next.length - maxEntries;
  if (overflow <= 0) {
    return [];
  }
  return next.slice(0, overflow);
}

export class ResearchIndexService {
  private closed = false;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers = new Map<string, { root: string; handle: WatchHandle }>();
  private readonly scans = new Map<string, ScanTask>();
  private readonly tasks = new Set<Promise<void>>();
  private active: ActiveJob | null = null;
  private draining: Promise<void> | null = null;
  private readonly budget = new ResearchParseBudget(1);

  /** 共享解析预算（提案 §6）：文献解析与项目索引共享同一个全局并发上限。 */
  get parseBudget(): ResearchParseBudget { return this.budget; }

  constructor(private readonly repository: ResearchRepository, private readonly tools: Pick<ResearchToolchain, 'parseDocument' | 'identity' | 'defaultParseOptions'>,
    private readonly embeddings: ResearchEmbeddingService, private readonly rootPath: string | null,
    private readonly logger: RocPluginContext['logger'], private readonly watchFactory: ResearchIndexWatch = (path, listener) => watch(path, { recursive: true }, listener)) {}

  start(): void {
    this.repository.indexing.recover();
    for (const project of this.repository.listProjects()) this.projectChanged(project.id);
    this.pump();
    // 磁盘回收（提案 §8）：启动时一次，不阻塞索引泵。失败只记日志——清理是收尾，
    // 不是启动的前置条件，不能因为回收出错就让用户打不开项目。
    void this.pruneArtifacts()
      .then((report) => { if (report.removed > 0) this.logger.info('research_artifacts_pruned', report); })
      .catch((error: unknown) => this.logger.warn('research_artifacts_prune_failed', { error: String(error) }));
  }

  /**
   * 回收派生工件。
   *
   * 路径必须走 `storage()`，不能拼 `rootPath`：那里已经对符号链接报错并取 realpath，
   * 而回收是会 `rm` 的——在未校验的路径上删目录，一旦 rootPath 是个链接就删到了别处。
   * `rootPath === null`（存储未就绪）时直接跳过，而不是拼出一个 `/artifacts`。
   */
  private async pruneArtifacts(): Promise<ResearchArtifactGcReport> {
    if (this.rootPath === null) return { scanned: 0, removed: 0, bytesReclaimed: 0, keptBytes: 0, overBudget: false };
    const storage = await this.storage();
    return await pruneResearchArtifacts({ root: join(storage, 'artifacts'),
      referenced: this.repository.indexing.referencedArtifacts() });
  }

  releaseProject(projectId: string): void {
    if (this.closed) return;
    this.cancelProject(projectId);
  }

  projectChanged(projectId: string): void {
    if (this.closed) return;
    if (this.repository.indexing.syncProject(projectId)) {
      this.cancelProject(projectId);
      this.repository.indexing.requestScan(projectId, false);
    }
    const settings = this.repository.indexing.settings(projectId);
    const scope = this.repository.indexing.scope(projectId);
    if (settings.paused || scope.archived || scope.workspace_path === null) { this.cancelProject(projectId); return; }
    if (settings.watch || scope.scan_requested) this.schedule(projectId, false, 0);
  }

  configurationChanged(): void {
    if (this.closed) return;
    for (const project of this.repository.listProjects()) {
      const settings = this.repository.indexing.settings(project.id);
      try {
        const key = embeddingKey(this.embeddings.selectedConfiguration(settings.embeddingConfigId));
        if (key === this.repository.indexing.scope(project.id).embedding_key) continue;
      } catch (error) {
        this.logger.warn('research_embedding_config_invalid', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.repository.indexing.invalidate(project.id);
      this.cancelProject(project.id);
      this.schedule(project.id, false, 0);
    }
  }

  configure(request: z.infer<typeof researchIndexSettingsSaveSchema>): ReturnType<ResearchIndexService['status']> {
    this.requireOpen();
    const { projectId, expectedRevision, ...options } = request;
    this.repository.indexing.saveSettings(projectId, expectedRevision, researchIndexOptionsSchema.parse(options));
    this.cancelProject(projectId);
    this.schedule(projectId, false, 0);
    return this.status(projectId);
  }

  control(request: z.infer<typeof researchIndexControlRequestSchema>): ReturnType<ResearchIndexService['status']> {
    this.requireOpen();
    const settings = this.repository.indexing.settings(request.projectId);
    if (settings.revision !== request.expectedRevision) throw new Error('research_index_settings_changed');
    if (request.action === 'pause' || request.action === 'resume') {
      const { projectId, revision, ...options } = settings;
      return this.configure({ ...options, projectId, expectedRevision: revision, paused: request.action === 'pause' });
    }
    if (settings.paused) throw new Error('research_index_paused');
    if (this.repository.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
    if (this.rootPath === null) throw new Error('research_index_storage_unavailable');
    if (this.repository.getProject(request.projectId).workspacePath === null) throw new Error('research_project_workspace_required');
    if (request.action === 'retry') this.repository.indexing.retry(request.projectId, request.fileId);
    this.schedule(request.projectId, request.action === 'rebuild', 0);
    return this.status(request.projectId);
  }

  status(projectId: string): z.infer<typeof researchIndexStatusSchema> { return this.repository.indexing.status(projectId, this.rootPath !== null); }

  evidenceSource(projectId: string, evidenceId: string): z.infer<typeof researchIndexedSourceSchema> | null {
    const metadata = this.repository.evidence.sourceMetadata(projectId, evidenceId);
    if (metadata === null || metadata.type !== 'project-index') return null;
    const source = researchIndexSourceMetadataSchema.parse(metadata);
    return this.repository.indexing.source(projectId, source.fileId, source.sourceHash).source;
  }

  async source(projectId: string, fileId: string, sourceHash: string): Promise<{ bytes: Buffer; path: string; kind: IndexFileKind }> {
    const record = this.repository.indexing.source(projectId, fileId, sourceHash);
    const bytes = await readResearchFile(await this.storage(), record.cachePath, 512 * 1024 * 1024);
    if (bytes.length !== record.source.size || researchContentHash(bytes) !== sourceHash) throw new Error('research_index_snapshot_changed');
    return { bytes, path: record.source.path, kind: record.source.kind };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const scan of this.scans.values()) scan.controller.abort();
    this.active?.controller.abort();
    const errors: unknown[] = [];
    for (const watcher of this.watchers.values()) {
      try { watcher.handle.close(); } catch (error) { errors.push(error); }
    }
    this.watchers.clear();
    await Promise.allSettled([...this.tasks]);
    if (errors.length > 0) throw new AggregateError(errors, 'research_index_shutdown_failed');
  }

  private schedule(projectId: string, force: boolean, delay = 200): void {
    if (this.closed) return;
    this.repository.indexing.requestScan(projectId, force);
    const scope = this.repository.indexing.scope(projectId);
    if (this.rootPath === null || scope.archived || scope.workspace_path === null || this.repository.indexing.settings(projectId).paused) return;
    const old = this.timers.get(projectId);
    if (old !== undefined) clearTimeout(old);
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      if (this.closed || this.scans.has(projectId)) return;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.scan(projectId, controller.signal));
      const task = { controller, promise };
      this.scans.set(projectId, task);
      this.track(promise, () => {
        if (this.scans.get(projectId) === task) this.scans.delete(projectId);
        if (!this.closed && this.repository.indexing.scope(projectId).scan_requested) this.schedule(projectId, false);
        this.pump();
      });
    }, delay));
  }

  private async scan(projectId: string, signal: AbortSignal): Promise<void> {
    const initial = this.repository.indexing.scope(projectId);
    let scan: ReturnType<ResearchRepository['indexing']['beginScan']> | null = null;
    try {
      const storage = await this.storage();
      const root = await researchWorkspace(initial.workspace_path);
      this.requireActive(signal);
      if (this.repository.indexing.scope(projectId).generation !== initial.generation) throw new Error('research_index_scope_changed');
      if (initial.root_path !== root) { this.repository.indexing.bindRoot(projectId, root); this.activeFor(projectId)?.controller.abort(); this.closeWatcher(projectId); }
      scan = this.repository.indexing.beginScan(projectId);
      const settings = this.repository.indexing.settings(projectId);
      const watchError = this.setupWatch(projectId, root, settings.watch, storage);
      const files = await scanIndexFiles(root, settings, storage, signal);
      const parserKeys = new Map<IndexFileKind, string>();
      for (const file of files) if (!parserKeys.has(file.kind)) {
        parserKeys.set(file.kind, await this.parserKey(file.kind));
      }
      this.requireActive(signal);
      if (await researchWorkspace(this.repository.getProject(projectId).workspacePath) !== root) throw new Error('research_index_workspace_changed');
      this.repository.indexing.reconcile(projectId, scan, files, scan.force, this.embeddings.selectedConfiguration(settings.embeddingConfigId), parserKeys);
      if (watchError !== null) this.repository.indexing.error(projectId, 'research_index_watch_failed');
      const active = this.activeFor(projectId);
      if (active !== null && this.repository.indexing.job(active.job.id).status !== 'running') active.controller.abort();
    } catch (error) {
      if (scan !== null) this.repository.indexing.failScan(projectId, scan.scanId, failureCode(error));
      else if (!signal.aborted && this.repository.indexing.scope(projectId).generation === initial.generation) this.repository.indexing.error(projectId, failureCode(error), true);
      if (signal.aborted || this.closed) this.repository.indexing.requestScan(projectId, scan?.force ?? false);
    }
  }

  private setupWatch(projectId: string, root: string, enabled: boolean, storage: string): string | null {
    if (!enabled) { this.closeWatcher(projectId); return null; }
    const existing = this.watchers.get(projectId);
    if (existing?.root === root) {
      this.retainWatcher(projectId, existing);
      return null;
    }
    this.closeWatcher(projectId);
    try {
      let handle: WatchHandle | null = null;
      handle = this.watchFactory(root, (_event, filename) => {
        if (this.closed || handle === null || this.watchers.get(projectId)?.handle !== handle) return;
        try {
          const path = filename === null ? null : filename.toString();
          if (path !== null) {
            const relativeStorage = relative(root, storage);
            if (relativeStorage && !relativeStorage.startsWith('..') && (path === relativeStorage || path.startsWith(`${relativeStorage}/`))) return;
            const options = this.repository.indexing.settings(projectId);
            if (options.exclude.some((pattern) => matchesGlob(path, pattern) || matchesGlob(`${path}/`, pattern))) return;
          }
          const current = this.watchers.get(projectId);
          if (current !== undefined) this.retainWatcher(projectId, current);
          this.schedule(projectId, false);
        } catch (error) { this.logger.warn('Research index watcher notification failed.', { projectId, error: failureCode(error) }); }
      });
      this.retainWatcher(projectId, { root, handle });
      handle.on('error', () => {
        if (this.closed || this.watchers.get(projectId)?.handle !== handle) return;
        this.closeWatcher(projectId);
        try { this.repository.indexing.error(projectId, 'research_index_watch_failed'); }
        catch (error) { this.logger.warn('Research index watcher failure could not be recorded.', { projectId, error: failureCode(error) }); }
      });
      return null;
    } catch {
      this.logger.warn('Research project watcher could not start.', { projectId });
      return 'research_index_watch_failed';
    }
  }

  private pump(): void {
    if (this.closed || this.rootPath === null || this.draining !== null) return;
    const promise = Promise.resolve().then(async () => {
      while (!this.closed) {
        const queued = this.repository.indexing.nextJob();
        if (queued === null) break;
        let job: IndexJob;
        try { job = this.repository.indexing.beginJob(queued.id); }
        catch (error) { this.repository.indexing.failJob(queued, failureCode(error), true); this.schedule(queued.projectId, false); continue; }
        const controller = new AbortController();
        this.active = { job, controller };
        try { await this.process(job, controller.signal); }
        finally { this.active = null; }
      }
    });
    this.draining = promise;
    this.track(promise, (succeeded) => {
      if (this.draining === promise) this.draining = null;
      if (succeeded && !this.closed && this.repository.indexing.nextJob() !== null) this.pump();
    });
  }

  private async process(job: IndexJob, signal: AbortSignal): Promise<void> {
    let work: string | null = null;
    try {
      await this.verifyJob(job, signal);
      const storage = await this.storage();
      const cached = this.repository.indexing.cached(job.fileId);
      const source = await this.cacheSource(storage, job);
      const cachedText = !job.input.force && cached.payload?.sourceHash === source.sourceHash && cached.payload.parserKey === job.input.parserKey ? cached.payload : null;
      let payload: IndexPayload;
      if (cachedText !== null) payload = cachedText;
      else if (!['pdf', 'image', 'html'].includes(job.input.kind)) {
        payload = { ...indexText(await readResearchFile(storage, source.relativePath, 16 * 1024 * 1024)), sourceHash: source.sourceHash, parserKey: job.input.parserKey,
          // 纯文本输入没有解析工件：显式 null，不与“文档解析成功”混为一谈（提案 §1 职责边界）。
          parseArtifactId: null, artifactPath: null, parserFingerprint: null };
      } else {
        const jobs = await createResearchDirectory(storage, 'jobs');
        work = await mkdtemp(join(jobs, `${job.id}-`));
        // 后台索引只拿 background 优先级：用户显式解析一到，就等它先走（提案 §6）。
        const slot = await this.budget.acquire('background', signal);
        let parsed: z.infer<typeof researchParsedDocumentSchema>;
        try {
          parsed = await this.tools.parseDocument({ projectRoot: storage, sourcePath: source.path, outputDir: join(work, 'output'), jobDir: work, signal,
            options: this.tools.defaultParseOptions(job.input.kind === 'html' ? 'text/html' : 'application/pdf') });
        } finally { this.budget.release(slot); }
        if (parsed.sourceHash !== source.sourceHash) throw new Error('research_index_source_changed');
        const chunks = parsed.blocks.flatMap((block) => indexLocatedText(block.text, block.locator));
        payload = { content: chunks.map((chunk) => chunk.content).join('\n\n'), chunks, parserVersion: parsed.parserVersion, sourceHash: source.sourceHash, parserKey: job.input.parserKey,
          ...await this.publishArtifact(storage, source.sourceHash, parsed, work) };
      }
      await this.verifyJob(job, signal);
      const replacedText = this.repository.indexing.publishText(job, payload, source.relativePath);
      const unchanged = !replacedText && cachedText !== null && cached.published && cached.embeddingKey === embeddingKey(job.input.embedding);
      const receipt = unchanged ? job.input.embedding : await this.embeddings.embedDocument(knowledgeId(job.fileId), job.input.embeddingConfigId, signal);
      await this.verifyJob(job, signal);
      this.repository.indexing.finishJob(job, receipt);
    } catch (error) {
      const code = failureCode(error);
      const running = this.repository.indexing.job(job.id).status === 'running';
      this.repository.indexing.failJob(job, code, signal.aborted || this.closed);
      if (running && (signal.aborted || this.closed)) this.repository.indexing.requestScan(job.projectId, job.input.force);
      if (!this.closed && !signal.aborted && ['research_index_source_changed', 'research_index_parser_changed', 'research_index_embedding_changed', 'research_index_workspace_changed', 'research_file_changed_during_read'].includes(code)) this.schedule(job.projectId, false);
    } finally { if (work !== null) await rm(work, { recursive: true, force: true }); }
  }

  /**
   * 把一次真解析的完整工件（MiddleJson / Markdown / 结构化结果 / 图片）发布成**不可变**工件。
   *
   * 提案 §8 要求两条消费者（文献阅读器与项目索引）共享同一份工件，而且索引链**不得**在取完
   * 文本后删掉它——只留 chunks 会让检索命中无法回到 `parseId`/`locator`，也让“工具目录已经
   * 清理掉了”变成一种静默的数据丢失。做法是先在同一文件系统上写 staging，再原子 rename 到
   * `artifacts/<sourceHash>/<fingerprint>`；重复解析同一源+同一 fingerprint 直接复用。
   */
  private async publishArtifact(storage: string, sourceHash: string,
    parsed: z.infer<typeof researchParsedDocumentSchema>, workPath: string): Promise<{ parseArtifactId: string; artifactPath: string; parserFingerprint: string }> {
    // 工件身份由源内容 + 解析身份决定：同一份 PDF 换档位/换模型必须得到新身份（提案 §8 缓存键）。
    const parseArtifactId = `${sourceHash.slice(0, 16)}-${parsed.parserFingerprint.slice(0, 16)}`;
    const root = await createResearchDirectory(storage, 'artifacts');
    const target = join(root, parseArtifactId);
    const artifactPath = researchRelativePath(relative(storage, target));
    // `target` 只会由一次原子 rename 产生，所以“存在”就意味着上一次发布已完整。
    // 存在性检查不用 try/catch 包住 read：`ENOENT` 是正常分支，而“结果文件读不出来”
    // 必须是一个真实错误，不能变成“那就重新发布一次”。
    if (await pathExists(target)) {
      await readResearchFile(target, 'result.json', maximumArtifactBytes);
      return { parseArtifactId, artifactPath, parserFingerprint: parsed.parserFingerprint };
    }
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    await mkdir(staging, { mode: 0o700 });
    try {
      // 完整原件：MiddleJson / Markdown / structured_content / images 全在本次 job 的 output 里。
      await cp(join(workPath, 'output'), staging, { recursive: true, errorOnExist: false });
      await writeFile(join(staging, 'result.json'), JSON.stringify(parsed), { mode: 0o600, flag: 'wx' });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // 并发发布同一次解析（两个消费者）时，后来者看到 EEXIST 就是正确结果，不是失败。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return { parseArtifactId, artifactPath, parserFingerprint: parsed.parserFingerprint };
  }

  private async cacheSource(storage: string, job: IndexJob): Promise<{ path: string; relativePath: string; sourceHash: string }> {
    const { bytes, sourceHash } = await readIndexFile(job.input.root, job.input);
    const parent = await createResearchDirectory(storage, `sources/${job.projectId}/${sourceHash}`);
    const filename = `source${extname(job.path).toLowerCase()}`;
    const path = join(parent, filename);
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (researchContentHash(await readResearchFile(parent, filename, 512 * 1024 * 1024)) !== sourceHash) throw new Error('research_index_snapshot_changed');
    }
    return { path, relativePath: researchRelativePath(relative(storage, path)), sourceHash };
  }

  private async verifyJob(job: IndexJob, signal: AbortSignal): Promise<void> {
    this.requireActive(signal);
    this.repository.indexing.requireJob(job, 'running');
    if (await this.parserKey(job.input.kind) !== job.input.parserKey) throw new Error('research_index_parser_changed');
    if (embeddingKey(this.embeddings.selectedConfiguration(this.repository.indexing.settings(job.projectId).embeddingConfigId)) !== embeddingKey(job.input.embedding)) throw new Error('research_index_embedding_changed');
    if (await researchWorkspace(this.repository.getProject(job.projectId).workspacePath) !== job.input.root) throw new Error('research_index_workspace_changed');
    const path = await researchPath(job.input.root, job.path);
    if ((await indexFileSignature(path)).signature !== job.input.signature) throw new Error('research_index_source_changed');
    this.requireActive(signal);
    this.repository.indexing.requireJob(job, 'running');
  }

  private async parserKey(kind: IndexFileKind): Promise<string> {
    // 解析档位是“可影响索引内容”的配置，所以 fingerprint 必须进入 parserKey；
    // 否则换档位后旧索引会被当成命中，用户看不到新结果。
    return ['pdf', 'image', 'html'].includes(kind)
      ? `mineru:${this.tools.identity()}:${this.tools.defaultParseOptions(kind === 'html' ? 'text/html' : 'application/pdf').tier}`
      : 'roc-text-1';
  }

  private async storage(): Promise<string> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new Error('research_index_storage_unavailable');
    try { if ((await lstat(this.rootPath)).isSymbolicLink()) throw new Error('research_index_storage_symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    return await realpath(this.rootPath);
  }

  private cancelProject(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(projectId);
    this.scans.get(projectId)?.controller.abort();
    this.activeFor(projectId)?.controller.abort();
    this.closeWatcher(projectId);
  }
  private retainWatcher(projectId: string, watcher: { root: string; handle: WatchHandle }): void {
    for (const id of watcherIdsToEvict([...this.watchers.keys()], projectId)) {
      this.closeWatcher(id);
    }
    this.watchers.delete(projectId);
    this.watchers.set(projectId, watcher);
  }

  private closeWatcher(projectId: string): void {
    const watcher = this.watchers.get(projectId);
    this.watchers.delete(projectId);
    try { watcher?.handle.close(); }
    catch (error) { this.logger.warn('Research index watcher could not close.', { projectId, error: failureCode(error) }); }
  }
  private activeFor(projectId: string): ActiveJob | null { return this.active?.job.projectId === projectId ? this.active : null; }
  private requireOpen(): void { if (this.closed) throw new Error('research_index_closed'); }
  private requireActive(signal: AbortSignal): void { if (this.closed || signal.aborted) throw new Error('research_index_cancelled'); }

  private track(promise: Promise<void>, done: (succeeded: boolean) => void): void {
    this.tasks.add(promise);
    const finish = (succeeded: boolean): void => {
      this.tasks.delete(promise);
      try { done(succeeded); } catch (error) { this.logger.warn('Research index completion failed.', { error: failureCode(error) }); }
    };
    void promise.then(() => finish(true), (error: unknown) => { this.logger.warn('Research index background operation failed.', { error: failureCode(error) }); finish(false); });
  }
}

/** `ENOENT` 是正常分支；其它错误（权限、I/O）必须原样冒出去，不能被当成“不存在”。 */
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('research_')) return error.code;
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  return /^(research_|embedding_)[a-z_\d]+$/u.test(code) ? code : 'research_index_failed';
}
