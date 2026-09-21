import type { ResearchArtifact, ResearchIdeaCanvas, ResearchIdeaCanvasSaveRequest, ResearchProject } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { canvasToDraft, emptyIdeaDraft } from './ResearchIdeaPanel';
import { createProjectionController } from './research-projection';

export type ResearchIdeaHost = {
  projectId(): string | null;
  currentStage(): string | null;
  stageStatus(stage: 'ideation'): string | undefined;
  moveToIdeation(): Promise<void>;
  startIdeation(): Promise<void>;
  refresh(): Promise<void>;
  selectProject(projectId: string): Promise<void>;
};

export type ResearchIdeaAdapter = {
  createArtifact(request: { projectId: string; stage: 'ideation'; kind: 'idea_canvas'; title: string; path: null }): Promise<ResearchArtifact>;
  get(request: { artifactId: string }): Promise<ResearchIdeaCanvas | null>;
  save(request: ResearchIdeaCanvasSaveRequest): Promise<ResearchIdeaCanvas>;
  promote(request: { artifactId: string; expectedVersion: number; workspacePath: string }): Promise<{ project: ResearchProject }>;
};

export type ResearchIdeaSnapshot = {
  selectedArtifactId: string | null;
  canvas: ResearchIdeaCanvas | null;
  draft: ResearchIdeaCanvasSaveRequest | null;
  working: boolean;
  error: string | null;
};

export type ResearchIdeaProjection = {
  getSnapshot(): ResearchIdeaSnapshot;
  subscribe(listener: (snapshot: ResearchIdeaSnapshot) => void): () => void;
  setDraft(draft: ResearchIdeaCanvasSaveRequest | null): void;
  select(artifactId: string): Promise<void>;
  create(): Promise<void>;
  save(): Promise<void>;
  promote(workspacePath: string): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchIdeaSnapshot => ({
  selectedArtifactId: null,
  canvas: null,
  draft: null,
  working: false,
  error: null
});

export function createResearchIdeaProjection(adapter: ResearchIdeaAdapter, host: ResearchIdeaHost): ResearchIdeaProjection {
  const projection = createProjectionController<ResearchIdeaSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, draft: value.draft === null ? null : { ...value.draft, fields: value.draft.fields.map((field) => ({ ...field, evidenceIds: [...field.evidenceIds] })) } };
    }
  });

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setDraft(draft) { projection.assign({ draft }); },
    async select(artifactId) {
      await projection.runExclusive(async (token) => {
        const canvas = await adapter.get({ artifactId });
        if (!projection.isCurrent(token)) return;
        projection.assign({
          selectedArtifactId: artifactId,
          canvas,
          draft: canvas === null ? emptyIdeaDraft(artifactId) : canvasToDraft(canvas)
        });
      }, { busy: '当前命令仍在进行。', failed: 'Idea Canvas 加载失败。' });
    },
    async create() {
      const projectId = host.projectId();
      if (projectId === null) return;
      await projection.runExclusive(async (token) => {
        if (host.currentStage() !== 'ideation') await host.moveToIdeation();
        if (host.stageStatus('ideation') === 'ready') await host.startIdeation();
        const artifact = await adapter.createArtifact({ projectId, stage: 'ideation', kind: 'idea_canvas', title: 'Idea Canvas', path: null });
        await host.refresh();
        if (!projection.isCurrent(token)) return;
        projection.assign({ selectedArtifactId: artifact.id, canvas: null, draft: emptyIdeaDraft(artifact.id) });
      }, { busy: '当前命令仍在进行。', failed: '创建 Idea Canvas 失败。' });
    },
    async save() {
      const draft = projection.peek().draft;
      if (draft === null) return;
      await projection.runExclusive(async (token) => {
        const saved = await adapter.save(draft);
        await host.refresh();
        if (!projection.isCurrent(token)) return;
        projection.assign({ canvas: saved, draft: canvasToDraft(saved) });
      }, { busy: '当前命令仍在进行。', failed: '保存 Idea Canvas 失败。' });
    },
    async promote(workspacePath) {
      const canvas = projection.peek().canvas;
      if (canvas === null) return;
      if (workspacePath.trim().length === 0) {
        projection.fail('请选择工作目录。');
        return;
      }
      await projection.runExclusive(async (token) => {
        const promoted = await adapter.promote({
          artifactId: canvas.artifactId,
          expectedVersion: canvas.version,
          workspacePath: workspacePath.trim()
        });
        if (!projection.isCurrent(token)) return;
        await host.selectProject(promoted.project.id);
      }, { busy: '当前命令仍在进行。', failed: '晋升 Idea Canvas 失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchIdeaAdapter(client: RocClient): ResearchIdeaAdapter {
  const research = client.api.research;
  return {
    async createArtifact(request) { return unwrap('创建画布', await research.createArtifact(request)); },
    async get(request) { return unwrap('Idea Canvas', await research.getIdeaCanvas(request)); },
    async save(request) { return unwrap('保存画布', await research.saveIdeaCanvas(request)); },
    async promote(request) { return unwrap('晋升画布', await research.promoteIdeaCanvas(request)); }
  };
}
