// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESEARCH_SHELL_STORAGE_KEY } from '../../src/renderer/app/view-routing';
import { ResearchAppShell } from '../../src/renderer/views/research/ResearchAppShell';
import type { ResearchIndexStatus, ResearchProject, ResearchWorkflowEvent, ResearchWorkflowSnapshot } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe('ResearchAppShell', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    window.history.replaceState({}, '', '/?page=research&shell=research');
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('shows the empty shell when no project exists', async () => {
    const api = createResearchApi({ projects: [] });
    await renderShell(api);
    expect(text('research-shell-empty')).toContain('创建或导入研究项目');
    expect(document.querySelector('[data-testid="research-app-shell"]')?.getAttribute('data-shell-state')).toBe('empty');
  });

  it('shows the selected project context', async () => {
    const api = createResearchApi();
    await renderShell(api);
    expect(text('research-shell-project-title')).toBe('证据图');
    expect(text('research-shell-stage')).toBe('写作');
    expect(text('research-shell-gates')).toBe('1');
    expect(text('research-shell-runs')).toBe('0');
    expect(text('research-shell-artifacts')).toBe('1');
  });

  it('falls back to the legacy page and clears the shell flag', async () => {
    const api = createResearchApi();
    window.localStorage.setItem(RESEARCH_SHELL_STORAGE_KEY, 'research');
    const onFallbackLegacy = vi.fn();
    await renderShell(api, onFallbackLegacy);
    await click('research-shell-fallback');
    expect(onFallbackLegacy).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RESEARCH_SHELL_STORAGE_KEY)).toBeNull();
    expect(new URL(window.location.href).searchParams.get('shell')).toBe('legacy');
  });
});

function createResearchApi(overrides: { projects?: ResearchProject[] } = {}) {
  const project: ResearchProject = {
    id: 'research_1', title: '证据图', description: '把想法变成可追溯项目。', workspacePath: null,
    status: 'active', language: 'zh', origin: null, currentStage: 'writing',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z'
  };
  const projects = overrides.projects ?? [project];
  return {
    listProjects: vi.fn().mockResolvedValue({ ok: true, data: projects }),
    getWorkflow: vi.fn().mockResolvedValue({ ok: true, data: workflow() }),
    listWorkflowEvents: vi.fn().mockResolvedValue({ ok: true, data: [event()] }),
    listStageRuns: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listArtifacts: vi.fn().mockResolvedValue({ ok: true, data: [{
      id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Results', path: null,
      status: 'draft', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z'
    }] }),
    getIndexStatus: vi.fn().mockResolvedValue({ ok: true, data: indexStatus() }),
    createProject: vi.fn(),
    transitionWorkflow: vi.fn(),
    startStageRun: vi.fn(),
    cancelStageRun: vi.fn(),
    retryStageRun: vi.fn(),
    controlIndex: vi.fn(),
    getModelsStatus: vi.fn().mockResolvedValue({ ok: true, data: { ready: true, downloading: false, error: null, models: [] } }),
    downloadModels: vi.fn()
  };
}

function workflow(): ResearchWorkflowSnapshot {
  const names = ['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'revision', 'export'] as const;
  const current = {
    stage: 'writing' as const, status: 'waiting_approval' as const, activeRunId: null, artifactIds: ['artifact_1'],
    enteredAt: '2026-09-14T00:30:00.000Z', completedAt: null, gateRequired: true, gateApproved: false, lastError: null
  };
  return {
    projectId: 'research_1', currentStage: 'writing', projectStatus: 'active',
    stages: names.map((name, index) => name === current.stage ? current : {
      stage: name, status: index < names.indexOf(current.stage) ? 'completed' as const : 'locked' as const,
      activeRunId: null, artifactIds: [], enteredAt: index < names.indexOf(current.stage) ? '2026-09-14T00:00:00.000Z' : null,
      completedAt: index < names.indexOf(current.stage) ? '2026-09-14T00:10:00.000Z' : null,
      gateRequired: name !== 'discovery', gateApproved: false, lastError: null
    }),
    lastEvent: { type: 'approval_requested', stage: 'writing', message: '阶段产物等待用户审核。', createdAt: '2026-09-14T01:00:00.000Z' }
  };
}

function event(): ResearchWorkflowEvent {
  return { id: 'event_approval_requested', projectId: 'research_1', stage: 'writing', type: 'approval_requested', message: '阶段产物等待用户审核。', payload: {}, createdAt: '2026-09-14T01:00:00.000Z' };
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

async function renderShell(research: ReturnType<typeof createResearchApi>, onFallbackLegacy?: () => void): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ResearchAppShell, {
      client: { api: { research } as never },
      onFallbackLegacy: onFallbackLegacy ?? (() => undefined),
      state: createLoadedState({ workspace: { id: 'ws', path: '/tmp/roc', label: 'Roc' } as never })
    }));
  });
  await act(async () => { await Promise.resolve(); });
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
