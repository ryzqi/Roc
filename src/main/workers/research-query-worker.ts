import { statSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ResearchKnowledgeRepository } from '../plugins/research/knowledge-repository';
import { loadResearchVectorExtension } from '../plugins/research/research-vector-extension';
import {
  researchQueryDatabaseSchema, researchQueryLimits, researchQueryRequestSchema, researchQueryWireSchema,
  validateResearchQueryResult, fitsResearchQueryBudget, type ResearchQueryReply, type ResearchQueryRequest
} from './research-query-protocol';

if (parentPort === null) throw new Error('research_query_parent_required');
const parent = parentPort;
let db: Database.Database | undefined;

function reply(message: ResearchQueryReply): void {
  if (message.type === 'result') {
    parent.postMessage(message, [message.bytes.buffer as ArrayBuffer]);
  } else {
    parent.postMessage(message);
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message.length > 0 && error.message.length <= 256
    ? error.message : 'research_query_failed';
}

try {
  const identity = researchQueryDatabaseSchema.parse(workerData);
  const verifyIdentity = () => {
    const file = statSync(identity.path, { bigint: true });
    if (!file.isFile() || String(file.dev) !== identity.device || String(file.ino) !== identity.inode) {
      throw new Error('research_query_database_changed');
    }
    if (db !== undefined && db.pragma('schema_version', { simple: true }) !== identity.schema) {
      throw new Error('research_query_schema_changed');
    }
  };
  verifyIdentity();
  db = new Database(identity.path, { readonly: true, fileMustExist: true });
  verifyIdentity();
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('research_query_readonly_unavailable');
  db.pragma('foreign_keys=ON');
  db.pragma('busy_timeout=5000');
  db.pragma(`cache_size=-${researchQueryLimits.cacheKiB}`);
  loadResearchVectorExtension(db);
  const connection = db;
  let generatedAt = '';
  const knowledge = new ResearchKnowledgeRepository(connection, id => {
    if (!connection.prepare('SELECT id FROM research_projects WHERE id=?').get(id)) throw new Error('research_project_not_found');
  }, () => generatedAt);
  parent.on('message', (raw: unknown) => {
    // Only one request is sent at a time by Main. No Worker-side RPC queue.
    const wire = researchQueryWireSchema.parse(raw);
    reply({ protocol: 1, type: 'started', requestId: wire.requestId });
    try {
      if (Date.now() >= wire.deadline) throw new Error('research_query_deadline_exceeded');
      verifyIdentity();
      const decoded: unknown = deserialize(wire.bytes);
      researchQueryRequestSchema.parse(decoded);
      const request = decoded as ResearchQueryRequest;
      generatedAt = request.generatedAt;
      const started = performance.now();
      // A complete query, including candidate hydration and version receipts,
      // observes one independent WAL read transaction. TEMP DOI indexes remain
      // permitted; the persistent database is opened readonly.
      const { result, snapshot } = connection.transaction(() => {
        const snapshot = {
          dataVersion: Number(connection.pragma('data_version', { simple: true })),
          schema: Number(connection.pragma('schema_version', { simple: true }))
        };
        const result = knowledge.searchKnowledge({
          ...request.input,
          vector: request.input.vector === null ? null : {
            ...request.input.vector, blob: Buffer.from(request.input.vector.blob)
          }
        });
        return { result, snapshot };
      })();
      if (Date.now() >= wire.deadline) throw new Error('research_query_deadline_exceeded');
      validateResearchQueryResult(result, {
        ...request.input,
        vector: request.input.vector === null ? null : { ...request.input.vector, blob: Buffer.from(request.input.vector.blob) }
      });
      if (!fitsResearchQueryBudget(result, researchQueryLimits.resultBytes)) {
        reply({ protocol: 1, type: 'fallback', requestId: wire.requestId, reason: 'result_bytes' });
        return;
      }
      const encoded = serialize(result);
      if (encoded.byteLength > researchQueryLimits.resultBytes) {
        reply({ protocol: 1, type: 'fallback', requestId: wire.requestId, reason: 'result_bytes' });
      } else {
        reply({ protocol: 1, type: 'result', requestId: wire.requestId, snapshot,
          queryMs: performance.now() - started, bytes: new Uint8Array(encoded) });
      }
    } catch (error) {
      reply({ protocol: 1, type: 'error', requestId: wire.requestId, code: errorCode(error) });
    }
  });
  reply({ protocol: 1, type: 'ready', database: identity });
} catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_CANTOPEN'
    ? 'research_query_readonly_unavailable' : errorCode(error);
  reply({ protocol: 1, type: 'init-error', code });
  db?.close();
  parent.close();
}
