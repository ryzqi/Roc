import { describe, expect, it, vi } from 'vitest';

import { createResearchWorkbench, sameSnapshotData } from '../../src/renderer/views/research/research-workbench';
import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../src/shared/types';
import type { ResearchWorkbenchAdapter } from '../../src/renderer/views/research/research-workbench';

describe('research workbench', () => {
  it('loads projects without selecting one', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load(null);
    const snapshot = workbench.getSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.project).toBeNull();
    expect(snapshot.workflow).toBeNull();
    expect(snapshot.artifacts).toEqual([]);
    expect(snapshot.loading).toBe(false);
    expect(snapshot.working).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(store.adapter.listProjects).toHaveBeenCalledTimes(1);
    expect(store.adapter.getWorkflow).not.toHaveBeenCalled();
  });

  it('clears the current project without dropping the list', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    expect(workbench.getSnapshot().project?.id).toBe('research_1');
    workbench.clearProject();
    expect(workbench.getSnapshot().project).toBeNull();
    expect(workbench.getSnapshot().workflow).toBeNull();
    expect(workbench.getSnapshot().projects).toHaveLength(1);
  });

  it('does not fall back to another project when the preferred id is missing', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('missing');
    expect(workbench.getSnapshot().project).toBeNull();
    expect(workbench.getSnapshot().projects).toHaveLength(1);
    expect(store.adapter.getWorkflow).not.toHaveBeenCalled();
  });

  it('loads a preferred project instead of the first one', async () => {
    const extra = project({ id: 'research_2', title: '第二项目', currentStage: 'reading' });
    const store = createStore({ extraProjects: [extra] });
    store.setProjectState('research_2', {
      workflow: workflow({ projectId: 'research_2', stage: 'reading', status: 'ready', artifactIds: [] }),
      events: [],
      runs: [],
      artifacts: [],
      indexStatus: indexStatus({ projectId: 'research_2' })
    });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_2');
    expect(workbench.getSnapshot().project?.id).toBe('research_2');
    expect(store.adapter.getWorkflow).toHaveBeenCalledWith({ id: 'research_2' });
  });

  it('does not notify when a refresh returns the same project data', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    const seen = vi.fn();
    workbench.subscribe(seen);
    await workbench.refresh();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(workbench.getSnapshot().working).toBe(false);
  });

  it('treats undefined, holes and non-finite numbers as different snapshot data', () => {
    expect(sameSnapshotData({ id: 'research_1' }, { id: 'research_1' })).toBe(true);
    expect(sameSnapshotData({ description: undefined }, {})).toBe(false);
    expect(sameSnapshotData([undefined], [null])).toBe(false);
    const hole: unknown[] = [];
    hole.length = 1;
    expect(sameSnapshotData(hole, [undefined])).toBe(false);
    expect(sameSnapshotData(Number.NaN, null)).toBe(false);
    expect(sameSnapshotData(Number.POSITIVE_INFINITY, null)).toBe(false);
  });

  it('keeps instruction draft across refresh and resets it on project switch', async () => {
    const store = createStore({ extraProjects: [project({ id: 'research_2', title: '第二项目' })] });
    store.setProjectState('research_2', {
      workflow: workflow({ projectId: 'research_2' }),
      events: [],
      runs: [],
      artifacts: [],
      indexStatus: indexStatus({ projectId: 'research_2' })
    });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    workbench.setInstruction('写出可追溯的检索策略。');
    await workbench.refresh();
    expect(workbench.getSnapshot().instruction).toBe('写出可追溯的检索策略。');
    await workbench.selectProject('research_2');
    expect(workbench.getSnapshot().project?.id).toBe('research_2');
    expect(workbench.getSnapshot().instruction).toBe('');
  });

  it('returns a copy from getSnapshot', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    const first = workbench.getSnapshot();
    first.instruction = 'mutated';
    first.projects.pop();
    expect(workbench.getSnapshot().instruction).toBe('');
    expect(workbench.getSnapshot().projects).toHaveLength(1);
  });

  it('creates a project, selects it, and refreshes', async () => {
    const store = createStore({ projects: [] });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load();
    expect(workbench.getSnapshot().project).toBeNull();
    await workbench.createProject({
      title: '证据图',
      description: '把想法变成可追溯项目。',
      workspacePath: '/tmp/roc',
      language: 'zh'
    });
    const snapshot = workbench.getSnapshot();
    expect(snapshot.project?.title).toBe('证据图');
    expect(snapshot.workflow?.projectId).toBe(snapshot.project?.id);
    expect(store.adapter.createProject).toHaveBeenCalledWith({
      title: '证据图',
      description: '把想法变成可追溯项目。',
      workspacePath: '/tmp/roc',
      language: 'zh'
    });
  });

  it('rejects empty title and description without calling the adapter', async () => {
    const store = createStore({ projects: [] });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load();
    await workbench.createProject({ title: '  ', description: '目标', workspacePath: '/tmp/roc', language: 'zh' });
    expect(workbench.getSnapshot().error).toBe('项目标题和研究目标不能为空。');
    expect(store.adapter.createProject).not.toHaveBeenCalled();
  });

  it('rejects a missing workspace directory without calling the adapter', async () => {
    const store = createStore({ projects: [] });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load();
    await workbench.createProject({ title: '证据图', description: '把想法变成可追溯项目。', workspacePath: '  ', language: 'zh' });
    expect(workbench.getSnapshot().error).toBe('请选择工作目录。');
    expect(store.adapter.createProject).not.toHaveBeenCalled();
  });

  it('binds a workspace directory onto the current project', async () => {
    const store = createStore({ projects: [project({ workspacePath: null })] });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    await workbench.bindWorkspace('/tmp/bound-workspace');
    expect(store.adapter.updateProject).toHaveBeenCalledWith({
      id: 'research_1',
      workspacePath: '/tmp/bound-workspace'
    });
    expect(workbench.getSnapshot().project?.workspacePath).toBe('/tmp/bound-workspace');
  });

  it('deletes the current project without touching the disk path', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    await workbench.deleteProject('research_1');
    expect(store.adapter.deleteProject).toHaveBeenCalledWith({ id: 'research_1' });
    expect(workbench.getSnapshot().project).toBeNull();
    expect(workbench.getSnapshot().projects).toHaveLength(0);
  });

  it('starts a run with generated requestId and expectedStage from the snapshot', async () => {
    const store = createStore({
      workflow: workflow({ status: 'running', gateRequired: false, artifactIds: [] })
    });
    const workbench = createResearchWorkbench(store.adapter, { createId: () => 'req_fixed' });
    await workbench.load('research_1');
    workbench.setInstruction('写出可追溯的检索策略。');
    await workbench.startRun();
    expect(store.adapter.startStageRun).toHaveBeenCalledWith({
      projectId: 'research_1',
      expectedStage: 'writing',
      instruction: '写出可追溯的检索策略。',
      requestId: 'req_fixed'
    });
    expect(workbench.getSnapshot().runs[0]?.status).toBe('queued');
    expect(workbench.getSnapshot().error).toBeNull();
  });

  it('uses the research goal when the stage instruction is empty', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter, { createId: () => 'req_goal' });
    await workbench.load('research_1');
    await workbench.startRun();
    expect(store.adapter.startStageRun).toHaveBeenCalledWith({
      projectId: 'research_1',
      expectedStage: 'writing',
      instruction: '把想法变成可追溯项目。',
      requestId: 'req_goal'
    });
    expect(workbench.getSnapshot().error).toBeNull();
  });

  it('cancels the latest queued parent run', async () => {
    const queued = run({ status: 'queued' });
    const store = createStore({
      workflow: workflow({ status: 'running', gateRequired: false, artifactIds: [], activeRunId: queued.id }),
      runs: [queued]
    });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    await workbench.cancelRun();
    expect(store.adapter.cancelStageRun).toHaveBeenCalledWith({ projectId: 'research_1', runId: 'run_1' });
  });

  it('retries the latest failed parent run with a generated requestId', async () => {
    const failed = run({ status: 'failed' });
    const store = createStore({
      workflow: workflow({ status: 'failed', gateRequired: false, artifactIds: [] }),
      runs: [failed]
    });
    const workbench = createResearchWorkbench(store.adapter, { createId: () => 'retry_fixed' });
    await workbench.load('research_1');
    await workbench.retryRun();
    expect(store.adapter.retryStageRun).toHaveBeenCalledWith({
      projectId: 'research_1',
      runId: 'run_1',
      requestId: 'retry_fixed'
    });
  });

  it('fills expectedStage on transition and move', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    await workbench.transition('approve', { reviewDecision: 'accept' });
    expect(store.adapter.transitionWorkflow).toHaveBeenCalledWith({
      projectId: 'research_1',
      action: 'approve',
      expectedStage: 'writing',
      reviewDecision: 'accept'
    });
    await workbench.transition('move', { targetStage: 'ideation' });
    expect(store.adapter.transitionWorkflow).toHaveBeenCalledWith({
      projectId: 'research_1',
      action: 'move',
      expectedStage: 'writing',
      targetStage: 'ideation'
    });
  });

  it('controls the index using snapshot revision and null fileId on retry', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    await workbench.controlIndex('rebuild');
    expect(store.adapter.controlIndex).toHaveBeenCalledWith({
      projectId: 'research_1',
      action: 'rebuild',
      expectedRevision: 1
    });
    await workbench.controlIndex('retry');
    expect(store.adapter.controlIndex).toHaveBeenCalledWith({
      projectId: 'research_1',
      action: 'retry',
      expectedRevision: 1,
      fileId: null
    });
    expect(workbench.getSnapshot().indexStatus?.phase).toBe('queued');
  });

  it('rejects a second command while working', async () => {
    const store = createStore();
    let release: (() => void) | undefined;
    store.adapter.transitionWorkflow.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(workflow({ status: 'completed', gateApproved: true }));
    }));
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    const pending = workbench.transition('approve', { reviewDecision: 'accept' });
    await Promise.resolve();
    expect(workbench.getSnapshot().working).toBe(true);
    await workbench.startRun();
    expect(workbench.getSnapshot().error).toBe('当前命令仍在进行。');
    expect(store.adapter.startStageRun).not.toHaveBeenCalled();
    release?.();
    await pending;
    expect(workbench.getSnapshot().working).toBe(false);
  });

  it('refreshes after a failed command and keeps the error', async () => {
    const store = createStore();
    store.adapter.startStageRun.mockRejectedValueOnce(new Error('阶段角色启动失败。'));
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    workbench.setInstruction('写出可追溯的检索策略。');
    const before = store.adapter.getWorkflow.mock.calls.length;
    await workbench.startRun();
    expect(workbench.getSnapshot().error).toBe('阶段角色启动失败。');
    expect(store.adapter.getWorkflow.mock.calls.length).toBeGreaterThan(before);
  });

  it('drops a stale response after switching projects', async () => {
    const extra = project({ id: 'research_2', title: '第二项目' });
    const store = createStore({ extraProjects: [extra] });
    store.setProjectState('research_2', {
      workflow: workflow({ projectId: 'research_2' }),
      events: [],
      runs: [],
      artifacts: [],
      indexStatus: indexStatus({ projectId: 'research_2' })
    });
    let release: ((value: ResearchWorkflowSnapshot) => void) | undefined;
    store.adapter.getWorkflow.mockImplementation(async (request: { id: string }) => {
      if (request.id === 'research_1' && store.adapter.getWorkflow.mock.calls.length > 1) {
        return await new Promise<ResearchWorkflowSnapshot>((resolve) => {
          release = resolve;
        });
      }
      return store.workflowFor(request.id);
    });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load('research_1');
    const stale = workbench.refresh();
    await workbench.selectProject('research_2');
    expect(workbench.getSnapshot().project?.id).toBe('research_2');
    release?.(workflow({ status: 'failed' }));
    await stale;
    expect(workbench.getSnapshot().project?.id).toBe('research_2');
    expect(workbench.getSnapshot().workflow?.stages.find((stage) => stage.stage === 'writing')?.status).not.toBe('failed');
  });

  it('errors when a command runs without a current project', async () => {
    const store = createStore({ projects: [] });
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load();
    await workbench.transition('start');
    expect(workbench.getSnapshot().error).toBe('请先选择研究项目。');
    expect(store.adapter.transitionWorkflow).not.toHaveBeenCalled();
  });

  it('notifies subscribers only when the snapshot changes', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    const seen: string[] = [];
    const stop = workbench.subscribe((snapshot) => {
      seen.push(`${snapshot.loading}:${snapshot.instruction}:${snapshot.project?.id ?? 'none'}`);
    });
    await workbench.load();
    workbench.setInstruction('写出可追溯的检索策略。');
    workbench.setInstruction('写出可追溯的检索策略。');
    stop();
    workbench.setInstruction('另一条');
    expect(seen.some((entry) => entry.includes('写出可追溯的检索策略。'))).toBe(true);
    expect(seen.filter((entry) => entry.includes('写出可追溯的检索策略。'))).toHaveLength(1);
    expect(seen.some((entry) => entry.includes('另一条'))).toBe(false);
  });

  it('keeps the previous project list when load fails', async () => {
    const store = createStore();
    const workbench = createResearchWorkbench(store.adapter);
    await workbench.load();
    store.adapter.listProjects.mockRejectedValueOnce(new Error('科研项目加载失败。'));
    await workbench.load();
    expect(workbench.getSnapshot().projects).toHaveLength(1);
    expect(workbench.getSnapshot().error).toBe('科研项目加载失败。');
    expect(workbench.getSnapshot().loading).toBe(false);
  });
});

