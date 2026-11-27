import {isDeepStrictEqual} from 'node:util';
import type {RocPluginContext} from '../../kernel/types';
import {visualConfigSchema, visualIndexRequestSchema, visualSearchRequestSchema, visualRetrievalVersion,
  type VisualConfig, type VisualAsset, type VisualIndexRequest, type VisualSearchRequest,
  type VisualSearchResult, type VisualModel} from '../../../shared/schemas/research-visual-retrieval';
import type {ResearchRepository} from './repository';
import {ScientificSearchSnapshots, type ScientificSearchPaper} from './scientific-search-snapshot';
import type {ScientificVisualAsset} from './scientific-context-image';
import {inspectVisualModel} from './visual-model-files';
import {researchContentHash} from './research-files';
import {VisualIndexRepository} from './visual-index-repository';
import {encodeVisualMatrix, visualMaxSim, type VisualRetrievalAdapter} from './visual-retrieval-adapter';

const digest = (value: unknown) => researchContentHash(JSON.stringify(value));
type CapturedAsset = {receipt: VisualAsset; asset: ScientificVisualAsset};
type Job = {projectId: string; controller: AbortController; done: Promise<unknown>};
export class VisualIndexService {
  private readonly snapshots: ScientificSearchSnapshots;
  private readonly jobs = new Set<Job>();
  private readonly releasing = new Set<string>();
  private closed = false;
  constructor(private readonly repository: ResearchRepository,
    roots: {library: string | null; index: string | null},
    private readonly storage: VisualIndexRepository, private readonly adapter: VisualRetrievalAdapter,
    private readonly config: RocPluginContext['config']) {this.snapshots = new ScientificSearchSnapshots(repository, roots);}

