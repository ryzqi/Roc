import {useState} from 'react';
import type {ResearchReviewQualityAssessmentSave} from '../../shared/schemas/research-review-quality';
import type {ResearchReviewExtractionInspection} from '../../shared/schemas/research-review-extraction';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

type Value = ResearchReviewQualityAssessmentSave['overall']['value'];
type Reference = ResearchReviewQualityAssessmentSave['overall']['evidence'][number];
export type QualityJudgementDraft = {kind: Value['kind'] | ''; judgement: string; reason: string; evidence: Reference[]};
export function qualityJudgementDraft(value: Value | null, evidence: Reference[]): QualityJudgementDraft {
  return {kind: value?.kind ?? '', judgement: value?.kind === 'judged' ? value.judgement : '', reason: value?.reason ?? '', evidence};
}
export function qualityJudgementValue(draft: QualityJudgementDraft): Value {
  if (draft.kind === '') throw new Error('research_review_quality_judgement_required');
  return draft.kind === 'judged' ? {kind: 'judged', judgement: draft.judgement, reason: draft.reason} : {kind: 'unjudgeable', reason: draft.reason};
}
export function ReviewQualityJudgement({label, question, choices, sources, value, onChange}: {
  label: string; question: string; choices: string[]; sources: ResearchReviewExtractionInspection['snapshot']['sources'];
  value: QualityJudgementDraft; onChange: (draft: QualityJudgementDraft) => void
}): React.JSX.Element {
  const input = `${formInputClass} border-[0.5px]`, button = `${formSecondaryButtonClass} border-[0.5px]`;
  const [candidateId, setCandidateId] = useState('');
  const source = sources.find(item => item.evidence.id === candidateId);
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-quality-judgement">
    <h3 className="font-medium">{label}</h3><p className="break-words">{question}</p>
    <label className="flex flex-col gap-1 text-muted">{label}判断类型
      <select required aria-label={`${label}判断类型`} className={input} value={value.kind}
        onChange={event => onChange({...value, kind: event.target.value as QualityJudgementDraft['kind']})}>
        <option value="">选择人工判断类型</option><option value="judged">按框架判断</option><option value="unjudgeable">无法判断</option>
      </select>
    </label>
    {value.kind !== 'judged' ? null : <label className="flex flex-col gap-1 text-muted">{label}判断类别
      <select required aria-label={`${label}判断类别`} className={input} value={value.judgement}
        onChange={event => onChange({...value, judgement: event.target.value})}>
        <option value="">明确选择冻结类别</option>{choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    </label>}
    <label className="flex flex-col gap-1 text-muted">{label}理由
      <textarea required maxLength={10000} rows={3} aria-label={`${label}理由`} className={`${input} h-auto resize-y py-1`}
        value={value.reason} onChange={event => onChange({...value, reason: event.target.value})} />
    </label>
    <label className="flex flex-col gap-1 text-muted">{label}提取证据
      <select aria-label={`${label}提取证据`} className={input} value={candidateId} onChange={event => setCandidateId(event.target.value)}>
        <option value="">核查此提取版本已保存的原文证据</option>
        {sources.map(item => <option key={item.evidence.id} value={item.evidence.id}>{item.evidence.title} {item.evidence.locator}</option>)}
      </select>
    </label>
    {source === undefined ? null : <>
      <blockquote tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{source.evidence.excerpt}</blockquote>
      <p className="text-muted break-words">{source.evidence.locator}</p>
      <details><summary className="cursor-pointer text-muted">提取固定的定位与摘要</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(source, null, 2)}</pre>
      </details>
      <button type="button" className={`${button} self-start`} disabled={value.evidence.length >= 10 || value.evidence.some(item => item.id === source.evidence.id)}
        data-testid="artifact-review-quality-evidence-add" onClick={() => onChange({...value,
          evidence: [...value.evidence, {id: source.evidence.id, expectedHash: source.digest}]})}>引用此版本原文证据</button>
    </>}
    <ul className="flex flex-col gap-1">{value.evidence.map(ref => <li key={ref.id} className="flex min-w-0 flex-col gap-1">
      <p className="text-muted break-all">Evidence {ref.id} SHA-256 {ref.expectedHash}</p>
      <button type="button" className={`${button} self-start`} onClick={() => onChange({...value, evidence: value.evidence.filter(item => item.id !== ref.id)})}>移除此判断证据引用</button>
    </li>)}</ul>
  </section>;
}