type StoreState = {
  workflow: ResearchWorkflowSnapshot;
  events: ResearchWorkflowEvent[];
  runs: ResearchStageRun[];
  artifacts: ResearchArtifact[];
  indexStatus: ResearchIndexStatus;
};

function createStore(overrides: {
  projects?: ResearchProject[];
  extraProjects?: ResearchProject[];
  workflow?: ResearchWorkflowSnapshot;
  events?: ResearchWorkflowEvent[];
  runs?: ResearchStageRun[];
  artifacts?: ResearchArtifact[];
  indexStatus?: ResearchIndexStatus;
} = {}) {
  const initial = project();
  const projects = [...(overrides.projects ?? [initial]), ...(overrides.extraProjects ?? [])];
  const states = new Map<string, StoreState>();
  for (const item of projects) {
    states.set(item.id, {
      workflow: overrides.workflow ?? workflow({ projectId: item.id }),
      events: overrides.events ?? [event('approval_requested', '阶段产物等待用户审核。')],
      runs: overrides.runs ?? [],
      artifacts: overrides.artifacts ?? [artifact()],
      indexStatus: overrides.indexStatus ?? indexStatus()
    });
  }

  const adapter: ResearchWorkbenchAdapter & {
    listProjects: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn>;
    updateProject: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
    getWorkflow: ReturnType<typeof vi.fn>;
    listWorkflowEvents: ReturnType<typeof vi.fn>;
    listStageRuns: ReturnType<typeof vi.fn>;
    listArtifacts: ReturnType<typeof vi.fn>;
    getIndexStatus: ReturnType<typeof vi.fn>;
    transitionWorkflow: ReturnType<typeof vi.fn>;
    startStageRun: ReturnType<typeof vi.fn>;
    cancelStageRun: ReturnType<typeof vi.fn>;
    retryStageRun: ReturnType<typeof vi.fn>;
    controlIndex: ReturnType<typeof vi.fn>;
  } = {
    listProjects: vi.fn(async () => [...projects]),
    createProject: vi.fn(async (request: { title: string; description: string; workspacePath: string; language?: 'zh' | 'en' }) => {
      const created = project({
        id: `research_${projects.length + 1}`,
        title: request.title,
        description: request.description,
        workspacePath: request.workspacePath,
        language: request.language ?? 'zh'
      });
      projects.unshift(created);
      states.set(created.id, {
        workflow: workflow({ projectId: created.id, stage: 'discovery', status: 'ready', gateRequired: false, artifactIds: [] }),
        events: [],
        runs: [],
        artifacts: [],
        indexStatus: indexStatus({ projectId: created.id })
      });
      return created;
    }),
    updateProject: vi.fn(async (request: { id: string; workspacePath: string }) => {
      const current = projects.find((item) => item.id === request.id);
      if (current === undefined) throw new Error('research_project_not_found');
      const updated = { ...current, workspacePath: request.workspacePath };
      const index = projects.findIndex((item) => item.id === request.id);
      projects[index] = updated;
      return updated;
    }),
    deleteProject: vi.fn(async (request: { id: string }) => {
      const index = projects.findIndex((item) => item.id === request.id);
      if (index >= 0) projects.splice(index, 1);
      states.delete(request.id);
      return { id: request.id, deleted: true as const };
    }),
    getWorkflow: vi.fn(async (request: { id: string }) => states.get(request.id)!.workflow),
    listWorkflowEvents: vi.fn(async (request: { projectId: string }) => states.get(request.projectId)!.events),
    listStageRuns: vi.fn(async (request: { projectId: string }) => states.get(request.projectId)!.runs),
    listArtifacts: vi.fn(async (request: { projectId: string }) => states.get(request.projectId)!.artifacts),
    getIndexStatus: vi.fn(async (request: { projectId: string }) => states.get(request.projectId)!.indexStatus),
    transitionWorkflow: vi.fn(async (request: { projectId: string; action: string; expectedStage: string; targetStage?: string; reviewDecision?: 'accept' | 'revise' }) => {
      const current = states.get(request.projectId)!;
      const nextStage = request.action === 'move' && request.targetStage !== undefined
        ? request.targetStage as ResearchWorkflowSnapshot['currentStage']
        : current.workflow.currentStage;
      const next = workflow({
        projectId: request.projectId,
        stage: nextStage,
        status: request.action === 'approve' ? 'completed' : request.action === 'move' ? 'ready' : current.workflow.stages.find((stage) => stage.stage === nextStage)?.status,
        gateApproved: request.action === 'approve',
        artifactIds: request.action === 'move' ? [] : current.artifacts.map((item) => item.id)
      });
      current.workflow = next;
      return next;
    }),
    startStageRun: vi.fn(async (request: { projectId: string; instruction: string; requestId: string }) => {
      const started = run({ instruction: request.instruction, requestId: request.requestId, status: 'queued' });
      states.get(request.projectId)!.runs = [started, ...states.get(request.projectId)!.runs];
      return started;
    }),
    cancelStageRun: vi.fn(async (request: { projectId: string; runId: string }) => {
      const current = states.get(request.projectId)!;
      current.runs = current.runs.map((item) => item.id === request.runId ? { ...item, status: 'cancelled' as const } : item);
      return current.runs.find((item) => item.id === request.runId)!;
    }),
    retryStageRun: vi.fn(async (request: { projectId: string; runId: string; requestId: string }) => {
      const started = run({ id: 'run_retry', requestId: request.requestId, retryOfRunId: request.runId, status: 'queued' });
      states.get(request.projectId)!.runs = [started, ...states.get(request.projectId)!.runs];
      return started;
    }),
    controlIndex: vi.fn(async (request: { projectId: string; action: string }) => {
      const current = states.get(request.projectId)!;
      current.indexStatus = indexStatus({
        projectId: request.projectId,
        phase: request.action === 'pause' ? 'paused' : 'queued',
        paused: request.action === 'pause'
      });
      return current.indexStatus;
    })
  };

  return {
    adapter,
    setProjectState(id: string, state: StoreState) {
      states.set(id, state);
    },
    workflowFor(id: string) {
      return states.get(id)!.workflow;
    }
  };
}

