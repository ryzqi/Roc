import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';

export type ResearchWorkbenchAdapter = {
  listProjects(): Promise<ResearchProject[]>;
  createProject(request: { title: string; description: string; workspacePath: string | null; language?: 'zh' | 'en' }): Promise<ResearchProject>;
  getWorkflow(request: { id: string }): Promise<ResearchWorkflowSnapshot>;
  listWorkflowEvents(request: { projectId: string; limit: number }): Promise<ResearchWorkflowEvent[]>;
  listStageRuns(request: { projectId: string; limit: number }): Promise<ResearchStageRun[]>;
  listArtifacts(request: { projectId: string }): Promise<ResearchArtifact[]>;
  getIndexStatus(request: { projectId: string }): Promise<ResearchIndexStatus>;
  transitionWorkflow(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  startStageRun(request: { projectId: string; expectedStage: ResearchWorkflowSnapshot['currentStage']; instruction: string; requestId: string }): Promise<ResearchStageRun>;
  cancelStageRun(request: { projectId: string; runId: string }): Promise<ResearchStageRun>;
  retryStageRun(request: { projectId: string; runId: string; requestId: string }): Promise<ResearchStageRun>;
  controlIndex(request:
    | { projectId: string; action: 'pause' | 'resume' | 'rebuild'; expectedRevision: number }
    | { projectId: string; action: 'retry'; expectedRevision: number; fileId: null }
  ): Promise<ResearchIndexStatus>;
};

export type ResearchWorkbenchSnapshot = {
  projects: ResearchProject[];
  project: ResearchProject | null;
  workflow: ResearchWorkflowSnapshot | null;
  events: ResearchWorkflowEvent[];
  runs: ResearchStageRun[];
  artifacts: ResearchArtifact[];
  indexStatus: ResearchIndexStatus | null;
  instruction: string;
  loading: boolean;
  working: boolean;
  error: string | null;
};

export type ResearchWorkbench = {
  getSnapshot(): ResearchWorkbenchSnapshot;
  subscribe(listener: (snapshot: ResearchWorkbenchSnapshot) => void): () => void;
  load(): Promise<void>;
  selectProject(projectId: string): Promise<void>;
  createProject(request: { title: string; description: string; workspacePath: string | null; language?: 'zh' | 'en' }): Promise<void>;
  refresh(): Promise<void>;
  setInstruction(value: string): void;
  transition(action: ResearchWorkflowTransitionRequest['action'], options?: { targetStage?: ResearchWorkflowSnapshot['currentStage']; reviewDecision?: 'accept' | 'revise' }): Promise<void>;
  startRun(): Promise<void>;
  cancelRun(): Promise<void>;
  retryRun(): Promise<void>;
  controlIndex(action: 'pause' | 'resume' | 'rebuild' | 'retry'): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchWorkbenchSnapshot => ({
  projects: [],
  project: null,
  workflow: null,
  events: [],
  runs: [],
  artifacts: [],
  indexStatus: null,
  instruction: '',
  loading: false,
  working: false,
  error: null
});

export function createResearchWorkbench(
  adapter: ResearchWorkbenchAdapter,
  options: { createId?: () => string } = {}
): ResearchWorkbench {
  const createId = options.createId ?? (() => crypto.randomUUID());
  let snapshot = emptySnapshot();
  let generation = 0;
  const listeners = new Set<(snapshot: ResearchWorkbenchSnapshot) => void>();

  function copy(value: ResearchWorkbenchSnapshot): ResearchWorkbenchSnapshot {
    return {
      ...value,
      projects: [...value.projects],
      events: [...value.events],
      runs: [...value.runs],
      artifacts: [...value.artifacts]
    };
  }

  function emit(): void {
    const next = copy(snapshot);
    for (const listener of listeners) listener(copy(next));
  }

  function assign(patch: Partial<ResearchWorkbenchSnapshot>): void {
    const next = { ...snapshot, ...patch };
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    emit();
  }

  function fail(message: string): void {
    assign({ error: message, loading: false, working: false });
  }

  async function runExclusive(action: (token: number) => Promise<void>, messages: { busy: string; failed: string }): Promise<void> {
    if (snapshot.working) {
      fail(messages.busy);
      return;
    }
    const token = ++generation;
    assign({ working: true, error: null });
    try {
      await action(token);
      if (token !== generation) return;
      assign({ working: false });
    } catch (error) {
      if (token !== generation) return;
      const message = error instanceof Error ? error.message : messages.failed;
      assign({ working: false, error: message });
      await refreshInternal(token, { keepError: true });
    }
  }

  async function refreshInternal(token: number, flags: { keepError?: boolean; resetInstruction?: boolean } = {}): Promise<void> {
    const projectId = snapshot.project?.id;
    if (projectId === undefined) {
      assign({
        workflow: null,
        events: [],
        runs: [],
        artifacts: [],
        indexStatus: null,
        ...(flags.resetInstruction ? { instruction: '' } : {}),
        ...(flags.keepError ? {} : { error: null })
      });
      return;
    }
    const [workflow, events, runs, artifacts, indexStatus] = await Promise.all([
      adapter.getWorkflow({ id: projectId }),
      adapter.listWorkflowEvents({ projectId, limit: 40 }),
      adapter.listStageRuns({ projectId, limit: 40 }),
      adapter.listArtifacts({ projectId }),
      adapter.getIndexStatus({ projectId })
    ]);
    if (token !== generation) return;
    assign({
      workflow,
      events,
      runs,
      artifacts,
      indexStatus,
      projects: snapshot.projects.map((project) => project.id === projectId
        ? {
          ...project,
          currentStage: workflow.currentStage,
          status: workflow.projectStatus,
          updatedAt: workflow.lastEvent?.createdAt ?? project.updatedAt
        }
        : project),
      project: snapshot.project === null ? null : {
        ...snapshot.project,
        currentStage: workflow.currentStage,
        status: workflow.projectStatus,
        updatedAt: workflow.lastEvent?.createdAt ?? snapshot.project.updatedAt
      },
      ...(flags.resetInstruction ? { instruction: '' } : {}),
      ...(flags.keepError ? {} : { error: null })
    });
  }

  async function selectInternal(projectId: string, token: number): Promise<void> {
    const project = snapshot.projects.find((item) => item.id === projectId) ?? null;
    assign({ project, instruction: '', error: null });
    await refreshInternal(token, { resetInstruction: false });
  }

  return {
    getSnapshot() {
      return copy(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      const token = ++generation;
      assign({ loading: true, error: null });
      try {
        const projects = await adapter.listProjects();
        if (token !== generation) return;
        const currentId = snapshot.project?.id;
        const project = projects.find((item) => item.id === currentId) ?? projects[0] ?? null;
        assign({ projects, project, loading: false, error: null, ...(project?.id === currentId ? {} : { instruction: '' }) });
        if (project !== null) await refreshInternal(token);
      } catch (error) {
        if (token !== generation) return;
        fail(error instanceof Error ? error.message : '科研项目加载失败。');
      }
    },
    async selectProject(projectId) {
      const token = ++generation;
      assign({ working: true, error: null });
      try {
        await selectInternal(projectId, token);
        if (token !== generation) return;
        assign({ working: false });
      } catch (error) {
        if (token !== generation) return;
        fail(error instanceof Error ? error.message : '科研流程加载失败。');
      }
    },
    async createProject(request) {
      if (request.title.trim().length === 0 || request.description.trim().length === 0) {
        fail('项目标题和研究目标不能为空。');
        return;
      }
      await runExclusive(async (token) => {
        const created = await adapter.createProject({
          title: request.title.trim(),
          description: request.description.trim(),
          workspacePath: request.workspacePath,
          language: request.language
        });
        if (token !== generation) return;
        assign({ projects: [created, ...snapshot.projects.filter((item) => item.id !== created.id)], project: created, instruction: '' });
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '科研项目创建失败。' });
    },
    async refresh() {
      await runExclusive(async (token) => {
        if (snapshot.project === null) {
          throw new Error('请先选择研究项目。');
        }
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '科研流程加载失败。' });
    },
    setInstruction(value) {
      assign({ instruction: value });
    },
    clearError() {
      if (snapshot.error !== null) assign({ error: null });
    },
    async transition(action, options = {}) {
      await runExclusive(async (token) => {
        const project = snapshot.project;
        const workflow = snapshot.workflow;
        if (project === null || workflow === null) throw new Error('请先选择研究项目。');
        if (action === 'move') {
          if (options.targetStage === undefined) throw new Error('请选择目标研究阶段。');
          await adapter.transitionWorkflow({
            projectId: project.id,
            action: 'move',
            expectedStage: workflow.currentStage,
            targetStage: options.targetStage
          });
        } else {
          await adapter.transitionWorkflow({
            projectId: project.id,
            action,
            expectedStage: workflow.currentStage,
            note: action === 'reject' ? '请补充证据或修改阶段产物。' : undefined,
            ...(options.reviewDecision === undefined ? {} : { reviewDecision: options.reviewDecision })
          });
        }
        if (token !== generation) return;
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '科研流程更新失败。' });
    },
    async startRun() {
      await runExclusive(async (token) => {
        if (snapshot.instruction.trim().length === 0) {
          throw new Error('阶段指令不能为空。');
        }
        const project = snapshot.project;
        const workflow = snapshot.workflow;
        if (project === null || workflow === null) throw new Error('请先选择研究项目。');
        await adapter.startStageRun({
          projectId: project.id,
          expectedStage: workflow.currentStage,
          instruction: snapshot.instruction.trim(),
          requestId: createId()
        });
        if (token !== generation) return;
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '阶段角色启动失败。' });
    },
    async cancelRun() {
      await runExclusive(async (token) => {
        const project = snapshot.project;
        if (project === null) throw new Error('请先选择研究项目。');
        const run = snapshot.runs.find((item) => item.parentRunId === null && ['queued', 'running'].includes(item.status));
        if (run === undefined) throw new Error('没有可取消的阶段运行。');
        await adapter.cancelStageRun({ projectId: project.id, runId: run.id });
        if (token !== generation) return;
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '取消阶段角色失败。' });
    },
    async retryRun() {
      await runExclusive(async (token) => {
        const project = snapshot.project;
        if (project === null) throw new Error('请先选择研究项目。');
        const run = snapshot.runs.find((item) => item.parentRunId === null && ['failed', 'cancelled', 'interrupted'].includes(item.status));
        if (run === undefined) throw new Error('没有可重试的阶段运行。');
        await adapter.retryStageRun({ projectId: project.id, runId: run.id, requestId: createId() });
        if (token !== generation) return;
        await refreshInternal(token);
      }, { busy: '当前命令仍在进行。', failed: '重试阶段角色失败。' });
    },
    async controlIndex(action) {
      await runExclusive(async (token) => {
        const project = snapshot.project;
        const indexStatus = snapshot.indexStatus;
        if (project === null || indexStatus === null) throw new Error('请先选择研究项目。');
        const next = action === 'retry'
          ? await adapter.controlIndex({
            projectId: project.id,
            action,
            expectedRevision: indexStatus.settings.revision,
            fileId: null
          })
          : await adapter.controlIndex({
            projectId: project.id,
            action,
            expectedRevision: indexStatus.settings.revision
          });
        if (token !== generation) return;
        assign({ indexStatus: next, error: null });
      }, { busy: '当前命令仍在进行。', failed: '索引控制失败。' });
    }
  };
}

function sameSnapshot(left: ResearchWorkbenchSnapshot, right: ResearchWorkbenchSnapshot): boolean {
  return left.loading === right.loading
    && left.working === right.working
    && left.error === right.error
    && left.instruction === right.instruction
    && left.project?.id === right.project?.id
    && left.projects === right.projects
    && left.workflow === right.workflow
    && left.events === right.events
    && left.runs === right.runs
    && left.artifacts === right.artifacts
    && left.indexStatus === right.indexStatus;
}


export function createResearchWorkbenchAdapter(client: RocClient): ResearchWorkbenchAdapter {
  const research = client.api.research;
  return {
    async listProjects() {
      return unwrap('科研项目', await research.listProjects());
    },
    async createProject(request) {
      return unwrap('创建科研项目', await research.createProject(request));
    },
    async getWorkflow(request) {
      return unwrap('科研流程', await research.getWorkflow(request));
    },
    async listWorkflowEvents(request) {
      return unwrap('科研事件', await research.listWorkflowEvents(request));
    },
    async listStageRuns(request) {
      return unwrap('阶段运行', await research.listStageRuns(request));
    },
    async listArtifacts(request) {
      return unwrap('阶段产物', await research.listArtifacts(request));
    },
    async getIndexStatus(request) {
      return unwrap('项目索引', await research.getIndexStatus(request));
    },
    async transitionWorkflow(request) {
      return unwrap('更新科研流程', await research.transitionWorkflow(request));
    },
    async startStageRun(request) {
      return unwrap('启动阶段角色', await research.startStageRun(request));
    },
    async cancelStageRun(request) {
      return unwrap('取消阶段角色', await research.cancelStageRun(request));
    },
    async retryStageRun(request) {
      return unwrap('重试阶段角色', await research.retryStageRun(request));
    },
    async controlIndex(request) {
      return unwrap('控制索引', await research.controlIndex(request));
    }
  };
}

