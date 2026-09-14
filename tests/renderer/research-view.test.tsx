// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchView } from '../../src/renderer/views/research/ResearchView';
import { createLoadedState } from './view-test-helpers';
import type { ResearchArtifact, ResearchProject, ResearchStageRun, ResearchWorkflowEvent, ResearchWorkflowSnapshot } from '../../src/shared/types';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe('ResearchView project dashboard', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('shows the pipeline, next action, timeline and review decision', async () => {
    const api = createResearchApi();
    await renderView(api);
    expect(text('research-current-stage')).toBe('写作');
    expect(text('research-next-action')).toContain('审核当前产物');
    expect(text('research-timeline')).toContain('阶段产物等待用户审核。');
    expect(text('research-artifacts')).toContain('Results');
    await click('research-approve');
    expect(api.transitionWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
  });

  it('requires an explicit review accept or revise decision', async () => {
    const snapshot = workflow({ stage: 'review', status: 'waiting_approval', gateRequired: true, artifactIds: ['artifact_1'] });
    const api = createResearchApi({ workflow: snapshot });
    await renderView(api);
    expect(text('research-current-stage')).toBe('审稿');
    await click('research-review-accept');
    expect(api.transitionWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', reviewDecision: 'accept', expectedStage: 'review' }));
  });

  it('starts a stage role with the typed instruction', async () => {
    const api = createResearchApi({
      workflow: workflow({ status: 'running', gateRequired: false, artifactIds: [] }),
      events: [event('stage_started', '阶段已开始。')],
      artifacts: []
    });
    await renderView(api);
    setValue('research-run-input', '写出可追溯的检索策略。');
    await click('research-start-run');
    expect(api.startStageRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', expectedStage: 'writing', instruction: '写出可追溯的检索策略。'
    }));
  });
});

function createResearchApi(overrides: {
  workflow?: ResearchWorkflowSnapshot;
  events?: ResearchWorkflowEvent[];
  runs?: ResearchStageRun[];
  artifacts?: ResearchArtifact[];
} = {}) {
  const project: ResearchProject = {
    id: 'research_1', title: '证据图', description: '把想法变成可追溯项目。', workspacePath: null,
    status: 'active', language: 'zh', origin: null, currentStage: 'writing',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z'
  };
  return {
    listProjects: vi.fn().mockResolvedValue({ ok: true, data: [project] }),
    getWorkflow: vi.fn().mockResolvedValue({ ok: true, data: overrides.workflow ?? workflow() }),
    listWorkflowEvents: vi.fn().mockResolvedValue({ ok: true, data: overrides.events ?? [event('approval_requested', '阶段产物等待用户审核。')] }),
    listStageRuns: vi.fn().mockResolvedValue({ ok: true, data: overrides.runs ?? [] }),
    listArtifacts: vi.fn().mockResolvedValue({ ok: true, data: overrides.artifacts ?? [artifact()] }),
    transitionWorkflow: vi.fn().mockResolvedValue({ ok: true, data: workflow({ status: 'completed', gateApproved: true }) }),
    startStageRun: vi.fn().mockResolvedValue({ ok: true, data: run() }),
    cancelStageRun: vi.fn(),
    retryStageRun: vi.fn(),
    createProject: vi.fn(),
    searchLiterature: vi.fn(),
    searchKnowledge: vi.fn(),
    listEmbeddingConfigs: vi.fn(),
    saveEmbeddingConfig: vi.fn()
  };
}

function workflow(stage: Partial<ResearchWorkflowSnapshot['stages'][number]> = {}): ResearchWorkflowSnapshot {
  const names = ['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'revision', 'export'] as const;
  const current = {
    stage: 'writing' as const, status: 'waiting_approval' as const, activeRunId: null, artifactIds: ['artifact_1'],
    enteredAt: '2026-09-14T00:30:00.000Z', completedAt: null, gateRequired: true, gateApproved: false, lastError: null, ...stage
  };
  return {
    projectId: 'research_1', currentStage: current.stage, projectStatus: 'active',
    stages: names.map((name, index) => name === current.stage ? current : {
      stage: name, status: index < names.indexOf(current.stage) ? 'completed' as const : 'locked' as const,
      activeRunId: null, artifactIds: [], enteredAt: index < names.indexOf(current.stage) ? '2026-09-14T00:00:00.000Z' : null,
      completedAt: index < names.indexOf(current.stage) ? '2026-09-14T00:10:00.000Z' : null,
      gateRequired: name !== 'discovery', gateApproved: false, lastError: null
    }),
    lastEvent: { type: 'approval_requested', stage: current.stage, message: '阶段产物等待用户审核。', createdAt: '2026-09-14T01:00:00.000Z' }
  };
}

function event(type: string, message: string): ResearchWorkflowEvent {
  return { id: `event_${type}`, projectId: 'research_1', stage: 'writing', type, message, payload: {}, createdAt: '2026-09-14T01:00:00.000Z' };
}

function artifact(): ResearchArtifact {
  return { id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Results', path: null, status: 'draft', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z' };
}

function run(): ResearchStageRun {
  return {
    id: 'run_1', projectId: 'research_1', stage: 'writing', requestId: 'req_1', parentRunId: null, retryOfRunId: null,
    reviewCycleId: null, revisionRound: 0, role: 'academic-writing-agent', outputKind: 'manuscript', status: 'queued',
    instruction: '写出可追溯的检索策略。', skillIds: ['roc-academic-writing'], skillHash: 'a'.repeat(64), toolNames: [],
    inputArtifactIds: [], outputArtifactIds: [], policy: { projectId: 'research_1', stage: 'writing', tier: 'deep', model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000 },
    providerId: null, modelId: null, modelVersion: null, error: null, createdAt: '2026-09-14T01:10:00.000Z', startedAt: null, endedAt: null
  };
}

async function renderView(research: ReturnType<typeof createResearchApi>): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ResearchView, {
      client: { api: { research } as never },
      state: createLoadedState({ workspace: { id: 'ws', path: '/tmp/roc', label: 'Roc' } as never })
    }));
  });
  await act(async () => { await Promise.resolve(); });
}

function text(testId: string): string {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node).not.toBeNull();
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

async function click(testId: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

function setValue(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}
