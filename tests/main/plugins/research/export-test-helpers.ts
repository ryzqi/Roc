import { randomUUID } from 'node:crypto';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import { libraryEntry } from './library-fixtures';

export function crossrefLibraryEntries() {
  const parent = libraryEntry({ id: 'local:conf', source: 'local', externalId: 'conf', doi: null, title: 'Methods Conference', authors: [], publishedYear: 2026 },
    { booktitle: 'Methods Conference', editor: 'Alice Editor' });
  parent.bibliography.entryType = 'proceedings'; parent.bibliography.citationKey = 'conf';
  const child = libraryEntry({ id: 'local:study', source: 'local', externalId: 'study', doi: null, title: 'Measured Study', publishedYear: null, abstract: 'Measured improvement: 20%.' }, { crossref: 'conf' });
  child.bibliography.entryType = 'inproceedings'; child.bibliography.citationKey = 'study';
  return [parent, child] as const;
}

export async function approveExportManuscript(repository: ResearchRepository, projectId: string, evidenceId?: string): Promise<string> {
  const current = repository.getWorkflow(projectId).currentStage;
  if (current !== 'writing') repository.transitionWorkflow({ projectId, expectedStage: current, action: 'move', targetStage: 'writing' });
  repository.transitionWorkflow({ projectId, expectedStage: 'writing', action: 'start' });
  if (evidenceId === undefined) {
    const documentId = randomUUID();
    repository.knowledge.upsertKnowledgeDocument({ id: documentId, projectId, sourceType: 'file', sourceId: 'data.csv', title: 'Recorded measurements',
      content: 'Measured improvement: 20%.', chunks: [{ content: 'Measured improvement: 20%.', locator: 'row 2' }], embeddingConfigId: null });
    evidenceId = repository.evidence.capture({ projectId, chunkId: `${documentId}:chunk:0` }).id;
  }
  const artifact = repository.createArtifact({ projectId, stage: 'writing', kind: 'manuscript', title: 'Verified result', path: null });
  const claim = repository.evidence.createClaim({ projectId, artifactId: artifact.id, subjectType: 'paragraph', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidenceId] });
  repository.evidence.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
  repository.transitionWorkflow({ projectId, expectedStage: 'writing', action: 'complete' });
  repository.transitionWorkflow({ projectId, expectedStage: 'writing', action: 'approve' });
  const runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), {
    prepare: async () => ({ providerId: 'test-provider', modelId: 'test-model', execute: async ({ run }) => ({
      modelVersion: 'review-test-v1', output: { title: run.role, markdown: 'Reviewed with recorded evidence.', claims: [], sections: [], verdict: 'ready' }
    }) })
  }, createResearchHumanGate({ repository }));
  try {
    runtime.start({ projectId, expectedStage: 'review', instruction: 'Review the manuscript.', requestId: randomUUID() });
    await runtime.waitForIdle();
    repository.transitionWorkflow({ projectId, expectedStage: 'review', action: 'approve', reviewDecision: 'accept' });
  } finally { await runtime.shutdown(); }
  return artifact.id;
}
