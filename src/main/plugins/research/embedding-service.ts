import { createHash, randomUUID } from 'node:crypto';
import type { ResearchEmbeddingConfig, ResearchEmbeddingConfigSaveRequest, ResearchKnowledgeDocument, ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import { researchEmbeddingConfigSaveRequestSchema } from '../../../shared/schemas/research';
import type { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { vectorToBlob } from './embedding-vectors';
import type { EmbeddingConfigRow, KnowledgeSourceWrite, ResearchKnowledgeRepository } from './knowledge-repository';
import type {ResearchRerankerService} from './reranker-service';
import type { ResearchReadonlySearchService } from './readonly-search-service';
import type {ResearchProcessingTrace} from './processing-trace';
import {knowledgeSourceEmbeddingInputs, type KnowledgeEmbeddingInput} from './knowledge-source-plan';
import type {ScientificEmbeddingIdentity} from './scientific-index-repository';
import {embedTokenBatches, embeddingCacheVersion, embeddingBatchDefaults, type EmbeddingBatchPolicy} from './embedding-batches';

type EmbeddingTask = { configId: string | null; controller: AbortController; promise: Promise<unknown> };
export type ResearchEmbeddingReceipt = { configId: string; revision: number } | null;
export type PreparedKnowledgeEmbeddings = {
  identity: ScientificEmbeddingIdentity | null; chunks: KnowledgeEmbeddingInput[]; vectors: Buffer[];
};

export class ResearchEmbeddingService {
  private readonly tasks = new Set<EmbeddingTask>();
  private closed = false;

  constructor(private readonly knowledge: ResearchKnowledgeRepository, private readonly client: OpenAICompatibleEmbeddingClient,
    private readonly context: Pick<RocPluginContext, 'secrets' | 'logger'>,
    private readonly reranker?: ResearchRerankerService,
    private readonly readonlyQueries?: Pick<ResearchReadonlySearchService, 'search' | 'shutdown'>,
    private readonly batchPolicy: EmbeddingBatchPolicy = embeddingBatchDefaults) {}

  async listConfigs(): Promise<ResearchEmbeddingConfig[]> {
    const rows = this.knowledge.listEmbeddingConfigRows();
    return await Promise.all(rows.map(async (row) => await this.config(row)));
  }

  async saveConfig(request: ResearchEmbeddingConfigSaveRequest): Promise<ResearchEmbeddingConfig> {
    this.requireOpen();
    /**
     * 先校验，再探测，最后落盘（P10）。
     *
     * 校验必须排在探测前面：一个拼错的 baseUrl / 空的 model 应该当场报「字段不合法」，
     * 而不是先发一次注定失败的 HTTP 请求再把网络错误当成结论。
     *
     * 维度未指定时（`null`），用一次真实嵌入量出来。先探后存是有意的顺序：探测失败就该
     * 保存失败。存一份维度不明的配置比报错更糟——索引器会拿着一个错数字跑完整个项目，
     * 然后每一片向量都对不上。
     */
    const parsed = researchEmbeddingConfigSaveRequestSchema.parse(request);
    const dimensions =
      parsed.dimensions === null ? await this.probeDimensions(parsed) : parsed.dimensions;
    const normalized = researchEmbeddingConfigSaveRequestSchema.parse({ ...parsed, dimensions });
    const previous = this.knowledge.listEmbeddingConfigRows().find((row) => row.id === normalized.id);
    const reuse = previous !== undefined && (await this.readRecoverableKey(previous)) === normalized.apiKey;
    const key = reuse ? previous.api_key_secret_key : `research.embedding.${randomUUID()}`;
    try {
      if (!reuse) await this.context.secrets.set(key, normalized.apiKey);
      this.knowledge.saveEmbeddingConfig(normalized, key);
    } catch (error) {
      if (!reuse) {
        try { this.context.secrets.clear(key); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'research_embedding_config_save_failed'); }
      }
      throw error;
    }
    const saved = this.knowledge.listEmbeddingConfigRows().find((row) => row.id === normalized.id);
    if (saved === undefined) throw new Error('research_embedding_config_missing_after_save');
    if (previous !== undefined && saved.revision !== previous.revision) {
      for (const task of this.tasks) if (task.configId === normalized.id) task.controller.abort();
    }
    if (!reuse && previous !== undefined) {
      try { this.context.secrets.clear(previous.api_key_secret_key); }
      catch { this.context.logger.warn('Unused research embedding credential could not be removed.', { configId: normalized.id }); }
    }
    return await this.config(saved);
  }

  async upsertFromSource(input: KnowledgeSourceWrite, sourceMetadata: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ResearchKnowledgeDocument> {
    this.requireOpen();
    if (input.embeddingPolicy !== 'none' && input.embeddingPolicy !== 'selected') {
      throw new Error('research_knowledge_embedding_policy_invalid');
    }
    const document = this.knowledge.upsertKnowledgeDocument({
      id: input.id, projectId: input.projectId, sourceType: input.sourceType, sourceId: input.sourceId,
      title: input.title, content: input.content, chunks: input.chunks, embeddingConfigId: null
    }, sourceMetadata);
    if (input.embeddingPolicy === 'none') return document;
    const selected = this.select(null);
    if (selected === null) return document;
    await this.embedDocument(document.id, selected.id, signal);
    return document;
  }

  async upsertDocument(request: ResearchKnowledgeDocumentUpsertRequest, signal?: AbortSignal): Promise<ResearchKnowledgeDocument> {
    this.requireOpen();
    const row = this.select(request.embeddingConfigId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      if (row !== null) this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      const document = this.knowledge.upsertKnowledgeDocument(request);
      if (row !== null) await this.embedChunks(request.id, row, active, this.documentTrace(request.id, row));
      return document;
    });
  }

  selectedConfiguration(id: string | null): ResearchEmbeddingReceipt {
    const row = this.select(id);
    return row === null ? null : { configId: row.id, revision: row.revision };
  }

  /** Derived SQL consumers must join the same policy-bound cache namespace used by embedTexts. */
  selectedCache(inputVersion: string): (NonNullable<ResearchEmbeddingReceipt> & {inputVersion: string}) | null {
    const row = this.select(null);
    return row === null ? null : {configId: row.id, revision: row.revision, inputVersion: this.cacheVersion(row, inputVersion)};
  }

  selectedIdentity(id: string | null): ScientificEmbeddingIdentity | null {
    const row = this.select(id);
    return row === null ? null : {configId: row.id, revision: row.revision, model: row.model, dimensions: row.dimensions};
  }

  /** Stage source vectors before a live-index transaction; no knowledge chunk is replaced here. */
  async prepareSource(input: KnowledgeSourceWrite, metadata: Record<string, unknown>, identity: ScientificEmbeddingIdentity | null,
    signal?: AbortSignal): Promise<PreparedKnowledgeEmbeddings> {
    const chunks = knowledgeSourceEmbeddingInputs(input, metadata);
    return {identity, chunks, vectors: identity === null ? [] : await this.embedInputs(
      chunks.map(chunk => ({text: chunk.embeddingInput, version: chunk.inputVersion})), identity, signal)};
  }

  /** The source owner calls this within its publication transaction, after inserting the same source plan. */
  commitPrepared(prepared: PreparedKnowledgeEmbeddings): void {
    if (prepared.identity === null) {
      if (prepared.vectors.length) throw new Error('research_embedding_chunk_count_mismatch');
      return;
    }
    this.knowledge.storeChunkEmbeddings({configId: prepared.identity.configId, configRevision: prepared.identity.revision,
      chunks: prepared.chunks, vectors: prepared.vectors});
  }

  async embedInputs(inputs: Array<{text: string; version: string}>, identity: ScientificEmbeddingIdentity,
    signal?: AbortSignal): Promise<Buffer[]> {
    this.requireOpen();
    const row = this.knowledge.requireEmbeddingConfig(identity.configId, identity.revision);
    if (row.model !== identity.model || row.dimensions !== identity.dimensions) throw new Error('research_embedding_config_changed');
    return await this.task(row.id, signal, async active => {
      const grouped = new Map<string, Array<{text: string; hash: string}>>();
      for (const input of inputs) {
        const group = grouped.get(input.version) ?? [];
        group.push({text: input.text, hash: createHash('sha256').update(input.text).digest('hex')});
        grouped.set(input.version, group);
      }
      const vectors = new Map<string, Map<string, Buffer>>();
      for (const [version, group] of grouped) {
        const cacheVersion=this.cacheVersion(row,version);
        const blobs = this.knowledge.cachedEmbeddings(row.id, row.revision, cacheVersion, group.map(input => input.hash));
        const missing = [...new Map(group.filter(input => !blobs.has(input.hash)).map(input => [input.hash, input.text]))];
        const values=await this.embedMissing(missing.map(([,text])=>text),row,active);
        missing.forEach(([hash],index)=>blobs.set(hash,values[index]!));
        this.requireActive(active); this.knowledge.requireEmbeddingConfig(row.id, row.revision);
        this.knowledge.cacheEmbeddings(row.id, row.revision, cacheVersion, missing.map(([hash]) => hash),
          missing.map(([hash]) => blobs.get(hash)!));
        vectors.set(version, blobs);
      }
      this.requireActive(active); this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      return inputs.map(input => vectors.get(input.version)!.get(createHash('sha256').update(input.text).digest('hex'))!);
    });
  }

  /** Derived consumers share the provider, versioned cache and credential boundary without becoming raw evidence. */
  async embedTexts(texts: string[], inputVersion: string | null, signal?: AbortSignal): Promise<{configId: string; revision: number; vectors: number[][]}> {
    this.requireOpen();
    const row = this.select(null);
    if (row === null) throw new Error('请先在检索设置中配置并启用嵌入模型。');
    return await this.task(row.id, signal, async active => {
      const hashes = texts.map(text => createHash('sha256').update(text).digest('hex'));
      const cacheVersion=inputVersion===null ? null : this.cacheVersion(row,inputVersion);
      const blobs = inputVersion === null ? new Map<string, Buffer>()
        : this.knowledge.cachedEmbeddings(row.id, row.revision, cacheVersion!, hashes);
      const missing = new Map<string, string>();
      texts.forEach((text, index) => {
        if (!blobs.has(hashes[index]!)) missing.set(hashes[index]!, text);
      });
      const inputs = [...missing];
      const values=await this.embedMissing(inputs.map(([,text])=>text),row,active);
      inputs.forEach(([hash],index)=>blobs.set(hash,values[index]!));
      this.requireActive(active);
      this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      if (cacheVersion !== null) this.knowledge.cacheEmbeddings(row.id, row.revision, cacheVersion, [...missing.keys()], [...missing.keys()].map(hash => blobs.get(hash)!));
      const vectors = hashes.map(hash => {
        const blob = blobs.get(hash)!;
        return Array.from({length: blob.length / 4}, (_, index) => blob.readFloatLE(index * 4));
      });
      return {configId: row.id, revision: row.revision, vectors};
    });
  }

  async embedDocument(documentId: string, configId: string | null, signal?: AbortSignal, trace?: ResearchProcessingTrace): Promise<ResearchEmbeddingReceipt> {
    this.requireOpen();
    const row = this.select(configId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      this.knowledge.knowledgeDocument(documentId);
      if (row === null) return null;
      await this.embedChunks(documentId, row, active, this.documentTrace(documentId, row, trace));
      return { configId: row.id, revision: row.revision };
    });
  }

  private documentTrace(documentId: string, row: EmbeddingConfigRow, supplied?: ResearchProcessingTrace): ResearchProcessingTrace {
    const trace = supplied ?? this.knowledge.processing.trace({trace_id: `embedding:${randomUUID()}`,
      ...this.knowledge.processingContext(documentId)});
    trace.bind({embedding_config_revision: `${row.id}:${row.revision}`});
    return trace;
  }

  private async embedChunks(documentId: string, row: EmbeddingConfigRow, signal: AbortSignal, trace: ResearchProcessingTrace): Promise<void> {
    const chunks = this.knowledge.knowledgeChunks(documentId);
    await trace.run('embedding', async () => await this.embedChunksImpl(chunks, row, signal),
      {inputCount: chunks.length, unit: 'vectors'}, count => count);
  }

  private async embedChunksImpl(chunks: ReturnType<ResearchKnowledgeRepository['knowledgeChunks']>, row: EmbeddingConfigRow, signal: AbortSignal): Promise<number> {
    const version=this.cacheVersion(row,chunks[0]?.inputVersion ?? 'raw-chunk-v1');
    const hashes=chunks.map(chunk=>{
      const hash=createHash('sha256').update(chunk.content).digest('hex');
      if(hash!==chunk.contentHash) throw new Error('research_knowledge_source_corrupt');
      return createHash('sha256').update(chunk.embeddingInput).digest('hex');
    });
    const byHash=this.knowledge.cachedEmbeddings(row.id,row.revision,version,hashes);
    const missing=new Map<string,string>();
    chunks.forEach((chunk,index)=>{
      if(!byHash.has(hashes[index]!)) missing.set(hashes[index]!,chunk.embeddingInput);
    });
    const inputs=[...missing.entries()];
    const values=await this.embedMissing(inputs.map(([,text])=>text),row,signal);
    inputs.forEach(([hash],index)=>byHash.set(hash,values[index]!));
    this.requireActive(signal);
    this.knowledge.storeChunkEmbeddings({configId:row.id,configRevision:row.revision,chunks,
      vectors:hashes.map(hash=>byHash.get(hash)!),cache:{version,hashes}});
    return chunks.length;
  }

  private cacheVersion(row: EmbeddingConfigRow, inputVersion: string): string {
    return embeddingCacheVersion({configId:row.id,revision:row.revision,model:row.model,dimensions:row.dimensions},
      inputVersion,this.batchPolicy);
  }

  private async embedMissing(texts: string[], row: EmbeddingConfigRow, signal: AbortSignal): Promise<Buffer[]> {
    return await embedTokenBatches(texts,row.dimensions,async batch=>await this.client.embed({
      config:await this.config(row),apiKey:await this.apiKey(row),texts:batch,signal
    }),signal,()=>{this.requireActive(signal);this.knowledge.requireEmbeddingConfig(row.id,row.revision);},this.batchPolicy);
  }

  /** Scientific search uses the same token budgets, cancellation and credential boundary as generic search. */
  async queryVector(query: string, identity: ScientificEmbeddingIdentity, signal: AbortSignal): Promise<{
    blob: Buffer | null; degradation: 'timeout' | 'network' | 'rate_limit' | 'provider_unavailable' | null
  }> {
    this.requireOpen();
    const row = this.knowledge.requireEmbeddingConfig(identity.configId, identity.revision);
    if (row.model !== identity.model || row.dimensions !== identity.dimensions) throw new Error('research_embedding_config_changed');
    return await this.task(row.id, signal, async active => {
      try {
        const blobs = await this.embedMissing([query], row, active);
        this.requireActive(active); this.knowledge.requireEmbeddingConfig(row.id, row.revision);
        return {blob: blobs[0]!, degradation: null};
      } catch (error) {
        this.requireActive(active); this.knowledge.requireEmbeddingConfig(row.id, row.revision);
        const degradation = transientEmbeddingFailure(error);
        if (degradation === null) throw error;
        return {blob: null, degradation};
      }
    });
  }

  async search(request: ResearchKnowledgeSearchRequest, signal?: AbortSignal): Promise<ResearchKnowledgeSearchResult> {
    this.requireOpen();
    const row = this.select(request.embeddingConfigId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      const search = async (input: Parameters<ResearchKnowledgeRepository['searchKnowledge']>[0]) => {
        this.requireActive(active);
        const result = this.readonlyQueries === undefined ? this.knowledge.searchKnowledge(input) :
          await this.readonlyQueries.search(input, active);
        this.requireActive(active);
        return result;
      };
      const finish = async (result: ResearchKnowledgeSearchResult) => {
        if (request.rerank === 'none') return result;
        const ranked = this.reranker === undefined ? {scores: null, receipt: {
          status: 'config_missing' as const, model: null, configHash: null, elapsedMs: 0
        }} : await this.reranker.rank(request.query,
          this.knowledge.searchCandidates(result).map(hit => `Document: ${hit.title}\n${hit.content.slice(0, 6000)}`), active);
        this.requireActive(active);
        return this.knowledge.applyRerank(result, ranked.scores, ranked.receipt);
      };
      if (row === null) return finish(await search({ request, vector: null }));
      this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      let values: number[][];
      try {
        const blobs=await this.embedMissing([request.query],row,active);
        values=[Array.from({length:row.dimensions},(_,index)=>blobs[0]!.readFloatLE(index*4))];
      } catch(error) {
        this.requireActive(active);
        this.knowledge.requireEmbeddingConfig(row.id,row.revision);
        const reason=transientEmbeddingFailure(error);
        if(reason===null) throw error;
        return finish(await search({request,vector:null,degradation:reason}));
      }
      this.requireActive(active);
      return finish(await search({ request, vector: { configId: row.id, configRevision: row.revision, blob: vectorToBlob(values[0]) } }));
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks) task.controller.abort();
    await Promise.allSettled([...this.tasks].map((task) => task.promise));
    await this.readonlyQueries?.shutdown();
  }

  private async task<T>(configId: string | null, external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = external === undefined ? controller.signal : AbortSignal.any([controller.signal, external]);
    const promise = Promise.resolve().then(async () => await operation(signal));
    const task: EmbeddingTask = { configId, controller, promise };
    this.tasks.add(task);
    try { return await promise; }
    catch (error) {
      const code = signal.aborted || this.closed ? 'research_embedding_cancelled' : error instanceof Error ? error.message : '';
      const messages: Record<string, string> = {
        research_embedding_cancelled: '嵌入任务已取消。', research_embedding_source_changed: '来源已变化，请重新索引。',
        research_embedding_config_changed: '嵌入配置已变化，请重试。'
      };
      if (messages[code] !== undefined) throw new RocDomainError({ code, message: messages[code], category: 'conflict', retryable: false });
      throw error;
    } finally { this.tasks.delete(task); }
  }

  private select(id: string | null): EmbeddingConfigRow | null {
    const rows = this.knowledge.listEmbeddingConfigRows();
    const row = id === null ? rows.find((entry) => entry.enabled === 1) : rows.find((entry) => entry.id === id);
    if (row === undefined) {
      if (id !== null) throw new Error('research_embedding_config_not_found');
      return null;
    }
    return this.knowledge.requireEmbeddingConfig(row.id, row.revision);
  }

  private async apiKey(row: EmbeddingConfigRow): Promise<string> {
    let key: string | null;
    try { key = await this.context.secrets.get(row.api_key_secret_key); }
    catch {
      throw new RocDomainError({code: 'research_embedding_key_unavailable',
        message: '无法读取嵌入模型密钥，请在「设置 → 向量与 RAG」重新录入密钥并保存。',
        category: 'validation', retryable: false,
        userAction: '重新录入嵌入模型 API Key 并保存后重试。'});
    }
    if (key === null) throw new Error('research_embedding_key_missing');
    return key;
  }

  /** Configuration recovery must remain available when an old ciphertext cannot be read. */
  private async readRecoverableKey(row: EmbeddingConfigRow): Promise<string | null> {
    try { return await this.context.secrets.get(row.api_key_secret_key); }
    catch {
      this.context.logger.warn('Research embedding credential is unavailable; re-enter it in settings.', {configId: row.id});
      return null;
    }
  }

  private async config(row: EmbeddingConfigRow): Promise<ResearchEmbeddingConfig> {
    return { id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, dimensions: row.dimensions,
      keyConfigured: (await this.readRecoverableKey(row)) !== null, enabled: row.enabled === 1, updatedAt: row.updated_at };
  }

  /**
   * 自动探测维度的失败要能被用户读懂。
   *
   * `probeDimensions` 抛出的是协议层的错误码（`embedding_provider_http_401` 之类），直接透给
   * 界面等于让用户去看一串词；而这一行唯一需要告诉他的是「要么改地址/密钥，要么手填维度」。
   * 所以转成 `RocDomainError` 并给出可执行的下一步，原始错误码仍留在消息里。
   */
  private async probeDimensions(request: ResearchEmbeddingConfigSaveRequest): Promise<number> {
    try {
      return await this.client.probeDimensions({
        baseUrl: request.baseUrl,
        model: request.model,
        apiKey: request.apiKey
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const unauthorized = code.endsWith('_401') || code.endsWith('_403');
      throw new RocDomainError({
        code: unauthorized ? 'research_embedding_dimensions_unauthorized' : 'research_embedding_dimensions_probe_failed',
        message: unauthorized
          ? '无法自动探测维度：嵌入端点的凭据被拒绝。'
          : `无法自动探测维度：${code.length > 0 ? code : '端点未返回可用向量'}。`,
        category: unauthorized ? 'validation' : 'external',
        retryable: !unauthorized,
        userAction: '修正接入地址与 API Key，或在「维度」里手动填入该模型的实际向量维度。'
      });
    }
  }

  private requireOpen(): void { if (this.closed) throw new Error('research_embeddings_closed'); }
  private requireActive(signal: AbortSignal): void { if (signal.aborted || this.closed) throw new Error('research_embedding_cancelled'); }
}

function transientEmbeddingFailure(error: unknown): 'timeout'|'network'|'rate_limit'|'provider_unavailable'|null {
  if (!(error instanceof Error)) return null;
  if(error.name==='TimeoutError') return 'timeout';
  if(error instanceof TypeError && /fetch failed|network|failed to fetch/i.test(error.message)) return 'network';
  if(error.message==='embedding_provider_http_429') return 'rate_limit';
  if(/^embedding_provider_http_5\d\d$/u.test(error.message)) return 'provider_unavailable';
  return null;
}
