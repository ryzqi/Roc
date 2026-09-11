import { randomUUID } from 'node:crypto';
import type { ResearchEmbeddingConfig, ResearchEmbeddingConfigSaveRequest, ResearchKnowledgeDocument, ResearchKnowledgeDocumentUpsertRequest,
  ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { vectorToBlob } from './embedding-vectors';
import type { EmbeddingConfigRow, ResearchRepository } from './repository';

type EmbeddingTask = { configId: string | null; controller: AbortController; promise: Promise<unknown> };

export class ResearchEmbeddingService {
  private readonly tasks = new Set<EmbeddingTask>();
  private closed = false;

  constructor(private readonly repository: ResearchRepository, private readonly client: OpenAICompatibleEmbeddingClient,
    private readonly context: Pick<RocPluginContext, 'secrets' | 'logger'>) {}

  listConfigs(): ResearchEmbeddingConfig[] {
    return this.repository.listEmbeddingConfigRows().map((row) => this.config(row));
  }

  saveConfig(request: ResearchEmbeddingConfigSaveRequest): ResearchEmbeddingConfig {
    this.requireOpen();
    const previous = this.repository.listEmbeddingConfigRows().find((row) => row.id === request.id);
    const reuse = previous !== undefined && this.context.secrets.get(previous.api_key_secret_key) === request.apiKey;
    const key = reuse ? previous.api_key_secret_key : `research.embedding.${randomUUID()}`;
    try {
      if (!reuse) this.context.secrets.set(key, request.apiKey);
      this.repository.saveEmbeddingConfig(request, key);
    } catch (error) {
      if (!reuse) {
        try { this.context.secrets.clear(key); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'research_embedding_config_save_failed'); }
      }
      throw error;
    }
    const saved = this.repository.listEmbeddingConfigRows().find((row) => row.id === request.id);
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

  async upsertDocument(request: ResearchKnowledgeDocumentUpsertRequest, signal?: AbortSignal): Promise<ResearchKnowledgeDocument> {
    this.requireOpen();
    const row = this.select(request.embeddingConfigId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      if (row !== null) this.repository.requireEmbeddingConfig(row.id, row.revision);
      const document = this.repository.upsertKnowledgeDocument(request);
      if (row !== null) {
        const chunks = this.repository.knowledgeChunks(request.id);
        const vectors: Buffer[] = [];
        for (let offset = 0; offset < chunks.length; offset += 32) {
          this.requireActive(active);
          this.repository.requireEmbeddingConfig(row.id, row.revision);
          const batch = chunks.slice(offset, offset + 32);
          const values = await this.client.embed({ config: this.config(row), apiKey: this.apiKey(row), texts: batch.map((chunk) => chunk.content), signal: active });
          vectors.push(...values.map(vectorToBlob));
        }
        this.requireActive(active);
        this.repository.storeChunkEmbeddings({ configId: row.id, configRevision: row.revision, chunks, vectors });
      }
      return document;
    });
  }

  async search(request: ResearchKnowledgeSearchRequest, signal?: AbortSignal): Promise<ResearchKnowledgeSearchResult> {
    this.requireOpen();
    const row = this.select(request.embeddingConfigId);
    return await this.task(row?.id ?? null, signal, async (active) => {
      this.requireActive(active);
      if (row === null) return this.repository.searchKnowledge({ request, vector: null });
      this.repository.requireEmbeddingConfig(row.id, row.revision);
      const [value] = await this.client.embed({ config: this.config(row), apiKey: this.apiKey(row), texts: [request.query], signal: active });
      this.requireActive(active);
      return this.repository.searchKnowledge({ request, vector: { configId: row.id, configRevision: row.revision, blob: vectorToBlob(value) } });
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
    const rows = this.repository.listEmbeddingConfigRows();
    const row = id === null ? rows.find((entry) => entry.enabled === 1) : rows.find((entry) => entry.id === id);
    if (row === undefined) {
      if (id !== null) throw new Error('research_embedding_config_not_found');
      return null;
    }
    return this.repository.requireEmbeddingConfig(row.id, row.revision);
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
