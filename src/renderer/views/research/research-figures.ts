import type { ResearchExperimentFileContent, ResearchFigureRun } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { emptyFigureDraft, type ResearchFigureDraft } from './ResearchFigurePanel';
import { createProjectionController } from './research-projection';

export type ResearchFigureAdapter = {
  list(request: { projectId: string; limit: number }): Promise<ResearchFigureRun[]>;
  start(request: {
    projectId: string;
    requestId: string;
    label: string;
    runtime: { kind: 'bundled-python' | 'uv' };
    sourcePath: string;
    inputPaths: string[];
    arguments: string[];
    parameters: Record<string, string>;
    timeoutMs: number;
    figure: { widthInches: number; heightInches: number; dpi: number; seed: number };
  }): Promise<ResearchFigureRun>;
  cancel(request: { projectId: string; runId: string }): Promise<unknown>;
  publish(request: { projectId: string; runId: string; replacesFigureId: null }): Promise<unknown>;
  get(request: { projectId: string; runId: string }): Promise<ResearchFigureRun>;
  readFile(request: { projectId: string; runId: string; area: ResearchFigureRun['files'][number]['area']; path: string }): Promise<ResearchExperimentFileContent>;
};

export type ResearchFigureSnapshot = {
  runs: ResearchFigureRun[];
  draft: ResearchFigureDraft;
  selectedRunId: string | null;
  log: ResearchExperimentFileContent | null;
  working: boolean;
  error: string | null;
};

export type ResearchFigureProjection = {
  getSnapshot(): ResearchFigureSnapshot;
  subscribe(listener: (snapshot: ResearchFigureSnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setDraft(draft: ResearchFigureDraft): void;
  select(runId: string): void;
  load(): Promise<void>;
  start(): Promise<void>;
  cancel(runId: string): Promise<void>;
  publish(runId: string): Promise<void>;
  readLog(runId: string): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchFigureSnapshot => ({
  runs: [],
  draft: emptyFigureDraft,
  selectedRunId: null,
  log: null,
  working: false,
  error: null
});

function parseRelativePaths(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function figureOptions(draft: ResearchFigureDraft) {
  return {
    widthInches: Number(draft.widthInches) || 6,
    heightInches: Number(draft.heightInches) || 4,
    dpi: Number(draft.dpi) || 150,
    seed: Number(draft.seed) || 1
  };
}

export function createResearchFigureProjection(
  adapter: ResearchFigureAdapter,
  options: { createId?: () => string } = {}
): ResearchFigureProjection {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const projection = createProjectionController<ResearchFigureSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, runs: [...value.runs], draft: { ...value.draft } };
    }
  });
  let projectId: string | null = null;

  async function load(token: number): Promise<void> {
    if (projectId === null) {
      projection.assign({ runs: [], selectedRunId: null, log: null });
      return;
    }
    const runs = await adapter.list({ projectId, limit: 100 });
    if (!projection.isCurrent(token)) return;
    projection.assign({ runs });
  }

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) { projectId = next; },
    setDraft(draft) { projection.assign({ draft }); },
    select(runId) { projection.assign({ selectedRunId: runId }); },
    async load() {
      await projection.runExclusive(async (token) => { await load(token); }, { busy: '当前命令仍在进行。', failed: '图稿运行加载失败。' });
    },
    async start() {
      if (projectId === null) return;
      const currentProjectId = projectId;
      const draft = projection.peek().draft;
      const sourcePath = draft.sourcePath.trim();
      const timeoutMs = Number(draft.timeoutMs);
      if (sourcePath.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
        projection.fail('源文件必须填写，超时需在 1000 到 3600000 毫秒之间。');
        return;
      }
      await projection.runExclusive(async (token) => {
        const started = await adapter.start({
          projectId: currentProjectId,
          requestId: createId(),
          label: draft.label.trim() || sourcePath,
          runtime: { kind: draft.runtimeKind },
          sourcePath,
          inputPaths: parseRelativePaths(draft.inputPaths),
          arguments: [],
          parameters: {},
          timeoutMs,
          figure: figureOptions(draft)
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ selectedRunId: started.id, log: null });
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '图稿启动失败。' });
    },
    async cancel(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.cancel({ projectId: currentProjectId, runId });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '取消图稿失败。' });
    },
    async publish(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.publish({ projectId: currentProjectId, runId, replacesFigureId: null });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '发布图稿失败。' });
    },
    async readLog(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        const run = await adapter.get({ projectId: currentProjectId, runId });
        const logFile = run.files.find((file) => file.area === 'log' && file.path === 'stdout.txt')
          ?? run.files.find((file) => file.area === 'log' && file.path === 'stderr.txt')
          ?? run.files.find((file) => file.area === 'log');
        if (logFile === undefined) {
          throw new Error('这次运行还没有日志。');
        }
        const log = await adapter.readFile({ projectId: currentProjectId, runId, area: logFile.area, path: logFile.path });
        if (!projection.isCurrent(token)) return;
        projection.assign({ selectedRunId: runId, log });
      }, { busy: '当前命令仍在进行。', failed: '读取图稿日志失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchFigureAdapter(client: RocClient): ResearchFigureAdapter {
  const research = client.api.research;
  return {
    async list(request) { return unwrap('图稿运行', await research.listFigureRuns(request)); },
    async start(request) { return unwrap('启动图稿', await research.startFigure(request)); },
    async cancel(request) { return unwrap('取消图稿', await research.cancelFigure(request)); },
    async publish(request) { return unwrap('发布图稿', await research.publishFigure(request)); },
    async get(request) { return unwrap('图稿运行', await research.getFigureRun(request)); },
    async readFile(request) { return unwrap('图稿日志', await research.readFigureFile(request)); }
  };
}