  readConfig(projectId: string): VisualConfig {
    this.requireProject(projectId);
    return visualConfigSchema.parse(this.config.get<unknown>(this.key(projectId)) ?? {});
  }
  inspectModel(projectId: string, model: Omit<VisualModel, 'sha256'>, external: AbortSignal) {
    return this.work(projectId, external, async signal => {
      const selection = {projectId, environmentId: model.environmentId, expectedHash: model.environmentHash};
      this.repository.pythonEnvironments.get(selection);
      const inspected = await inspectVisualModel(model.path, model.family, signal);
      this.requireProject(projectId); this.repository.pythonEnvironments.get(selection); inspected.assertCurrent();
      return {...model, sha256: inspected.sha256};
    });
  }
  saveConfig(projectId: string, input: VisualConfig): VisualConfig {
    this.requireProject(projectId);
    const config = visualConfigSchema.parse(input);
    this.config.set(this.key(projectId), config);
    for (const job of this.jobs) if (job.projectId === projectId) job.controller.abort(new Error('research_visual_config_changed'));
    return config;
  }
  rebuild(input: VisualIndexRequest, external: AbortSignal = new AbortController().signal) {
    const request = visualIndexRequestSchema.parse(input);
    return this.work(request.projectId, external, async signal => {
      const config = this.readConfig(request.projectId);
      if (!config.enabled || !config.model) throw new Error('research_visual_disabled');
      const old = await this.storage.active(request.projectId);
      const captured = await this.capture(request.projectId, request.assets, signal);
      const fence = await this.fence(request.projectId, config, captured.papers, captured.assets, signal);
      const encoded = await this.adapter.encode({projectId: request.projectId, model: config.model,
        images: captured.assets.map(a => a.asset.bytes), query: null}, signal);
      const {matrices} = encoded;
      if (matrices.length !== captured.assets.length) throw new Error('research_visual_matrix_count_invalid');
      await this.snapshots.assertCurrent(request.projectId, captured.papers.map(p => p.receipt), signal);
      fence();
      const entries = captured.assets.map((a, i) => {
        const matrix = matrices[i]!;
        return {...a.receipt, matrix: {sha256: researchContentHash(encodeVisualMatrix(matrix)),
          tokens: matrix.tokens, dimensions: matrix.dimensions}};
      });
      const generation = await this.storage.publish({version: visualRetrievalVersion, projectId: request.projectId,
        configHash: digest(config), model: config.model, createdAt: new Date().toISOString(), entries}, matrices,
      old?.generation ?? null, () => {fence(); encoded.assertCurrent();});
      return {generation, assets: entries.length};
    });
  }
  search(input: VisualSearchRequest, external: AbortSignal = new AbortController().signal): Promise<VisualSearchResult> {
    const request = visualSearchRequestSchema.parse(input);
    return this.work(request.projectId, external, async signal => {
      const config = this.readConfig(request.projectId);
      const empty = (status: VisualSearchResult['status']): VisualSearchResult => ({version: visualRetrievalVersion,
        projectId: request.projectId, status, generation: null, candidates: []});
      if (request.intent === 'text') return empty('not_applicable');
      if (!config.enabled || !config.model) return empty('disabled');
      const index = await this.storage.active(request.projectId);
      if (!index) return empty('unindexed');
      if (index.manifest.configHash !== digest(config) || !isDeepStrictEqual(index.manifest.model, config.model)) {
        throw new Error('research_visual_config_changed');
      }
      // Validate explicit filters even when they match no indexed asset.
      this.snapshots.catalog(request.projectId, request.documentIds);
      const selected = index.manifest.entries.map((entry, i) => ({entry, matrix: index.matrices[i]!}))
        .filter(({entry}) => entry.kind === request.intent &&
          (!request.documentIds.length || request.documentIds.includes(entry.documentId)));
      if (!selected.length) return {...empty('ready'), generation: index.generation};
      const captured = await this.capture(request.projectId, selected.map(({entry}) => entry), signal);
      for (const [i, {entry}] of selected.entries()) {
        const {matrix: _, ...receipt} = entry;
        if (!isDeepStrictEqual(receipt, captured.assets[i]!.receipt)) throw new Error('research_visual_source_changed');
      }
      const fence = await this.fence(request.projectId, config, captured.papers, captured.assets, signal);
      const indexFence = await this.storage.guardActive(request.projectId, index.generation);
      const encoded = await this.adapter.encode({projectId: request.projectId, model: config.model, images: [], query: request.query}, signal);
      const queries = encoded.matrices;
      if (queries.length !== 1) throw new Error('research_visual_matrix_count_invalid');
      const scores = await visualMaxSim(queries[0]!, selected.map(s => s.matrix), signal);
      await this.snapshots.assertCurrent(request.projectId, captured.papers.map(p => p.receipt), signal);
      fence(); indexFence(); encoded.assertCurrent();
      return {version: visualRetrievalVersion, projectId: request.projectId, status: 'ready', generation: index.generation,
        candidates: captured.assets.map((a, i) => ({...a.receipt, score: scores[i]!,
          verification: 'verify_original_pdf' as const, exactValues: 'requires_table_or_text' as const}))
          .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.objectId.localeCompare(b.objectId))
          .slice(0, request.limit)};
    });
  }
  private async capture(projectId: string, selections: VisualIndexRequest['assets'], signal: AbortSignal) {
    const ids = [...new Set(selections.map(a => a.documentId))];
    const generations = this.snapshots.catalog(projectId, ids).filter(g => ids.includes(g.snapshot.paperIR.identity.documentId));
    const papers = await this.snapshots.capture(projectId, generations, signal), assets: CapturedAsset[] = [];
    let bytes = 0;
    for (const selected of selections) {
      const paper = papers.find(p => p.ir.identity.documentId === selected.documentId)!;
      const object = paper.ir.figures.find(f => f.id === selected.objectId) ?? paper.ir.tables.find(t => t.id === selected.objectId);
      if (!object || !object.sourceLocator) throw new Error('research_visual_object_invalid');
      const result = await this.snapshots.readVisualAsset(paper, selected.objectId, 2048, signal);
      if (!result.asset) throw new Error(`research_visual_asset_unavailable:${result.reason}`);
      bytes += result.asset.bytes.length;
      if (bytes > 128 * 1024 ** 2) throw new Error('research_visual_input_budget_exceeded');
      assets.push({receipt: {documentId: selected.documentId, objectId: selected.objectId, source: paper.receipt,
        kind: paper.ir.figures.some(f => f.id === selected.objectId) ? 'figure' : 'table', image: result.asset.image}, asset: result.asset});
    }
    return {papers, assets};
  }
  private async fence(projectId: string, config: VisualConfig, papers: ScientificSearchPaper[], assets: CapturedAsset[], signal: AbortSignal) {
    const files = await this.snapshots.guardFiles(projectId, papers.map(p => p.generation), signal);
    return () => {
      signal.throwIfAborted();
      if (digest(this.readConfig(projectId)) !== digest(config)) throw new Error('research_visual_config_changed');
      files(); for (const item of assets) item.asset.assertCurrent();
      for (const paper of papers) this.snapshots.assertReceiptCurrent(projectId, paper.receipt);
    };
  }
  private key(projectId: string) {return `research.visual.${researchContentHash(projectId)}`;}
  private requireProject(projectId: string) {
    if (this.closed) throw new Error('research_visual_closed');
    if (this.releasing.has(projectId)) throw new Error('research_visual_project_releasing');
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private async work<T>(projectId: string, external: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.requireProject(projectId); external.throwIfAborted();
    if ([...this.jobs].some(job => job.projectId === projectId)) throw new Error('research_visual_busy');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, external]);
    const done = Promise.resolve().then(() => action(signal)), job = {projectId, controller, done};
    this.jobs.add(job);
    try {return await done;} finally {this.jobs.delete(job);}
  }
  async releaseProject(projectId: string): Promise<void> {
    const jobs = [...this.jobs].filter(j => j.projectId === projectId);
    for (const job of jobs) job.controller.abort(new Error('research_visual_cancelled'));
    await Promise.allSettled(jobs.map(j => j.done));
  }
  /** Keep admission closed throughout asynchronous project deletion, including other service cleanup. */
  async withProjectReleased<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('research_visual_closed');
    if (this.releasing.has(projectId)) throw new Error('research_visual_project_releasing');
    this.repository.getProject(projectId);
    this.releasing.add(projectId);
    try {await this.releaseProject(projectId); return await action();}
    finally {this.releasing.delete(projectId);}
  }
  async removeLibraryDocuments(projectId: string, documentIds: string[]): Promise<void> {
    await this.withProjectReleased(projectId, () => this.storage.removeDocuments(projectId, new Set(documentIds)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs) job.controller.abort(new Error('research_visual_cancelled'));
    await Promise.allSettled([...this.jobs].map(j => j.done));
  }
}
