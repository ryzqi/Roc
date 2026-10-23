import { randomUUID } from 'node:crypto';
import type { ResearchEmbeddingConfig, ResearchEmbeddingConfigSaveRequest, ResearchKnowledgeDocument, ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import { researchEmbeddingConfigSaveRequestSchema } from '../../../shared/schemas/research';
import type { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { vectorToBlob } from './embedding-vectors';
import type { EmbeddingConfigRow, KnowledgeSourceWrite, ResearchKnowledgeRepository } from './knowledge-repository';

type EmbeddingTask = { configId: string | null; controller: AbortController; promise: Promise<unknown> };
export type ResearchEmbeddingReceipt = { configId: string; revision: number } | null;

export class ResearchEmbeddingService {
  private readonly tasks = new Set<EmbeddingTask>();
  private closed = false;

  constructor(private readonly knowledge: ResearchKnowledgeRepository, private readonly client: OpenAICompatibleEmbeddingClient,
    private readonly context: Pick<RocPluginContext, 'secrets' | 'logger'>) {}

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
    const reuse = previous !== undefined && (await this.context.secrets.get(previous.api_key_secret_key)) === normalized.apiKey;
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
      if (row !== null) await this.embedChunks(request.id, row, active);
      return document;
    });
  }

  selectedConfiguration(id: string | null): ResearchEmbeddingReceipt {
    const row = this.select(id);
    return row === null ? null : { configId: row.id, revision: row.revision };
  }

  async embedDocument(documentId: string, configId: string | null, signal?: AbortSignal): Promise<ResearchEmbeddingReceipt> {
    this.requireOpen();
    const row = this.select(configId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      this.knowledge.knowledgeDocument(documentId);
      if (row === null) return null;
      await this.embedChunks(documentId, row, active);
      return { configId: row.id, revision: row.revision };
    });
  }

  private async embedChunks(documentId: string, row: EmbeddingConfigRow, signal: AbortSignal): Promise<void> {
    const chunks = this.knowledge.knowledgeChunks(documentId);
    const vectors: Buffer[] = [];
    for (let offset = 0; offset < chunks.length; offset += 32) {
      this.requireActive(signal);
      this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      const values = await this.client.embed({ config: await this.config(row), apiKey: await this.apiKey(row),
        texts: chunks.slice(offset, offset + 32).map((chunk) => chunk.content), signal });
      vectors.push(...values.map(vectorToBlob));
    }
    this.requireActive(signal);
    this.knowledge.storeChunkEmbeddings({ configId: row.id, configRevision: row.revision, chunks, vectors });
  }

  async search(request: ResearchKnowledgeSearchRequest, signal?: AbortSignal): Promise<ResearchKnowledgeSearchResult> {
    this.requireOpen();
    const row = this.select(request.embeddingConfigId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      if (row === null) return this.knowledge.searchKnowledge({ request, vector: null });
      this.knowledge.requireEmbeddingConfig(row.id, row.revision);
      const [value] = await this.client.embed({ config: await this.config(row), apiKey: await this.apiKey(row), texts: [request.query], signal: active });
      this.requireActive(active);
      return this.knowledge.searchKnowledge({ request, vector: { configId: row.id, configRevision: row.revision, blob: vectorToBlob(value) } });
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks) task.controller.abort();
    await Promise.allSettled([...this.tasks].map((task) => task.promise));
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
    const key = await this.context.secrets.get(row.api_key_secret_key);
    if (key === null) throw new Error('research_embedding_key_missing');
    return key;
  }

  private async config(row: EmbeddingConfigRow): Promise<ResearchEmbeddingConfig> {
    return { id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, dimensions: row.dimensions,
      keyConfigured: (await this.context.secrets.get(row.api_key_secret_key)) !== null, enabled: row.enabled === 1, updatedAt: row.updated_at };
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
