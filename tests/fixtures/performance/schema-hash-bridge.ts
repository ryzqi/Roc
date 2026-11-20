import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { CapabilityRegistry } from '../../../src/main/kernel/capability-registry';
import { registerResearchDocumentCapabilities, researchDocumentCapabilities } from '../../../src/main/plugins/research/document-capabilities';
import type { ResearchDocumentRepository } from '../../../src/main/plugins/research/document-repository';
import type { ResearchDocumentService } from '../../../src/main/plugins/research/document-service';
import type { RocPluginContext } from '../../../src/main/kernel/types';
import { ResearchKnowledgeRepository } from '../../../src/main/plugins/research/knowledge-repository';
import { applyResearchDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import type { ResearchKnowledgeDocumentUpsertRequest } from '../../../src/shared/types';

export function createSchemaRunner() {
  const registry = new CapabilityRegistry();
  for (const descriptor of researchDocumentCapabilities) registry.declare('research', descriptor);
  const capability = researchDocumentCapabilities.find(item => item.name === 'research.document.parseMany')!;
  let parses = 0, handled = 0;
  const original = capability.inputSchema.parse;
  capability.inputSchema.parse = (...args) => { parses++; return original(...args); };
  const service = { parseMany: async () => { handled++; return { documents: [], failed: [] }; } };
  registerResearchDocumentCapabilities({ pluginId: 'research', capabilities: registry } as RocPluginContext,
    {} as ResearchDocumentRepository, service as unknown as ResearchDocumentService);
  return {
    async run(iterations: number, documentIds: string[] | null) {
      parses = 0; handled = 0;
      for (let index = 0; index < iterations; index++) {
        await registry.invoke('research.document.parseMany', { documentIds, tier: null });
      }
      return { parses, handled };
    },
    close() { capability.inputSchema.parse = original; }
  };
}

export function createHashRunner(path: string, request: ResearchKnowledgeDocumentUpsertRequest) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys=ON');
  applyResearchDatabaseSchema(db, () => '2026-11-15T00:00:00.000Z');
  const repository = new ResearchKnowledgeRepository(db, () => {}, () => '2026-11-15T00:00:00.000Z');
  return {
    run() {
      let documentHashCalls = 0, hashBytes = 0;
      const original = crypto.createHash;
      crypto.createHash = (...args: Parameters<typeof original>) => {
        const hash = original(...args), update = hash.update;
        hash.update = (data, ...options) => {
          if (typeof data === 'string') {
            hashBytes += Buffer.byteLength(data);
            if (data === request.content) documentHashCalls++;
          }
          return update.call(hash, data, ...options);
        };
        return hash;
      };
      syncBuiltinESMExports();
      try { repository.upsertKnowledgeDocument(request); }
      finally { crypto.createHash = original; syncBuiltinESMExports(); }
      const snapshot = JSON.stringify({
        document: db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all(),
        chunks: db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all(),
        structure: db.prepare('SELECT * FROM research_knowledge_chunk_structure ORDER BY chunk_id').all(),
        semantics: db.prepare('SELECT * FROM research_knowledge_chunk_semantics ORDER BY chunk_id').all()
      });
      return { documentHashCalls, hashBytes, outputSha256: createHash('sha256').update(snapshot).digest('hex') };
    },
    close() {
      if (db.pragma('integrity_check', {simple: true}) !== 'ok' || db.pragma('foreign_key_check').length !== 0) {
        throw new Error('schema_hash_database_integrity');
      }
      db.close();
    }
  };
}
