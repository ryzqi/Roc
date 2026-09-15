import type { ResearchExperimentExecution, ResearchExperimentFileContent, ResearchExperimentRuntime } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { emptyExperimentDraft, type ResearchExperimentDraft } from './ResearchExperimentPanel';
import { createProjectionController } from './research-projection';

export type ResearchExperimentAdapter = {
  list(request: { projectId: string; limit: number }): Promise<ResearchExperimentExecution[]>;
  inspect(request: { projectId: string; runtime: ResearchExperimentRuntime }): Promise<{ hash: string }>;
  start(request: ResearchExperimentExecution['request'] & { projectId: string }): Promise<ResearchExperimentExecution>;
  cancel(request: { projectId: string; runId: string }): Promise<unknown>;
  publish(request: { projectId: string; runId: string }): Promise<unknown>;
  publishFigure(request: { projectId: string; runId: string; replacesFigureId: null }): Promise<unknown>;
  get(request: { projectId: string; runId: string }): Promise<ResearchExperimentExecution>;
  readFile(request: { projectId: string; runId: string; area: ResearchExperimentExecution['files'][number]['area']; path: string }): Promise<ResearchExperimentFileContent>;
};

export type ResearchExperimentSnapshot = {
  experiments: ResearchExperimentExecution[];
  draft: ResearchExperimentDraft;
  selectedRunId: string | null;
  log: ResearchExperimentFileContent | null;
  working: boolean;
  error: string | null;
};

export type ResearchExperimentProjection = {
  getSnapshot(): ResearchExperimentSnapshot;
  subscribe(listener: (snapshot: ResearchExperimentSnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setDraft(draft: ResearchExperimentDraft): void;
  select(runId: string): void;
  load(): Promise<void>;
  start(): Promise<void>;
  cancel(runId: string): Promise<void>;
  publish(runId: string): Promise<void>;
  publishFigure(runId: string): Promise<void>;
  readLog(runId: string): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchExperimentSnapshot => ({
  experiments: [],
  draft: emptyExperimentDraft,
  selectedRunId: null,
  log: null,
  working: false,
  error: null
});

function parseRelativePaths(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function experimentRuntime(draft: ResearchExperimentDraft): ResearchExperimentRuntime {
  if (draft.engine === 'r') {
    return { kind: 'renv', rootPath: draft.rRootPath.trim(), libraryPath: draft.rLibraryPath.trim() };
  }
  if (draft.engine === 'julia') {
    return { kind: 'julia', rootPath: draft.juliaRootPath.trim(), depotPath: draft.juliaDepotPath.trim() };
  }
  return { kind: draft.runtimeKind === 'uv' ? 'uv' : 'bundled-python' };
}

export function createResearchExperimentProjection(
  adapter: ResearchExperimentAdapter,
  options: { createId?: () => string } = {}
): ResearchExperimentProjection {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const projection = createProjectionController<ResearchExperimentSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, experiments: [...value.experiments], draft: { ...value.draft } };
    }
  });
  let projectId: string | null = null;

  async function load(token: number): Promise<void> {
    if (projectId === null) {
      projection.assign({ experiments: [], selectedRunId: null, log: null });
      return;
    }
    const experiments = await adapter.list({ projectId, limit: 100 });
    if (!projection.isCurrent(token)) return;
    projection.assign({ experiments });
  }

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) { projectId = next; },
    setDraft(draft) { projection.assign({ draft }); },
    select(runId) { projection.assign({ selectedRunId: runId }); },
    async load() {
      await projection.runExclusive(async (token) => { await load(token); }, { busy: '当前命令仍在进行。', failed: '实验运行加载失败。' });
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
      if (draft.engine === 'matplotlib') {
        const widthInches = Number(draft.widthInches);
        const heightInches = Number(draft.heightInches);
        const dpi = Number(draft.dpi);
        const seed = Number(draft.seed);
        if (
          !Number.isFinite(widthInches) || widthInches < 1 || widthInches > 24
          || !Number.isFinite(heightInches) || heightInches < 1 || heightInches > 24
          || !Number.isInteger(dpi) || dpi < 72 || dpi > 1200
          || !Number.isInteger(seed) || seed < 0 || seed > 4294967295
        ) {
          projection.fail('图稿尺寸需在 1–24 英寸，DPI 72–1200，随机种子为非负整数。');
          return;
        }
      }
      await projection.runExclusive(async (token) => {
        const runtime = experimentRuntime(draft);
        const environment = await adapter.inspect({ projectId: currentProjectId, runtime });
        const figure = draft.engine === 'matplotlib' ? {
          widthInches: Number(draft.widthInches),
          heightInches: Number(draft.heightInches),
          dpi: Number(draft.dpi),
          seed: Number(draft.seed)
        } : undefined;
        const started = await adapter.start({
          projectId: currentProjectId,
          requestId: createId(),
          label: draft.label.trim() || sourcePath,
          engine: draft.engine,
          runtime,
          sourcePath,
          inputPaths: parseRelativePaths(draft.inputPaths),
          arguments: [],
          parameters: {},
          expectedEnvironmentHash: environment.hash,
          timeoutMs,
          network: draft.engine === 'matplotlib' ? 'disabled' : draft.network,
          ...(figure === undefined ? {} : { figure })
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ selectedRunId: started.id, log: null });
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '实验启动失败。' });
    },
    async cancel(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.cancel({ projectId: currentProjectId, runId });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '取消实验失败。' });
    },
    async publish(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.publish({ projectId: currentProjectId, runId });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '发布实验失败。' });
    },
    async publishFigure(runId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.publishFigure({ projectId: currentProjectId, runId, replacesFigureId: null });
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
      }, { busy: '当前命令仍在进行。', failed: '读取实验日志失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchExperimentAdapter(client: RocClient): ResearchExperimentAdapter {
  const research = client.api.research;
  return {
    async list(request) { return unwrap('实验运行', await research.listExperiments(request)); },
    async inspect(request) { return unwrap('实验环境', await research.inspectExperimentEnvironment(request)); },
    async start(request) { return unwrap('启动实验', await research.startExperiment(request)); },
    async cancel(request) { return unwrap('取消实验', await research.cancelExperiment(request)); },
    async publish(request) { return unwrap('发布实验', await research.publishExperiment(request)); },
    async publishFigure(request) { return unwrap('发布图稿', await research.publishFigure(request)); },
    async get(request) { return unwrap('实验运行', await research.getExperiment(request)); },
    async readFile(request) { return unwrap('实验日志', await research.readExperimentFile(request)); }
  };
}
