import type {ResearchReviewStudiesSave} from '../../shared/schemas/research-review-studies';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorGuard} from './artifact-editor-guard';

export type StudyGroupDraft = ResearchReviewStudiesSave['groups'][number] & {
  key: string; pendingReport: {hitId: string; sourceNote: string}
};
export function blankStudyGroup(): StudyGroupDraft {
  return {key: crypto.randomUUID(), studyId: '', label: '', reason: '', reports: [], pendingReport: {hitId: '', sourceNote: ''}};
}
export function ReviewStudyGroup({group, index, included, onChange, onRemove}: {
  group: StudyGroupDraft; index: number; included: NonNullable<ResearchReviewFullTextFrozenPhase['freeze']>['authority']['items'];
  onChange: (group: StudyGroupDraft) => void; onRemove: () => void
}): React.JSX.Element {
  const input = `${formInputClass} border-[0.5px]`, button = `${formSecondaryButtonClass} border-[0.5px]`;
  const label = `研究 ${index + 1}`;
  const {hitId, sourceNote} = group.pendingReport;
  const guard = useArtifactEditorGuard();
  const setPendingReport = (next: StudyGroupDraft['pendingReport']): void => onChange({...group, pendingReport: next});
  const selected = included.find(item => item.hit.id === hitId);
  const duplicate = group.reports.some(report => report.hitId === hitId);
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-study-group">
    <h3 className="font-medium">{label}</h3>
    {([['ID', 'studyId'], ['名称', 'label']] as const).map(([suffix, field]) => <label key={field} className="flex flex-col gap-1 text-muted">
      {label}{suffix}<input required maxLength={300} aria-label={`${label}${suffix}`} className={input} value={group[field]}
        onChange={event => onChange({...group, [field]: event.target.value})} />
    </label>)}
    <label className="flex flex-col gap-1 text-muted">{label}身份理由
      <textarea required maxLength={10000} rows={3} aria-label={`${label}身份理由`} className={`${input} h-auto resize-y py-1`}
        value={group.reason} onChange={event => onChange({...group, reason: event.target.value})} />
    </label>
    <label className="flex flex-col gap-1 text-muted">{label}纳入报告
      <select aria-label={`${label}纳入报告`} className={input} value={hitId}
        onChange={event => setPendingReport({hitId: event.target.value, sourceNote})}>
        <option value="">明确选择冻结纳入的报告</option>
        {included.map((item, position) => <option key={item.hit.id} value={item.hit.id}>纳入报告 {position + 1} 原始命中 {item.hit.recordIndex + 1}</option>)}
      </select>
    </label>
    <label className="flex flex-col gap-1 text-muted">{label}报告原文说明
      <textarea maxLength={10000} rows={3} aria-label={`${label}报告原文说明`} className={`${input} h-auto resize-y py-1`}
        value={sourceNote} onChange={event => setPendingReport({hitId, sourceNote: event.target.value})} />
    </label>
    <button type="button" className={`${button} self-start`} data-testid="artifact-review-study-report-add"
      disabled={selected === undefined || selected.binding === null || duplicate || sourceNote.trim() === '' || group.reports.length >= 1620}
      onClick={() => {
        if (selected === undefined || selected.binding === null || duplicate || sourceNote.trim() === '') return;
        onChange({...group, reports: [...group.reports, {hitId: selected.hit.id, expectedBindingHash: selected.binding.expectedHash, sourceNote}],
          pendingReport: {hitId: '', sourceNote: ''}});
      }}>加入已选纳入报告</button>
    {hitId === '' && sourceNote === '' ? null : <>
      <p className="text-muted" role="status">已填写的报告和说明尚未加入研究。</p>
      <button type="button" className={`${button} self-start`} data-testid="artifact-review-study-report-discard"
        onClick={() => guard.request(() => setPendingReport({hitId: '', sourceNote: ''}), '尚未加入研究的报告选择与原文说明将被放弃。')}>
        放弃未加入的报告
      </button>
    </>}
    <ul className="flex flex-col gap-2">{group.reports.map(report => <li key={report.hitId} className="flex min-w-0 flex-col gap-1">
      <p className="text-muted break-all">命中 {report.hitId} 来源 SHA-256 {report.expectedBindingHash}</p>
      <p className="break-words">{report.sourceNote}</p>
      <button type="button" className={`${button} self-start`} onClick={() => onChange({...group, reports: group.reports.filter(item => item.hitId !== report.hitId)})}>移除此报告关联</button>
    </li>)}</ul>
    <button type="button" className={`${button} self-start`} onClick={onRemove}>移除此声明研究</button>
  </section>;
}
