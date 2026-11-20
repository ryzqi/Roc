import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewScreeningDecisionSave, ResearchReviewScreeningArbitrationSave} from '../../shared/schemas/research-review-screening';
import {formInputClass} from '../shared/form-ui';

type Outcome = ResearchReviewScreeningDecisionSave['outcome'];
export type ScreeningOutcomeDraft = {
  decision: Outcome['decision'] | ''; inclusionCriterionIds: string[]; exclusionCriterionId: string; reason: string
};
export function screeningOutcomeDraft(outcome: Outcome | null): ScreeningOutcomeDraft {
  return {
    decision: outcome === null ? '' : outcome.decision,
    inclusionCriterionIds: outcome?.decision === 'include' ? outcome.inclusionCriterionIds : [],
    exclusionCriterionId: outcome?.decision === 'exclude' ? outcome.exclusionCriterionId : '',
    reason: outcome === null ? '' : outcome.reason
  };
}
export function screeningOutcome(decision: Outcome['decision'], draft: ScreeningOutcomeDraft): Outcome {
  switch (decision) {
    case 'include':
    case 'exclude': return screeningFinalOutcome(decision, draft);
    case 'uncertain': return {decision, reason: draft.reason};
  }
}
export function screeningFinalOutcome(
  decision: ResearchReviewScreeningArbitrationSave['outcome']['decision'], draft: ScreeningOutcomeDraft
): ResearchReviewScreeningArbitrationSave['outcome'] {
  switch (decision) {
    case 'include': return {decision, inclusionCriterionIds: draft.inclusionCriterionIds, reason: draft.reason};
    case 'exclude': return {decision, exclusionCriterionId: draft.exclusionCriterionId, reason: draft.reason};
  }
}
export function ReviewScreeningOutcome({protocol, value, onChange, allowUncertain}: {
  protocol: ResearchReviewProtocolInspection; value: ScreeningOutcomeDraft; onChange: (value: ScreeningOutcomeDraft) => void;
  allowUncertain: boolean
}): React.JSX.Element {
  const input = `${formInputClass} border-[0.5px]`;
  return <>
    <label className="flex flex-col gap-1 text-muted">筛选决定
      <select required aria-label="筛选决定" className={input} value={value.decision}
        onChange={event => onChange({...value, decision: event.target.value as ScreeningOutcomeDraft['decision']})}>
        <option value="">选择人工决定</option>
        <option value="include">纳入</option><option value="exclude">排除</option>
        {!allowUncertain ? null : <option value="uncertain">无法判断</option>}
      </select>
    </label>
    {value.decision !== 'include' ? null : <fieldset className="flex flex-col gap-1">
      <legend className="text-muted">符合的纳入准则</legend>
      {protocol.version.body.inclusionCriteria.map(criterion => <label key={criterion.id} className="flex items-start gap-2 break-words">
        <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={value.inclusionCriterionIds.includes(criterion.id)}
          onChange={event => onChange({...value, inclusionCriterionIds: event.target.checked ?
            [...value.inclusionCriterionIds, criterion.id] : value.inclusionCriterionIds.filter(id => id !== criterion.id)})} />
        {criterion.text} <span className="text-muted">{criterion.id}</span>
      </label>)}
    </fieldset>}
    {value.decision !== 'exclude' ? null : <label className="flex flex-col gap-1 text-muted">主要排除准则
      <select required aria-label="主要排除准则" className={input} value={value.exclusionCriterionId}
        onChange={event => onChange({...value, exclusionCriterionId: event.target.value})}>
        <option value="">选择一个主要原因</option>
        {protocol.version.body.exclusionCriteria.map(criterion => <option key={criterion.id} value={criterion.id}>{criterion.text} {criterion.id}</option>)}
      </select>
    </label>}
    <label className="flex flex-col gap-1 text-muted">筛选理由
      <textarea required aria-label="筛选理由" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
        value={value.reason} onChange={event => onChange({...value, reason: event.target.value})} />
    </label>
  </>;
}
export const screeningDecisions = {include: '纳入', exclude: '排除', uncertain: '无法判断'} as const;
export const screeningStatuses = {pending: '待审', uncertain: '无法判断', conflict: '决定冲突', included: '纳入', excluded: '排除'} as const;
