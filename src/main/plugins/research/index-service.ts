import {knowledgeChunkVersion} from './knowledge-chunks';
import {paperIrVersion} from './paper-ir';
import {paperIrV2Version, type PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {buildPaperIR} from './paper-ir-builder';
import {PaperIRRepository, assertPaperIRArtifact} from './paper-ir-repository';
import {enrichPaperSemantics, type PaperSemanticGenerator} from './paper-semantic-service';
import {paperSemanticModelVersion} from '../../../shared/schemas/research-paper-semantics';
import {enrichScholarlyFields, type ScholarlyParserAdapter} from './scholarly-parser-adapter';
import {scholarlyParserVersion} from '../../../shared/schemas/research-scholarly-parser';
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
import {mainResourceActivity, type ResourceActivity} from '../../services/resource-activity';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';
import type { ResearchEmbeddingService } from './embedding-service';
import {ScientificIndexBuilder} from './scientific-index-builder';
import type {ScientificGeneration} from './scientific-index-repository';
import { embeddingKey, knowledgeId, type IndexJob, type IndexPayload } from './index-repository';
import { indexFileSignature, indexDocumentBlocks, indexText, readIndexFile, scanChangedIndexFiles, scanIndexFiles, type IndexFileKind } from './index-files';
import { maximumArtifactBytes } from './document-files';
import { pruneResearchArtifacts } from './artifact-gc';
import type { ResearchArtifactGcReport } from './artifact-gc';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath, researchWorkspace } from './research-files';

