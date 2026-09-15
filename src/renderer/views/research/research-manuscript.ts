import type { ResearchArtifact, ResearchClaim, ResearchManuscript } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { emptyManuscriptDraft, type ResearchManuscriptDraft } from './ResearchManuscriptPanel';
import { createProjectionController } from './research-projection';

export type ResearchManuscriptHost = {
  projectId(): string | null;
  currentStage(): string | null;
  stageStatus(stage: 'writing'): string | undefined;
  moveToWriting(): Promise<void>;
  startWriting(): Promise<void>;
  refresh(): Promise<void>;
};

export type ResearchManuscriptAdapter = {
  createArtifact(request: { projectId: string; stage: 'writing'; kind: 'manuscript'; title: string; path: null }): Promise<ResearchArtifact>;
  getManuscript(request: { artifactId: string }): Promise<ResearchManuscript | null>;
  listClaims(request: { projectId: string; artifactId: string }): Promise<ResearchClaim[]>;
  createClaim(request: {
    projectId: string;
    artifactId: string;
    subjectType: 'paragraph';
    content: string;
    status: ResearchClaim['status'];
    evidenceIds: string[];
  }): Promise<unknown>;
  saveManuscript(request: { artifactId: string; sections: Array<{ title: string; claimIds: string[] }> }): Promise<ResearchManuscript>;
};

export type ResearchManuscriptSnapshot = {
  selectedArtifactId: string | null;
  manuscript: ResearchManuscript | null;
  claims: ResearchClaim[];
  draft: ResearchManuscriptDraft;
  working: boolean;
  error: string | null;
};

export type ResearchManuscriptProjection = {
  getSnapshot(): ResearchManuscriptSnapshot;
  subscribe(listener: (snapshot: ResearchManuscriptSnapshot) => void): () => void;
  setDraft(draft: ResearchManuscriptDraft): void;
  select(artifactId: string): Promise<void>;
  create(): Promise<void>;
  createClaim(): Promise<void>;
  save(): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchManuscriptSnapshot => ({
  selectedArtifactId: null,
  manuscript: null,
  claims: [],
  draft: emptyManuscriptDraft,
  working: false,
  error: null
});

export function createResearchManuscriptProjection(
  adapter: ResearchManuscriptAdapter,
  host: ResearchManuscriptHost
): ResearchManuscriptProjection {
  const projection = createProjectionController<ResearchManuscriptSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, claims: [...value.claims], draft: { ...value.draft, evidenceIds: [...value.draft.evidenceIds], selectedClaimIds: [...value.draft.selectedClaimIds] } };
    }
  });

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setDraft(draft) { projection.assign({ draft }); },
    async select(artifactId) {
      const projectId = host.projectId();
      if (projectId === null) return;
      await projection.runExclusive(async (token) => {
        const [manuscript, claims] = await Promise.all([
          adapter.getManuscript({ artifactId }),
          adapter.listClaims({ projectId, artifactId })
        ]);
        if (!projection.isCurrent(token)) return;
        projection.assign({
          selectedArtifactId: artifactId,
          manuscript,
          claims,
          draft: {
            ...emptyManuscriptDraft,
            sectionTitle: manuscript?.sections[0]?.title ?? 'Results',
            selectedClaimIds: manuscript?.sections[0]?.claimIds ?? []
          }
        });
      }, { busy: '当前命令仍在进行。', failed: '正文加载失败。' });
    },
    async create() {
      const projectId = host.projectId();
      if (projectId === null) return;
      await projection.runExclusive(async (token) => {
        if (host.currentStage() !== 'writing') await host.moveToWriting();
        if (host.stageStatus('writing') === 'ready') await host.startWriting();
        const artifact = await adapter.createArtifact({ projectId, stage: 'writing', kind: 'manuscript', title: 'Manuscript', path: null });
        await host.refresh();
        if (!projection.isCurrent(token)) return;
        projection.assign({
          selectedArtifactId: artifact.id,
          manuscript: null,
          claims: [],
          draft: emptyManuscriptDraft
        });
      }, { busy: '当前命令仍在进行。', failed: '创建正文失败。' });
    },
    async createClaim() {
      const projectId = host.projectId();
      const snapshot = projection.peek();
      if (projectId === null || snapshot.selectedArtifactId === null) return;
      await projection.runExclusive(async (token) => {
        await adapter.createClaim({
          projectId,
          artifactId: snapshot.selectedArtifactId!,
          subjectType: 'paragraph',
          content: snapshot.draft.content.trim(),
          status: snapshot.draft.status,
          evidenceIds: snapshot.draft.evidenceIds
        });
        const claims = await adapter.listClaims({ projectId, artifactId: snapshot.selectedArtifactId! });
        if (!projection.isCurrent(token)) return;
        projection.assign({ claims, draft: { ...snapshot.draft, content: '' } });
      }, { busy: '当前命令仍在进行。', failed: '创建主张失败。' });
    },
    async save() {
      const snapshot = projection.peek();
      if (snapshot.selectedArtifactId === null) return;
      await projection.runExclusive(async (token) => {
        const manuscript = await adapter.saveManuscript({
          artifactId: snapshot.selectedArtifactId!,
          sections: [{ title: snapshot.draft.sectionTitle.trim(), claimIds: snapshot.draft.selectedClaimIds }]
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ manuscript });
      }, { busy: '当前命令仍在进行。', failed: '保存正文失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchManuscriptAdapter(client: RocClient): ResearchManuscriptAdapter {
  const research = client.api.research;
  return {
    async createArtifact(request) { return unwrap('创建正文', await research.createArtifact(request)); },
    async getManuscript(request) { return unwrap('正文', await research.getManuscript(request)); },
    async listClaims(request) { return unwrap('主张', await research.listClaims(request)); },
    async createClaim(request) { return unwrap('创建主张', await research.createClaim(request)); },
    async saveManuscript(request) { return unwrap('保存正文', await research.saveManuscript(request)); }
  };
}
