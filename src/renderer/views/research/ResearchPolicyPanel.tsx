import { Send } from 'lucide-react';

import { Select, TextInput } from '../../components/ui';
import type { ProviderConfig, ResearchStagePolicy, ResearchWorkflowSnapshot } from '../../../shared/types';
import { researchStageLabels } from './research-workflow';

export type ResearchPolicyDraft = {
  stage: ResearchWorkflowSnapshot['currentStage'];
  tier: ResearchStagePolicy['tier'];
  modelKind: ResearchStagePolicy['model']['kind'];
  providerId: string;
  modelId: string;
  maxSteps: string;
  timeoutMs: string;
};

const tierLabels: Record<ResearchStagePolicy['tier'], string> = {
  fast: '快速',
  balanced: '均衡',
  deep: '深度'
};

export function emptyPolicyDraft(stage: ResearchWorkflowSnapshot['currentStage']): ResearchPolicyDraft {
  return { stage, tier: 'balanced', modelKind: 'app_default', providerId: '', modelId: '', maxSteps: '30', timeoutMs: '180000' };
}

export function policyToDraft(policy: ResearchStagePolicy): ResearchPolicyDraft {
  return {
    stage: policy.stage,
    tier: policy.tier,
    modelKind: policy.model.kind,
    providerId: policy.model.kind === 'model' ? policy.model.providerId : '',
    modelId: policy.model.kind === 'model' ? policy.model.modelId : '',
    maxSteps: String(policy.maxSteps),
    timeoutMs: String(policy.timeoutMs)
  };
}

export function ResearchPolicyPanel({
  draft,
  onChange,
  onSave,
  onSelect,
  policies,
  providers,
  working
}: {
  draft: ResearchPolicyDraft;
  onChange: (draft: ResearchPolicyDraft) => void;
  onSave: () => void;
  onSelect: (stage: ResearchWorkflowSnapshot['currentStage']) => void;
  policies: ResearchStagePolicy[];
  providers: ProviderConfig[];
  working: boolean;
}): React.JSX.Element {
  const selected = policies.find((policy) => policy.stage === draft.stage) ?? null;
  const provider = providers.find((item) => item.id === draft.providerId) ?? null;
  return (
    <section className="research-tool-panel" data-testid="research-policy-panel">
      <div className="research-tool-heading">
        <div>
          <h2>阶段模型策略</h2>
          <p>按阶段选择档位和模型。默认跟随应用模型，也可覆盖为指定提供商。</p>
        </div>
      </div>
      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-policy-list">
          {policies.length === 0 ? <div className="research-loading">还没有阶段策略。</div> : policies.map((policy) => (
            <button className={policy.stage === draft.stage ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={policy.stage} type="button" onClick={() => onSelect(policy.stage)}>
              <strong>{researchStageLabels[policy.stage]}</strong>
              <span>{tierLabels[policy.tier]} · {policy.model.kind === 'app_default' ? '应用默认' : policy.model.modelId}</span>
            </button>
          ))}
        </div>
        <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
          <label>
            档位
            <Select data-testid="research-policy-tier" value={draft.tier} onChange={(event) => onChange({ ...draft, tier: event.target.value as ResearchStagePolicy['tier'] })}>
              <option value="fast">快速</option>
              <option value="balanced">均衡</option>
              <option value="deep">深度</option>
            </Select>
          </label>
          <label>
            模型
            <Select data-testid="research-policy-model-kind" value={draft.modelKind} onChange={(event) => onChange({ ...draft, modelKind: event.target.value === 'model' ? 'model' : 'app_default' })}>
              <option value="app_default">应用默认</option>
              <option value="model">指定模型</option>
            </Select>
          </label>
          {draft.modelKind === 'model' ? (
            <>
              <label>
                提供商
                <Select data-testid="research-policy-provider" value={draft.providerId} onChange={(event) => onChange({ ...draft, providerId: event.target.value, modelId: '' })}>
                  <option value="">选择提供商</option>
                  {providers.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </label>
              <label>
                模型 ID
                <Select data-testid="research-policy-model" value={draft.modelId} onChange={(event) => onChange({ ...draft, modelId: event.target.value })}>
                  <option value="">选择模型</option>
                  {(provider?.models ?? []).filter((model) => model.enabled).map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}
                </Select>
              </label>
            </>
          ) : null}
          <label>
            最大步数
            <TextInput data-testid="research-policy-steps" inputMode="numeric" value={draft.maxSteps} onChange={(event) => onChange({ ...draft, maxSteps: event.target.value })} />
          </label>
          <label>
            超时（毫秒）
            <TextInput data-testid="research-policy-timeout" inputMode="numeric" value={draft.timeoutMs} onChange={(event) => onChange({ ...draft, timeoutMs: event.target.value })} />
          </label>
          <div className="research-form-actions">
            <button className="action-button action-button--primary" disabled={working} type="submit" data-testid="research-policy-save">
              <Send aria-hidden="true" size={15} />
              保存策略
            </button>
          </div>
          {selected === null ? null : <p className="research-stage-copy" data-testid="research-policy-current">{researchStageLabels[selected.stage]} · {tierLabels[selected.tier]}</p>}
        </form>
      </div>
    </section>
  );
}