type WatchHandle = { close(): void; on(event: 'error', listener: (error: Error) => void): WatchHandle };
export type ResearchIndexWatch = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => WatchHandle;
type ScanTask = { controller: AbortController; promise: Promise<void> };
type ActiveJob = { job: IndexJob; controller: AbortController; done: Promise<void> };


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
  private readonly dirtyPaths = new Map<string, Set<string> | null>();
  private readonly scans = new Map<string, ScanTask>();
  private readonly tasks = new Set<Promise<void>>();
  private active: ActiveJob | null = null;
  private draining: Promise<void> | null = null;
  private readonly releasing = new Set<string>();

  constructor(private readonly repository: ResearchRepository, private readonly tools: Pick<ResearchToolchain, 'parseDocument' | 'identity' | 'defaultParseOptions'>,
    private readonly embeddings: ResearchEmbeddingService, private readonly rootPath: string | null,
    private readonly logger: RocPluginContext['logger'], private readonly watchFactory: ResearchIndexWatch = (path, listener) => watch(path, { recursive: true }, listener),
    private readonly activity: ResourceActivity = mainResourceActivity,
    private readonly semanticGenerator: PaperSemanticGenerator | null = null,
    private readonly scholarlyParser: ScholarlyParserAdapter | null = null) {}

  start(): void {
    this.repository.indexing.recover();
    for (const generation of this.repository.scientificIndex.recover('project')) {
      this.repository.indexing.requestScan(generation.snapshot.projectId!, false);
    }
    for (const project of this.repository.listProjects()) this.projectChanged(project.id);
    this.pump();
    // 磁盘回收（提案 §8）：启动时一次，不阻塞索引泵。失败只记日志——清理是收尾，
    // 不是启动的前置条件，不能因为回收出错就让用户打不开项目。
    const pruning = this.pruneArtifacts()
      .then((report) => { if (report.removed > 0) this.logger.info('research_artifacts_pruned', report); })
      .catch((error: unknown) => this.logger.warn('research_artifacts_prune_failed', { error: String(error) }));
    this.track(pruning, () => {});
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
    const release = this.activity.begin('research');
    try {
      const storage = await this.storage();
      return await pruneResearchArtifacts({ root: join(storage, 'artifacts'),
        referenced: this.repository.indexing.referencedArtifacts(),
        isReferenced: id => this.repository.indexing.referencedArtifacts().has(id),
        canCollect: () => !this.closed && this.active === null });
    } finally { release(); }
  }

  async releaseProject(projectId: string): Promise<void> {
    if (this.closed) { await this.settleProject(projectId); return; }
    await this.withProjectReleased(projectId, async () => {});
  }

  async withProjectReleased<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    this.requireAvailable(projectId);
    this.releasing.add(projectId);
    try { await this.settleProject(projectId); return await action(); }
    finally { this.releasing.delete(projectId); this.pump(); }
  }

  private async settleProject(projectId: string): Promise<void> {
    const scan = this.scans.get(projectId), active = this.activeFor(projectId);
    this.cancelProject(projectId);
    await Promise.allSettled([scan?.promise, active?.done]);
  }

  projectChanged(projectId: string): void {
    if (this.closed || this.releasing.has(projectId)) return;
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
      if (this.releasing.has(project.id)) continue;
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

  async configure(request: z.infer<typeof researchIndexSettingsSaveSchema>): Promise<ReturnType<ResearchIndexService['status']>> {
    this.requireAvailable(request.projectId);
    const { projectId, expectedRevision, ...options } = request;
    this.repository.indexing.saveSettings(projectId, expectedRevision, researchIndexOptionsSchema.parse(options));
    await this.withProjectReleased(projectId, async () => {});
    this.schedule(projectId, false, 0);
    return this.status(projectId);
  }

  async control(request: z.infer<typeof researchIndexControlRequestSchema>): Promise<ReturnType<ResearchIndexService['status']>> {
    this.requireAvailable(request.projectId);
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

  async paperIR(projectId: string, fileId: string) {
    // The project catalog validates file ownership before any artifact read.
    const payload = this.repository.indexing.cached(fileId).payload;
    if (!payload?.paperIR) throw new Error('research_paper_ir_artifact_missing');
    this.repository.indexing.source(projectId, fileId, payload.sourceHash);
    const storage = await this.storage();
    const parsed = researchParsedDocumentSchema.parse(JSON.parse((await readResearchFile(storage,
      `${payload.artifactPath}/result.json`, maximumArtifactBytes)).toString('utf8')));
    const ir = buildPaperIR({identity: {paperId: knowledgeId(fileId), documentId: knowledgeId(fileId),
      knowledgeDocumentId: knowledgeId(fileId), parseId: payload.parseArtifactId!, sourceHash: payload.sourceHash,
      parserFingerprint: payload.parserFingerprint!}, content: parsed,
      structure: payload.semanticEnrichment?.structure, scholarlyEnrichment: payload.scholarlyEnrichment});
    assertPaperIRArtifact(payload.paperIR, ir);
    return await new PaperIRRepository(storage).read(payload.paperIR, {paperId: knowledgeId(fileId), parseId: payload.parseArtifactId!});
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dirtyPaths.clear();
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

  private schedule(projectId: string, force: boolean, delay = 200, changedPaths: ReadonlySet<string> | null = null): void {
    if (this.closed || this.releasing.has(projectId)) return;
    const previous = this.dirtyPaths.get(projectId);
    if (force || changedPaths === null || previous === null) this.dirtyPaths.set(projectId, null);
    else {
      const merged = new Set([...(previous ?? []), ...changedPaths]);
      this.dirtyPaths.set(projectId, merged.size > 1_000 ? null : merged);
    }
    this.repository.indexing.requestScan(projectId, force);
    const scope = this.repository.indexing.scope(projectId);
    if (this.rootPath === null || scope.archived || scope.workspace_path === null || this.repository.indexing.settings(projectId).paused) return;
    const old = this.timers.get(projectId);
    if (old !== undefined) clearTimeout(old);
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      if (this.closed || this.releasing.has(projectId) || this.scans.has(projectId)) return;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.scan(projectId, controller.signal));
      const task = { controller, promise };
      this.scans.set(projectId, task);
      this.track(promise, () => {
        if (this.scans.get(projectId) === task) this.scans.delete(projectId);
        if (!this.closed && !this.releasing.has(projectId) && this.repository.indexing.scope(projectId).scan_requested) this.schedule(projectId, false, 200, this.dirtyPaths.get(projectId) ?? null);
        this.pump();
      });
    }, delay));
  }

  private async scan(projectId: string, signal: AbortSignal): Promise<void> {
    const initial = this.repository.indexing.scope(projectId);
    const release = this.activity.begin('research');
    let scan: ReturnType<ResearchRepository['indexing']['beginScan']> | null = null;
    try {
      const storage = await this.storage();
      const root = await researchWorkspace(initial.workspace_path);
      this.requireActive(signal);
      if (this.repository.indexing.scope(projectId).generation !== initial.generation) throw new Error('research_index_scope_changed');
      if (initial.root_path !== root) { this.repository.indexing.bindRoot(projectId, root); this.activeFor(projectId)?.controller.abort(); this.closeWatcher(projectId); }
      const changedPaths = this.dirtyPaths.get(projectId);
      this.dirtyPaths.delete(projectId);
      scan = this.repository.indexing.beginScan(projectId);
      const settings = this.repository.indexing.settings(projectId);
      const watchError = this.setupWatch(projectId, root, settings.watch, storage);
      const incremental = !scan.force && initial.root_path === root && initial.last_scan_at !== null && changedPaths != null
        ? await scanChangedIndexFiles(root, changedPaths, settings, storage, signal) : null;
      const files = incremental ?? await scanIndexFiles(root, settings, storage, signal);
      const parserKeys = new Map<IndexFileKind, string>();
      for (const file of files) if (!parserKeys.has(file.kind)) {
        parserKeys.set(file.kind, await this.parserKey(file.kind));
      }
      this.requireActive(signal);
      if (await researchWorkspace(this.repository.getProject(projectId).workspacePath) !== root) throw new Error('research_index_workspace_changed');
      this.repository.indexing.reconcile(projectId, scan, files, scan.force, this.embeddings.selectedConfiguration(settings.embeddingConfigId), parserKeys, incremental === null ? undefined : changedPaths ?? undefined);
      if (watchError !== null) this.repository.indexing.error(projectId, 'research_index_watch_failed');
      const active = this.activeFor(projectId);
      if (active !== null && this.repository.indexing.job(active.job.id).status !== 'running') active.controller.abort();
    } catch (error) {
      if (scan !== null) this.repository.indexing.failScan(projectId, scan.scanId, failureCode(error));
      else if (!signal.aborted && this.repository.indexing.scope(projectId).generation === initial.generation) this.repository.indexing.error(projectId, failureCode(error), true);
      if (signal.aborted || this.closed) this.repository.indexing.requestScan(projectId, scan?.force ?? false);
    } finally { release(); }
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
      handle = this.watchFactory(root, (event, filename) => {
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
          this.schedule(projectId, false, 200, event === 'change' && path !== null ? new Set([path]) : null);
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
        const queued = this.repository.indexing.nextJob([...this.releasing]);
        if (queued === null) break;
        const release = this.activity.begin('research');
        try {
          let job: IndexJob;
          try { job = this.repository.indexing.beginJob(queued.id); }
          catch (error) { this.repository.indexing.failJob(queued, failureCode(error), true); this.schedule(queued.projectId, false); continue; }
          const controller = new AbortController();
          const settled = Promise.withResolvers<void>();
          this.active = { job, controller, done: settled.promise };
          try { await this.process(job, controller.signal); }
          finally { this.active = null; settled.resolve(); }
        } finally { release(); }
      }
    });
    this.draining = promise;
    this.track(promise, (succeeded) => {
      if (this.draining === promise) this.draining = null;
      if (succeeded && !this.closed && this.repository.indexing.nextJob([...this.releasing]) !== null) this.pump();
    });
  }

  private async process(job: IndexJob, signal: AbortSignal): Promise<void> {
    let work: string | null = null;
    let scientific: ScientificGeneration | null = null;
    const trace = this.repository.processing.trace({trace_id: `index:${job.id}`, project_id: job.projectId,
      paper_id: knowledgeId(job.fileId), document_id: knowledgeId(job.fileId),
      chunk_version: knowledgeChunkVersion, index_generation: String(job.generation),
      embedding_config_revision: job.input.embedding ? `${job.input.embedding.configId}:${job.input.embedding.revision}` : null});
    const span = trace.start('index_job');
    try {
      await this.verifyJob(job, signal);
      const storage = await this.storage();
      const cached = this.repository.indexing.cached(job.fileId);
      const source = await trace.run('source_read', async () => {
        const value = await this.cacheSource(storage, job);
        trace.bind({source_hash: value.sourceHash});
        return value;
      }, {inputCount: job.input.size, unit: 'bytes'}, () => job.input.size);
      const cachedText = !job.input.force && cached.payload?.sourceHash === source.sourceHash && cached.payload.parserKey === job.input.parserKey ? cached.payload : null;
      let payload: IndexPayload;
      let ir: PaperIRV2 | null = null;
      if (cachedText !== null) {
        payload = cachedText;
        if (payload.paperIR) ir = await this.paperIR(job.projectId, job.fileId);
      }
      else if (!['pdf', 'image', 'html'].includes(job.input.kind)) {
        const bytes = await readResearchFile(storage, source.relativePath, 16 * 1024 * 1024);
        payload = { ...trace.sync('chunk_generation', () => indexText(bytes), {unit: 'chunks'}, result => result.chunks.length), sourceHash: source.sourceHash, parserKey: job.input.parserKey,
          // 纯文本输入没有解析工件：显式 null，不与“文档解析成功”混为一谈（提案 §1 职责边界）。
          parseArtifactId: null, artifactPath: null, parserFingerprint: null };
      } else {
        const jobs = await createResearchDirectory(storage, 'jobs');
        const directory = await mkdtemp(join(jobs, `${job.id}-`));
        work = directory;
        const parsed = await trace.run('document_parse', async () => await this.tools.parseDocument({ projectRoot: storage, sourcePath: source.path, outputDir: join(directory, 'output'), jobDir: directory, signal, trace,
          admission: { projectId: job.projectId, priority: 'background' },
          options: this.tools.defaultParseOptions(job.input.kind === 'html' ? 'text/html' : 'application/pdf') }), {unit: 'blocks'}, result => result.blocks.length);
        if (parsed.sourceHash !== source.sourceHash) throw new Error('research_index_source_changed');
        const artifact = await this.publishArtifact(storage, source.sourceHash, parsed, work);
        trace.bind({parse_id: artifact.parseArtifactId, parser_fingerprint: parsed.parserFingerprint});
        const semanticEnrichment = this.semanticGenerator ? await enrichPaperSemantics(parsed.blocks,
          parsed.structure, this.semanticGenerator, signal, trace) : undefined;
        const scholarlyEnrichment = job.input.kind === 'pdf' ? await enrichScholarlyFields(
          await readResearchFile(storage, source.relativePath, 512 * 1024 * 1024), source.sourceHash,
          parsed.blocks, this.scholarlyParser, signal, trace) : undefined;
        const chunks = indexDocumentBlocks(parsed.blocks, {paperId: knowledgeId(job.fileId), parseId: artifact.parseArtifactId, sourceHash: source.sourceHash}, trace,
          semanticEnrichment?.structure ?? parsed.structure);
        ir = parsed.quality ? buildPaperIR({
          identity: {paperId: knowledgeId(job.fileId), documentId: knowledgeId(job.fileId), knowledgeDocumentId: knowledgeId(job.fileId),
            parseId: artifact.parseArtifactId, sourceHash: source.sourceHash, parserFingerprint: parsed.parserFingerprint},
          content: parsed, structure: semanticEnrichment?.structure, scholarlyEnrichment}) : null;
        const paperIR = ir ? await new PaperIRRepository(storage).publish(ir) : undefined;
        payload = { content: chunks.map((chunk) => chunk.content).join('\n\n'), chunks, parserVersion: parsed.parserVersion, sourceHash: source.sourceHash, parserKey: job.input.parserKey,
          ...artifact, ...(semanticEnrichment ? {semanticEnrichment} : {}), ...(scholarlyEnrichment ? {scholarlyEnrichment} : {}),
          ...(paperIR ? {paperIR, paperIRVersion: paperIR.version} : {}) };
      }
      trace.bind({parse_id: payload.parseArtifactId, parser_fingerprint: payload.parserFingerprint,
        paper_ir_version: payload.parseArtifactId === null ? null : paperIrVersion});
      await this.verifyJob(job, signal);
      const metadata = {type: 'project-index', fileId: job.fileId, sourceHash: payload.sourceHash,
        parserKey: payload.parserKey, parseId: payload.parseArtifactId};
      const embedding = this.embeddings.selectedIdentity(job.input.embeddingConfigId);
      const staged = await trace.run('embedding', () => new ScientificIndexBuilder(this.repository, this.embeddings).stage({
        ir, paperIR: payload.paperIR ?? null,
        source: {kind: 'project', fileId: job.fileId, artifactId: payload.parseArtifactId ?? 'text'},
        generic: {id: knowledgeId(job.fileId), projectId: job.projectId, sourceType: 'file', sourceId: job.path,
          title: job.path, content: payload.content, chunks: payload.chunks, embeddingPolicy: 'none'},
        metadata, embedding, signal}), {inputCount: payload.chunks.length, unit: 'vectors'});
      scientific = staged.generation;
      const currentIR = payload.paperIR ? await new PaperIRRepository(storage).read(payload.paperIR) : null;
      await this.verifyJob(job, signal);
      // Read the original file again after provider work, independently of candidate parse/IR hashes.
      const currentSource = await readIndexFile(job.input.root, {...job.input, path: job.path});
      if (currentSource.sourceHash !== payload.sourceHash) throw new Error('research_index_source_changed');
      const validateCurrent = (): void => {
        this.requireActive(signal);
        this.repository.indexing.requireJob(job, 'running');
        if (JSON.stringify(this.embeddings.selectedIdentity(this.repository.indexing.settings(job.projectId).embeddingConfigId)) !==
          JSON.stringify(embedding)) throw new Error('research_index_embedding_changed');
      };
      trace.sync('index_publish', () => {
        const publish = () => this.repository.indexing.publishPrepared(job, payload, source.relativePath,
          staged.generic, validateCurrent, trace);
        if (scientific) this.repository.scientificIndex.publish(scientific.id, () => {
          validateCurrent();
          if (!currentIR || !payload.paperIR) throw new Error('research_paper_ir_artifact_missing');
          assertPaperIRArtifact(payload.paperIR, currentIR);
          return {paperIR: payload.paperIR, embedding: this.embeddings.selectedIdentity(
            this.repository.indexing.settings(job.projectId).embeddingConfigId)};
        }, publish);
        else publish();
      }, {inputCount: payload.chunks.length, unit: 'chunks'}, () => payload.chunks.length);
      span.finish();
    } catch (error) {
      span.fail(error);
      const code = failureCode(error);
      if (scientific) this.repository.scientificIndex.fail(scientific.id, code, signal.aborted || this.closed);
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
    const tier = this.tools.defaultParseOptions(kind === 'html' ? 'text/html' : 'application/pdf').tier;
    return ['pdf', 'image', 'html'].includes(kind)
      ? `paddleocr.js:${await this.tools.identity()}:${tier}:${knowledgeChunkVersion}:${paperIrVersion}:${paperIrV2Version}:${this.semanticGenerator ? paperSemanticModelVersion : 'rules'}:${scholarlyParserVersion}:${this.scholarlyParser?.identity ?? 'disabled'}`
      : knowledgeChunkVersion;
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
    this.dirtyPaths.delete(projectId);
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
  private requireAvailable(projectId: string): void {
    this.requireOpen();
    if (this.releasing.has(projectId)) throw new Error('research_index_project_releasing');
    this.repository.getProject(projectId);
  }
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
