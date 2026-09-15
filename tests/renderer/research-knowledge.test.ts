import { describe, expect, it, vi } from 'vitest';

import { createResearchKnowledgeProjection } from '../../src/renderer/views/research/research-knowledge';
import type { ResearchEvidence } from '../../src/shared/types';

describe('research knowledge projection', () => {
  it('captures a knowledge hit as project evidence', async () => {
    const captured: ResearchEvidence = {
      id: 'evidence_1', projectId: 'research_1', documentId: 'doc_1', chunkId: 'chunk_1',
      sourceType: 'file', sourceId: 'note.md', sourceVersion: 'a'.repeat(64), title: 'Measured note',
      locator: 'lines 1-1', excerpt: 'Measured result: 42 units.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T01:00:00.000Z'
    };
    const adapter = {
      search: vi.fn(async () => ({
        query: 'Measured',
        hits: [{
          chunkId: captured.chunkId, documentId: captured.documentId, title: captured.title, content: captured.excerpt,
          locator: captured.locator, sourceType: captured.sourceType, sourceId: captured.sourceId, keywordRank: 1, vectorRank: null, rrfScore: 0.5
        }],
        keywordCount: 1, vectorCount: 0, embeddingModel: null, generatedAt: captured.createdAt
      })),
      listEvidence: vi.fn(async () => [captured]),
      captureEvidence: vi.fn(),
      listEmbeddingConfigs: vi.fn(async () => []),
      saveEmbeddingConfig: vi.fn()
    };
    const knowledge = createResearchKnowledgeProjection(adapter);
    knowledge.setProject('research_1');
    knowledge.setQuery('Measured');
    await knowledge.search();
    await knowledge.capture(captured.chunkId);
    expect(adapter.captureEvidence).toHaveBeenCalledWith({ projectId: 'research_1', chunkId: captured.chunkId });
    expect(knowledge.getSnapshot().evidence[0]?.excerpt).toBe('Measured result: 42 units.');
  });

  it('drops a stale evidence load after switching projects', async () => {
    const first: ResearchEvidence = {
      id: 'evidence_1', projectId: 'research_1', documentId: 'doc_1', chunkId: 'chunk_1',
      sourceType: 'file', sourceId: 'note.md', sourceVersion: 'a'.repeat(64), title: 'First',
      locator: 'lines 1-1', excerpt: 'First project evidence.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T01:00:00.000Z'
    };
    const second: ResearchEvidence = { ...first, id: 'evidence_2', projectId: 'research_2', title: 'Second', excerpt: 'Second project evidence.' };
    let release: ((value: ResearchEvidence[]) => void) | undefined;
    const adapter = {
      search: vi.fn(),
      listEvidence: vi.fn(async (request: { projectId: string }) => {
        if (request.projectId === 'research_1') {
          return await new Promise<ResearchEvidence[]>((resolve) => { release = resolve; });
        }
        return [second];
      }),
      captureEvidence: vi.fn(),
      listEmbeddingConfigs: vi.fn(async () => []),
      saveEmbeddingConfig: vi.fn()
    };
    const knowledge = createResearchKnowledgeProjection(adapter);
    knowledge.setProject('research_1');
    const stale = knowledge.loadEvidence();
    knowledge.setProject('research_2');
    await knowledge.loadEvidence();
    expect(knowledge.getSnapshot().evidence[0]?.excerpt).toBe('Second project evidence.');
    release?.([first]);
    await stale;
    expect(knowledge.getSnapshot().evidence[0]?.excerpt).toBe('Second project evidence.');
  });
});
