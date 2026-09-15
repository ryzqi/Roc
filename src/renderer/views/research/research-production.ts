import type { ResearchArtifact, ResearchExportExecution, ResearchFigurePublication } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createProjectionController } from './research-projection';

export type ResearchProductionHost = {
  projectId(): string | null;
  language(): 'zh' | 'en';
  approvedManuscript(): ResearchArtifact | undefined;
};

export type ResearchProductionAdapter = {
  listFigures(request: { projectId: string; limit: number }): Promise<ResearchFigurePublication[]>;
  listExports(request: { projectId: string; limit: number }): Promise<ResearchExportExecution[]>;
  prepare(request: ResearchExportExecution['request'] & { projectId: string }): Promise<unknown>;
  publish(request: { projectId: string; exportId: string; replacesExportId: null }): Promise<unknown>;
  write(request: { projectId: string; exportId: string; destinationPath: string }): Promise<unknown>;
};

export type ResearchProductionSnapshot = {
  figures: ResearchFigurePublication[];
  exports: ResearchExportExecution[];
  selectedFigureIds: string[];
  title: string;
  destinationPath: string;
  working: boolean;
  error: string | null;
};

export type ResearchProductionProjection = {
  getSnapshot(): ResearchProductionSnapshot;
  subscribe(listener: (snapshot: ResearchProductionSnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setTitle(value: string): void;
  setDestination(value: string): void;
  toggleFigure(figureId: string): void;
  load(): Promise<void>;
  prepare(): Promise<void>;
  publish(exportId: string): Promise<void>;
  write(exportId: string): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchProductionSnapshot => ({
  figures: [],
  exports: [],
  selectedFigureIds: [],
  title: '',
  destinationPath: '',
  working: false,
  error: null
});

export function createResearchProductionProjection(
  adapter: ResearchProductionAdapter,
  host: ResearchProductionHost,
  options: { createId?: () => string } = {}
): ResearchProductionProjection {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const projection = createProjectionController<ResearchProductionSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, figures: [...value.figures], exports: [...value.exports], selectedFigureIds: [...value.selectedFigureIds] };
    }
  });
  let projectId: string | null = null;

  async function load(token: number): Promise<void> {
    if (projectId === null) {
      projection.assign({ figures: [], exports: [] });
      return;
    }
    const [figures, listed] = await Promise.all([
      adapter.listFigures({ projectId, limit: 100 }),
      adapter.listExports({ projectId, limit: 40 })
    ]);
    if (!projection.isCurrent(token)) return;
    projection.assign({ figures, exports: listed });
  }

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) { projectId = next; },
    setTitle(value) { projection.assign({ title: value }); },
    setDestination(value) { projection.assign({ destinationPath: value }); },
    toggleFigure(figureId) {
      const selectedFigureIds = projection.peek().selectedFigureIds;
      projection.assign({
        selectedFigureIds: selectedFigureIds.includes(figureId)
          ? selectedFigureIds.filter((id) => id !== figureId)
          : [...selectedFigureIds, figureId]
      });
    },
    async load() {
      await projection.runExclusive(async (token) => { await load(token); }, { busy: '当前命令仍在进行。', failed: '图稿导出加载失败。' });
    },
    async prepare() {
      if (projectId === null) return;
      const currentProjectId = projectId;
      const manuscript = host.approvedManuscript();
      const title = projection.peek().title.trim();
      if (manuscript === undefined || title.length === 0) return;
      await projection.runExclusive(async (token) => {
        await adapter.prepare({
          projectId: currentProjectId,
          requestId: createId(),
          title,
          manuscriptArtifactId: manuscript.id,
          figureIds: projection.peek().selectedFigureIds,
          template: { kind: 'default', language: host.language() }
        });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '准备导出失败。' });
    },
    async publish(exportId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.publish({ projectId: currentProjectId, exportId, replacesExportId: null });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '发布导出失败。' });
    },
    async write(exportId) {
      if (projectId === null || projection.peek().destinationPath.trim().length === 0) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.write({
          projectId: currentProjectId,
          exportId,
          destinationPath: projection.peek().destinationPath.trim()
        });
        if (!projection.isCurrent(token)) return;
        await load(token);
      }, { busy: '当前命令仍在进行。', failed: '保存 ZIP 失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchProductionAdapter(client: RocClient): ResearchProductionAdapter {
  const research = client.api.research;
  return {
    async listFigures(request) { return unwrap('图稿', await research.listFigures(request)); },
    async listExports(request) { return unwrap('导出作业', await research.listExports(request)); },
    async prepare(request) { return unwrap('准备导出', await research.prepareExport(request)); },
    async publish(request) { return unwrap('发布导出', await research.publishExport(request)); },
    async write(request) { return unwrap('保存 ZIP', await research.writeExport(request)); }
  };
}