function project(overrides: Partial<ResearchProject> = {}): ResearchProject {
  return {
    id: 'research_1', title: '证据图', description: '把想法变成可追溯项目。', workspacePath: '/tmp/research-workbench.test-1',
    status: 'active', language: 'zh', origin: null, currentStage: 'writing',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z',
    ...overrides
  };
}

function workflow(stage: Partial<ResearchWorkflowSnapshot['stages'][number]> & { projectId?: string } = {}): ResearchWorkflowSnapshot {
  const names = ['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'revision', 'export'] as const;
  const current = {
    stage: 'writing' as const, status: 'waiting_approval' as const, activeRunId: null, artifactIds: ['artifact_1'],
    enteredAt: '2026-09-14T00:30:00.000Z', completedAt: null, gateRequired: true, gateApproved: false, lastError: null, ...stage
  };
  const projectId = stage.projectId ?? 'research_1';
  return {
    projectId, currentStage: current.stage, projectStatus: 'active',
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

function run(overrides: Partial<ResearchStageRun> = {}): ResearchStageRun {
  return {
    id: 'run_1', projectId: 'research_1', stage: 'writing', requestId: 'req_1', parentRunId: null, retryOfRunId: null,
    reviewCycleId: null, revisionRound: 0, role: 'academic-writing-agent', outputKind: 'manuscript', status: 'queued',
    instruction: '写出可追溯的检索策略。', skillIds: ['roc-academic-writing'], skillHash: 'a'.repeat(64), toolNames: [],
    inputArtifactIds: [], outputArtifactIds: [], policy: { projectId: 'research_1', stage: 'writing', tier: 'deep', model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000 },
    providerId: null, modelId: null, modelVersion: null, error: null, createdAt: '2026-09-14T01:10:00.000Z', startedAt: null, endedAt: null,
    ...overrides
  };
}

function indexStatus(overrides: Partial<ResearchIndexStatus> & { paused?: boolean; phase?: ResearchIndexStatus['phase']; projectId?: string } = {}): ResearchIndexStatus {
  const phase = overrides.phase ?? 'idle';
  const paused = overrides.paused ?? false;
  const projectId = overrides.projectId ?? 'research_1';
  return {
    settings: {
      projectId, revision: paused ? 2 : 1, kinds: ['markdown', 'latex', 'bibliography', 'csv', 'pdf', 'image'],
      include: ['**/*'], exclude: ['**/node_modules/**'], watch: true, paused, embeddingConfigId: null
    },
    generation: 1, workspacePath: '/tmp/roc', phase, error: null, lastScanAt: '2026-09-14T01:00:00.000Z',
    counts: { total: 2, queued: 0, running: 0, ready: 2, failed: 0 },
    ...overrides
  };
}
