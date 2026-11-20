import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { ResearchKnowledgeRepository } from '../../../src/main/plugins/research/knowledge-repository';
import { ResearchReadonlySearchService } from '../../../src/main/plugins/research/readonly-search-service';
import { loadResearchVectorExtension } from '../../../src/main/plugins/research/research-vector-extension';
import { researchQueryLimits, type ResearchQueryInput } from '../../../src/main/workers/research-query-protocol';

/** Test-only bridge loaded into real Electron Main; queries use production code. */
export function createReadonlyQueryRunner(mode: 'main' | 'worker', path: string, workerPath: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    db.pragma('busy_timeout=5000');
    db.pragma(`cache_size=-${researchQueryLimits.cacheKiB}`);
    loadResearchVectorExtension(db);
    const now = () => '2026-11-06T00:00:00.000Z';
    const knowledge = new ResearchKnowledgeRepository(db, id => {
      if (!db.prepare('SELECT id FROM research_projects WHERE id=?').get(id)) throw new Error('research_project_not_found');
    }, now);
    let validationMs = 0, queryMs = 0, readyMs = 0, queryStarted = 0;
    const assertCurrent = knowledge.assertSearchCurrent.bind(knowledge);
    knowledge.assertSearchCurrent = result => {
      const at = performance.now();
      try { return assertCurrent(result); }
      finally { validationMs += performance.now() - at; }
    };
    const service = new ResearchReadonlySearchService(db, knowledge, {
      workerUrl: pathToFileURL(workerPath), now,
      onEvent: event => {
        if (event.type === 'ready') readyMs = performance.now() - queryStarted;
        if (event.type === 'result') queryMs = event.queryMs!;
      }
    });
    return {
      async query(input: ResearchQueryInput) {
        validationMs = 0; queryMs = 0; readyMs = 0;
        queryStarted = performance.now();
        // This is the optimized Main path retained by the production service.
        const result = mode === 'main' ? knowledge.searchKnowledge(input) : await service.search(input);
        if (mode === 'main') queryMs = performance.now() - queryStarted;
        return { result, queryMs, validationMs, readyMs, workers: service.snapshot().workers };
      },
      snapshot: () => service.snapshot(),
      async close() { try { await service.shutdown(); } finally { db.close(); } }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
