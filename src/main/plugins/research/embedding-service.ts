import { randomUUID } from 'node:crypto';
import type { ResearchEmbeddingConfig, ResearchEmbeddingConfigSaveRequest, ResearchKnowledgeDocument, ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
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

  listConfigs(): ResearchEmbeddingConfig[] {
    return this.knowledge.listEmbeddingConfigRows().map((row) => this.config(row));
  }

  saveConfig(request: ResearchEmbeddingConfigSaveRequest): ResearchEmbeddingConfig {
    this.requireOpen();
    const previous = this.knowledge.listEmbeddingConfigRows().find((row) => row.id === request.id);
    const reuse = previous !== undefined && this.context.secrets.get(previous.api_key_secret_key) === request.apiKey;
    const key = reuse ? previous.api_key_secret_key : `research.embedding.${randomUUID()}`;
    try {
      if (!reuse) this.context.secrets.set(key, request.apiKey);
      this.knowledge.saveEmbeddingConfig(request, key);
    } catch (error) {
      if (!reuse) {
        try { this.context.secrets.clear(key); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'research_embedding_config_save_failed'); }
      }
      throw error;
    }
    const saved = this.knowledge.listEmbeddingConfigRows().find((row) => row.id === request.id);
    if (saved === undefined) throw new Error('research_embedding_config_missing_after_save');
    if (previous !== undefined && saved.revision !== previous.revision) {
      for (const task of this.tasks) if (task.configId === request.id) task.controller.abort();
    }
    if (!reuse && previous !== undefined) {
      try { this.context.secrets.clear(previous.api_key_secret_key); }
      catch { this.context.logger.warn('Unused research embedding credential could not be removed.', { configId: request.id }); }
    }
    return this.config(saved);
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
      const values = await this.client.embed({ config: this.config(row), apiKey: this.apiKey(row),
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
      const [value] = await this.client.embed({ config: this.config(row), apiKey: this.apiKey(row), texts: [request.query], signal: active });
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

  private apiKey(row: EmbeddingConfigRow): string {
    const key = this.context.secrets.get(row.api_key_secret_key);
    if (key === null) throw new Error('research_embedding_key_missing');
    return key;
  }

  private config(row: EmbeddingConfigRow): ResearchEmbeddingConfig {
    return { id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, dimensions: row.dimensions,
      keyConfigured: this.context.secrets.get(row.api_key_secret_key) !== null, enabled: row.enabled === 1, updatedAt: row.updated_at };
  }

  private requireOpen(): void { if (this.closed) throw new Error('research_embeddings_closed'); }
  private requireActive(signal: AbortSignal): void { if (signal.aborted || this.closed) throw new Error('research_embedding_cancelled'); }
}
