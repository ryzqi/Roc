import { describe, expect, it } from 'vitest';

import { buildResearchTopMeta, createResearchContext } from '../../src/renderer/views/research/research-context';
import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../src/shared/types';

describe('research context', () => {
  it('projects an empty context when no project is selected', () => {
    const context = createResearchContext({
      project: null,
      workflow: null,
      events: [],
      runs: [],
      artifacts: [],
      indexStatus: null
    }, { modelsReady: false, modelsDownloading: false, modelsError: 'research_models_unavailable' });
    expect(context.projectId).toBeNull();
    expect(context.currentStage).toBeNull();
    expect(context.activeRuns).toEqual([]);
    expect(context.pendingGates).toEqual([]);
    expect(context.serviceHealth.modelsReady).toBe(false);
    expect(buildResearchTopMeta(context)).toBe('研究项目');
  });

  it('collects pending gates, active runs and artifact counts', () => {
    const context = createResearchContext({
      project: project(),
      workflow: workflow(),
      events: [event()],
      runs: [run('queued'), run('completed', 'run_done')],
      artifacts: [artifact('draft'), artifact('approved', 'artifact_2')],
      indexStatus: indexStatus()
    }, { modelsReady: true, modelsDownloading: false, modelsError: null });
    expect(context.projectId).toBe('research_1');
    expect(context.currentStage).toBe('writing');
    expect(context.pendingGates).toEqual([{ stage: 'writing', reason: '阶段产物等待审核' }]);
    expect(context.activeRuns.map((item) => item.id)).toEqual(['run_queued']);
    expect(context.artifactSummary).toEqual({ total: 2, approved: 1, draft: 1 });
    expect(context.serviceHealth.indexPhase).toBe('idle');
    expect(buildResearchTopMeta(context)).toBe('证据图 · 写作 · 运行 1 · 闸门 1');
  });
});

function project(): ResearchProject {
  return {
    id: 'research_1', title: '证据图', description: '把想法变成可追溯项目。', workspacePath: '/tmp/research-context.test-1',
    status: 'active', language: 'zh', origin: null, currentStage: 'writing',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z'
  };
}

function workflow(): ResearchWorkflowSnapshot {
  const names = ['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'revision', 'export'] as const;
  return {
    projectId: 'research_1', currentStage: 'writing', projectStatus: 'active',
    stages: names.map((name) => ({
      stage: name,
      status: name === 'writing' ? 'waiting_approval' as const : name === 'review' ? 'locked' as const : 'completed' as const,
      activeRunId: null, artifactIds: name === 'writing' ? ['artifact_1'] : [],
      enteredAt: '2026-09-14T00:00:00.000Z', completedAt: name === 'writing' ? null : '2026-09-14T00:10:00.000Z',
      gateRequired: true, gateApproved: false, lastError: null
    })),
    lastEvent: { type: 'approval_requested', stage: 'writing', message: '阶段产物等待用户审核。', createdAt: '2026-09-14T01:00:00.000Z' }
  };
}

function event(): ResearchWorkflowEvent {
  return { id: 'event_1', projectId: 'research_1', stage: 'writing', type: 'approval_requested', message: '阶段产物等待用户审核。', payload: {}, createdAt: '2026-09-14T01:00:00.000Z' };
}

function run(status: ResearchStageRun['status'], id = `run_${status}`): ResearchStageRun {
  return {
    id, projectId: 'research_1', stage: 'writing', requestId: 'req_1', parentRunId: null, retryOfRunId: null,
    reviewCycleId: null, revisionRound: 0, role: 'academic-writing-agent', outputKind: 'manuscript', status,
    instruction: '写出可追溯的检索策略。', skillIds: ['roc-academic-writing'], skillHash: 'a'.repeat(64), toolNames: [],
    inputArtifactIds: [], outputArtifactIds: [], policy: { projectId: 'research_1', stage: 'writing', tier: 'deep', model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000 },
    providerId: null, modelId: null, modelVersion: null, error: null, createdAt: '2026-09-14T01:10:00.000Z', startedAt: null, endedAt: null
  };
}

function artifact(status: ResearchArtifact['status'], id = 'artifact_1'): ResearchArtifact {
  return { id, projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Results', path: null, status, createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z' };
}

function indexStatus(): ResearchIndexStatus {
  return {
    settings: {
      projectId: 'research_1', revision: 1, kinds: ['markdown', 'latex', 'bibliography', 'csv', 'pdf', 'image'],
      include: ['**/*'], exclude: ['**/node_modules/**'], watch: true, paused: false, embeddingConfigId: null
    },
    generation: 1, workspacePath: '/tmp/roc', phase: 'idle', error: null, lastScanAt: '2026-09-14T01:00:00.000Z',
    counts: { total: 2, queued: 0, running: 0, ready: 2, failed: 0 }
  };
}
