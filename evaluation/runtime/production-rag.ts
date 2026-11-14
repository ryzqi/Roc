import Database from 'better-sqlite3';
import {load} from 'sqlite-vec';
import {createHash} from 'node:crypto';
import {ResearchKnowledgeRepository} from '../../src/main/plugins/research/knowledge-repository';
import {ResearchEmbeddingService} from '../../src/main/plugins/research/embedding-service';
import {OpenAICompatibleEmbeddingClient} from '../../src/main/plugins/research/embedding-client';
import {ResearchRerankerService} from '../../src/main/plugins/research/reranker-service';
import {applyResearchDatabaseSchema} from '../../src/main/infrastructure/database-schemas';
import {knowledgeChunkVersion} from '../../src/main/plugins/research/knowledge-chunks';
import {z} from 'zod';
import {researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema} from '../../src/shared/schemas/research';
import {knowledgeContextRequestSchema} from '../../src/shared/schemas/research-knowledge-context';
import {rerankerReceiptSchema, type RerankerReceipt} from '../../src/shared/schemas/research-reranker';
import {benchmarkManifest} from './benchmark-runtime';

type SourceDocument = {
  id: string; projectId: string | null; sourceId: string; sourceVersion: string; parserVersion: string;
  sourceUri: string; license: string; current: boolean; sourceType: 'literature'|'file'|'note'|'experiment';
  title: string; content: string; contentSha256: string;
  blocks: Array<{startOffset: number; endOffset: number; section: string|null}>;
};
export type RetrievalConfiguration = {
  mode: 'bm25'|'hybrid'; rerank: 'none'|'semantic'; candidateLimit: number; topK: number; contextMaxChars: number;
};
export type RetrievalRequestCorrelation = {
  trialId: string|null; requestId: string|null; requestHash: string;
};
export type RerankerTransportEvidence = {
  schemaVersion: 1; kind: 'rerank'; sequence: number; providerId: 'roc-reranker';
  requestHash: string; correlation: RetrievalRequestCorrelation|null;
  configurationHash: string; timeoutMs: number; documentCount: number;
  receipt: RerankerReceipt; usage: null;
};
export type RetrievalTransport = {
  identity: {
    embedding: {id: string; model: string; dimensions: number; revision: number; configurationHash: string}|null;
    reranker: {model: string; configurationHash: string; timeoutMs: number}|null;
  };
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
  rerank(query: string, documents: string[], signal: AbortSignal): Promise<{
    scores: number[]|null; receipt: RerankerReceipt; correlation?: RetrievalRequestCorrelation|null;
  }>;
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const correlationId = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const transportRankSchema = z.object({
  scores: z.array(z.number().finite().min(0).max(1)).nullable(),
  receipt: rerankerReceiptSchema.extend({elapsedMs: z.number().finite().nonnegative()}),
  correlation: z.object({
    trialId: correlationId.nullable(), requestId: correlationId.nullable(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict().nullable().optional()
}).strict();

export function productionRagComponentCapability() {
  return {
    toolManifest: benchmarkManifest('rag-paper-qa', ['research_search_knowledge']),
    schemas: {
      schemaVersion: 1,
      boundary: 'host-component-production-capability',
      capabilities: [{
        name: 'research.knowledge.search', version: '1.0.0',
        inputSchema: z.toJSONSchema(researchKnowledgeSearchRequestSchema, {io: 'input'}),
        outputSchema: z.toJSONSchema(researchKnowledgeSearchResultSchema)
      }]
    }
  };
}

// Host-side production service. This module receives public source documents,
// never Task.expected, annotations, grader code, or model credentials.
export async function openProductionRag(input: {
  path: string; documents: SourceDocument[]; config: RetrievalConfiguration;
  transport?: RetrievalTransport; signal: AbortSignal; projectId: string;
}) {
  const db = new Database(input.path), now = () => new Date().toISOString();
  const transportReceipts: RerankerTransportEvidence[] = [];
  let rerankSequence = 0;
  let service: ResearchEmbeddingService|undefined;
  try {
    load(db);
    applyResearchDatabaseSchema(db, now);
    const projects = new Set(input.documents.map(d => d.projectId).filter((id): id is string => id !== null));
    projects.add(input.projectId);
    for (const id of projects) db.prepare(`INSERT INTO research_projects
      (id,title,description,status,current_stage,created_at,updated_at)
      VALUES (?,?,'Isolated evaluation corpus','active','reading',?,?)`).run(id, id, now(), now());
    const repository = new ResearchKnowledgeRepository(db, id => {
      if (!projects.has(id)) throw new Error('research_project_not_found');
    }, now);
    const embedding = input.transport?.identity.embedding;
    if (input.config.mode === 'hybrid') {
      if (!embedding) throw new Error('rag_live_embedding_configuration_required');
      repository.saveEmbeddingConfig({id: 'evaluation-embedding', name: 'Host embedding transport',
        baseUrl: 'https://evaluation.invalid/v1', model: embedding.model, dimensions: embedding.dimensions,
        apiKey: 'evaluation-stdio', enabled: true}, 'evaluation-host-credential');
    }
    const client = new OpenAICompatibleEmbeddingClient(async (_url, init) => {
      if (!input.transport || input.config.mode !== 'hybrid') throw new Error('rag_embedding_transport_unavailable');
      const payload = JSON.parse(String(init.body)) as {input: string[]};
      const vectors = await input.transport.embed(payload.input, init.signal ?? input.signal);
      return new Response(JSON.stringify({data: vectors.map((vector, index) => ({index, embedding: vector}))}), {
        status: 200, headers: {'content-type': 'application/json'}
      });
    });
    const logger = {warn: () => {}, info: () => {}, error: () => {}, debug: () => {}};
    const secrets = {get: async () => 'evaluation-stdio', set: async () => {throw new Error('readonly');},
      clear: () => {throw new Error('readonly');}};
    const configuredReranker = input.transport?.identity.reranker;
    const rerankerIdentity = configuredReranker ? {...configuredReranker} : null;
    if (input.config.rerank === 'semantic' && !rerankerIdentity) throw new Error('rag_live_reranker_configuration_required');
    // Use the provider's result directly: a second HTTP service would replace
    // its configuration hash, elapsed time and failure status with local values.
    const reranker = input.config.rerank === 'none' ? undefined : new class extends ResearchRerankerService {
      override async rank(query: string, documents: string[], active: AbortSignal) {
        active.throwIfAborted();
        const sequence = ++rerankSequence;
        // Keep the canonical key order used by the host budget's request hash.
        const requestHash = digest(JSON.stringify({input: {documents, query}, kind: 'rerank'}));
        const result = transportRankSchema.safeParse(
          await input.transport!.rerank(query, [...documents], active));
        if (!result.success) throw new Error('rag_reranker_transport_receipt_invalid');
        const {scores, receipt, correlation} = result.data;
        if (receipt.model !== rerankerIdentity!.model || receipt.configHash !== rerankerIdentity!.configurationHash
          || (scores !== null) !== (receipt.status === 'succeeded')
          || (scores !== null && scores.length !== documents.length)
          || (correlation !== undefined && correlation !== null && correlation.requestHash !== requestHash)) {
          throw new Error('rag_reranker_transport_receipt_invalid');
        }
        transportReceipts.push({
          schemaVersion: 1, kind: 'rerank', sequence, providerId: 'roc-reranker', requestHash,
          correlation: correlation ? {...correlation} : null,
          configurationHash: rerankerIdentity!.configurationHash, timeoutMs: rerankerIdentity!.timeoutMs,
          documentCount: documents.length, receipt: {...receipt}, usage: null
        });
        // A response observed after cancellation remains evidence, while the
        // caller still receives the cancellation rather than a successful search.
        active.throwIfAborted();
        return {scores, receipt: {...receipt}};
      }
    }({
      logger, secrets, config: {get: () => null, set: () => {throw new Error('readonly');}}
    }, async () => {throw new Error('rag_reranker_transport_unavailable');});
    service = new ResearchEmbeddingService(repository, client, {logger, secrets}, reranker);
    for (const document of input.documents.filter(d => d.current)) {
      input.signal.throwIfAborted();
      if (digest(document.content) !== document.contentSha256) throw new Error('rag_source_hash_mismatch');
      await service.upsertFromSource({id: document.id, projectId: document.projectId, sourceType: document.sourceType,
        sourceId: document.sourceId, title: document.title, content: document.content,
        embeddingPolicy: input.config.mode === 'hybrid' ? 'selected' : 'none',
        chunks: document.blocks.map(block => ({content: document.content.slice(block.startOffset, block.endOffset),
          locator: `utf16:${block.startOffset}-${block.endOffset}`, section: block.section}))},
      {sourceVersion: document.sourceVersion, sourceHash: document.contentSha256, sourceUri: document.sourceUri,
        license: document.license, parseId: document.parserVersion, parserVersion: document.parserVersion}, input.signal);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    return {
      repository, chunkingVersion: knowledgeChunkVersion,
      get transportReceipts(): RerankerTransportEvidence[] {
        return structuredClone([...transportReceipts].sort((a, b) => a.sequence - b.sequence));
      },
      search: async (value: unknown, signal: AbortSignal) => {
        const request = researchKnowledgeSearchRequestSchema.parse(value);
        const result = await service!.search({...request, candidateLimit: input.config.candidateLimit,
          limit: Math.min(request.limit, input.config.topK), rerank: input.config.rerank}, signal);
        repository.assertSearchCurrent(result);
        return result;
      },
      context: (value: unknown) => {
        const request = knowledgeContextRequestSchema.parse(value);
        return repository.readContext({...request, maxChars: Math.min(request.maxChars, input.config.contextMaxChars)});
      },
      close: async () => {await service!.shutdown(); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();}
    };
  } catch (error) {
    await service?.shutdown();
    db.close();
    throw error;
  }
}
