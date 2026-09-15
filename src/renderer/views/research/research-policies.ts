import type { ResearchStagePolicy, ResearchWorkflowSnapshot } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { emptyPolicyDraft, policyToDraft, type ResearchPolicyDraft } from './ResearchPolicyPanel';
import { createProjectionController } from './research-projection';

export type ResearchPolicyAdapter = {
  list(request: { projectId: string }): Promise<ResearchStagePolicy[]>;
  save(request: ResearchStagePolicy): Promise<ResearchStagePolicy>;
};

export type ResearchPolicySnapshot = {
  policies: ResearchStagePolicy[];
  draft: ResearchPolicyDraft;
  working: boolean;
  error: string | null;
};

export type ResearchPolicyProjection = {
  getSnapshot(): ResearchPolicySnapshot;
  subscribe(listener: (snapshot: ResearchPolicySnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setDraft(draft: ResearchPolicyDraft): void;
  select(stage: ResearchWorkflowSnapshot['currentStage']): void;
  load(): Promise<void>;
  save(): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchPolicySnapshot => ({
  policies: [],
  draft: emptyPolicyDraft('discovery'),
  working: false,
  error: null
});

export function createResearchPolicyProjection(adapter: ResearchPolicyAdapter): ResearchPolicyProjection {
  const projection = createProjectionController<ResearchPolicySnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, policies: [...value.policies], draft: { ...value.draft } };
    }
  });
  let projectId: string | null = null;

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) { projectId = next; },
    setDraft(draft) { projection.assign({ draft }); },
    select(stage) {
      const current = projection.peek().policies.find((policy) => policy.stage === stage);
      projection.assign({ draft: current === undefined ? emptyPolicyDraft(stage) : policyToDraft(current) });
    },
    async load() {
      await projection.runExclusive(async (token) => {
        if (projectId === null) {
          projection.assign({ policies: [], draft: emptyPolicyDraft('discovery') });
          return;
        }
        const listed = await adapter.list({ projectId });
        if (!projection.isCurrent(token)) return;
        const current = listed.find((policy) => policy.stage === projection.peek().draft.stage) ?? listed[0];
        projection.assign({
          policies: listed,
          ...(current === undefined ? {} : { draft: policyToDraft(current) })
        });
      }, { busy: '当前命令仍在进行。', failed: '阶段策略加载失败。' });
    },
    async save() {
      if (projectId === null) return;
      const currentProjectId = projectId;
      const draft = projection.peek().draft;
      const maxSteps = Number(draft.maxSteps);
      const timeoutMs = Number(draft.timeoutMs);
      if (!Number.isInteger(maxSteps) || maxSteps < 2 || maxSteps > 100 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
        projection.fail('最大步数需在 2 到 100，超时需在 1000 到 600000 毫秒之间。');
        return;
      }
      if (draft.modelKind === 'model' && (draft.providerId.trim().length === 0 || draft.modelId.trim().length === 0)) {
        projection.fail('指定模型时必须选择提供商和模型。');
        return;
      }
      await projection.runExclusive(async (token) => {
        const saved = await adapter.save({
          projectId: currentProjectId,
          stage: draft.stage,
          tier: draft.tier,
          model: draft.modelKind === 'app_default'
            ? { kind: 'app_default' }
            : { kind: 'model', providerId: draft.providerId, modelId: draft.modelId },
          maxSteps,
          timeoutMs
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({
          policies: [saved, ...projection.peek().policies.filter((policy) => policy.stage !== saved.stage)],
          draft: policyToDraft(saved)
        });
      }, { busy: '当前命令仍在进行。', failed: '保存阶段策略失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchPolicyAdapter(client: RocClient): ResearchPolicyAdapter {
  const research = client.api.research;
  return {
    async list(request) { return unwrap('阶段策略', await research.listStagePolicies(request)); },
    async save(request) { return unwrap('保存阶段策略', await research.saveStagePolicy(request)); }
  };
}
