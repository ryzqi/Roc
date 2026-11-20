import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { ResearchKnowledgeSearchResult } from '../../../shared/types';
import { RocDomainError } from '../../services/errors';
import { ResearchQueryClient, type ResearchQueryClientOptions } from '../../workers/research-query-client';
import { researchQueryLimits, type ResearchQueryDatabase, type ResearchQueryInput } from '../../workers/research-query-protocol';
import type { ResearchKnowledgeRepository } from './knowledge-repository';

export class ResearchReadonlySearchService {
  private client: ResearchQueryClient | null = null;
  private identity: ResearchQueryDatabase | null = null;
  private readonly fileIdentity: Omit<ResearchQueryDatabase, 'schema'> | null;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly knowledge: ResearchKnowledgeRepository,
    private readonly options: Omit<ResearchQueryClientOptions, 'database'>
  ) {
    // Bind the trusted Main database before the first lazy query. A replacement
    // with identical bytes/schema must not silently become the Worker's source.
    if (db.memory) this.fileIdentity = null;
    else {
      const path = realpathSync(db.name), file = statSync(path, { bigint: true });
      if (!file.isFile()) throw new Error('research_query_database_changed');
      this.fileIdentity = { path, device: String(file.dev), inode: String(file.ino) };
    }
  }

  snapshot(): ReturnType<ResearchQueryClient['snapshot']> {
    return this.client?.snapshot() ?? { workers: 0, active: null, queued: 0, queuedBytes: 0, starts: 0, exits: 0 };
  }

  async search(input: ResearchQueryInput, signal?: AbortSignal): Promise<ResearchKnowledgeSearchResult> {
    if (this.closed) throw new Error('research_query_closed');
    signal?.throwIfAborted();
    if (!this.shouldIsolate()) return this.knowledge.searchKnowledge(input);
    this.verifyDatabase();
    if (this.client === null) this.client = new ResearchQueryClient({ ...this.options, database: this.identity! });
    let result: ResearchKnowledgeSearchResult | null;
    try {
      result = await this.client.search(input, signal);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const messages: Record<string, string> = {
        research_query_deadline_exceeded: '检索超时，请重试。',
        research_query_queue_full: '检索队列已满，请稍后重试。',
        research_query_worker_crashed: '检索工作线程已退出，请重试。'
      };
      if (messages[code] !== undefined) throw new RocDomainError({ code, message: messages[code], category: 'conflict', retryable: true });
      throw error;
    }
    signal?.throwIfAborted();
    this.verifyDatabase();
    if (result === null) return this.knowledge.searchKnowledge(input);
    // Async isolation is a new freshness boundary. Never use only a cached
    // connection token to assert that source/configuration is still current.
    if (input.vector !== null && result.ranking.embedding?.queryVectorHash !== hash(input.vector.blob)) {
      throw new Error('research_query_result_binding_invalid');
    }
    const candidates = new Map(result.ranking.candidates.map(candidate => [candidate.chunkId, candidate]));
    for (const hit of result.hits) {
      const candidate = candidates.get(hit.chunkId);
      if (candidate === undefined || candidate.documentId !== hit.documentId ||
          candidate.locator !== hit.locator || candidate.chunkHash !== hash(hit.content)) {
        throw new Error('research_query_result_binding_invalid');
      }
    }
    this.knowledge.assertSearchCurrent(result);
    return result;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.client?.shutdown();
  }

  private shouldIsolate(): boolean {
    if (process.env.ROC_PERF_RESEARCH_WORKER_QUERIES === '0' || this.db.memory || this.db.inTransaction ||
        this.db.pragma('journal_mode', { simple: true }) !== 'wal') return false;
    return this.db.prepare('SELECT 1 FROM research_knowledge_chunks LIMIT 1 OFFSET ?')
      .get(researchQueryLimits.thresholdChunks - 1) !== undefined;
  }

  private verifyDatabase(): void {
    if (this.identity === null) {
      if (this.fileIdentity === null) throw new Error('research_query_database_changed');
      this.identity = { ...this.fileIdentity,
        schema: Number(this.db.pragma('schema_version', { simple: true })) };
    }
    const file = statSync(this.identity.path, { bigint: true });
    if (!file.isFile() || String(file.dev) !== this.identity.device || String(file.ino) !== this.identity.inode) {
      throw new Error('research_query_database_changed');
    }
    if (this.db.pragma('schema_version', { simple: true }) !== this.identity.schema) {
      throw new Error('research_query_schema_changed');
    }
  }
}

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
