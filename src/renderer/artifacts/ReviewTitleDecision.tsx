import {useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {
  ResearchReviewScreeningDecisionInspection, ResearchReviewScreeningDecisionSave, ResearchReviewScreeningPlanInspection
} from '../../shared/schemas/research-review-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewScreeningOutcome, screeningOutcome, screeningOutcomeDraft, screeningDecisions} from './ReviewScreeningOutcome';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewTitleDecision({client, protocol, plan, hitId, reviewerId, parent, writable, onPending, onSaved}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; plan: ResearchReviewScreeningPlanInspection; hitId: string;
  reviewerId: string; parent: ResearchReviewScreeningDecisionInspection | null; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const {projectId, corpusId} = plan.snapshot.request;
  const [editing, setEditing] = useState(parent === null);
  const [draft, setDraft] = useState(() => screeningOutcomeDraft(parent === null ? null : parent.snapshot.request.outcome));
  const [revisionReason, setRevisionReason] = useState('');
  const [considered, setConsidered] = useState<ResearchReviewScreeningDecisionSave['consideredSuggestion']>(
    parent === null ? null : parent.snapshot.request.consideredSuggestion);
  const [offset, setOffset] = useState(0);
  const suggestions = useAsyncResource(`review:title-suggestions:${plan.snapshotHash}:${hitId}:${offset}`,
    () => client.api.research.listReviewScreeningSuggestions({projectId, corpusId, hitId, phase: 'title_abstract', offset, limit: 30}),
    {label: '读取独立模型建议'});
  const history = useAsyncResource(parent === null ? null : `review:title-history:${plan.snapshotHash}:${parent.snapshotHash}`,
    () => {
      if (parent === null) throw new Error('research_review_screening_decision_required');
      return client.api.research.getReviewScreeningDecisionHistory({projectId, corpusId, decisionId: parent.snapshot.id});
    }, {label: '读取人工筛选修订历史'});
  const save = useAsyncAction((request: ResearchReviewScreeningDecisionSave) => client.api.research.saveReviewScreeningDecision(request),
    {label: '保存人工标题摘要决定'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const canEdit = writable && editing;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-title-decision">
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-title-current">
      <h4 className="font-medium">人工决定 {screeningDecisions[parent.snapshot.request.outcome.decision]} 版本 {parent.snapshot.version}</h4>
      <p className="break-words">{parent.snapshot.request.outcome.reason}</p>
      <p className="text-muted break-words">审核人 {parent.snapshot.reviewer.name} {parent.snapshot.reviewer.id}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">决定准则与准确引用</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
          {JSON.stringify(parent.snapshot.request, null, 2)}
        </pre>
      </details>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`}
        data-testid="artifact-review-title-revise" onClick={() => setEditing(true)}>修订此审核人决定</button>}
    </section>}
    <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-title-suggestions">
      <h4 className="font-medium">独立模型建议</h4>
      <button type="button" className={`${button} self-start`} disabled={save.pending || suggestions.status === 'loading'}
        onClick={suggestions.reload}>重读模型建议</button>
      {suggestions.status !== 'loading' ? null : <p role="status">正在读取原始建议…</p>}
      {suggestions.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{suggestions.error}</p>}
      {suggestions.status !== 'ready' ? null : suggestions.data!.length === 0 ? <p className="text-muted">本页没有模型建议。</p> :
        <ul className="flex flex-col gap-2">{suggestions.data!.map(item => <li key={item.snapshot.id}
          className="flex flex-col gap-1" data-testid="artifact-review-title-suggestion">
          <p>建议 {screeningDecisions[item.snapshot.request.outcome.decision]}</p>
          <p className="break-words">{item.snapshot.request.outcome.reason}</p>
          <details><summary className="cursor-pointer text-muted">建议准则与工具来源</summary>
            <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
              {JSON.stringify({outcome: item.snapshot.request.outcome, origin: item.snapshot.origin, recordedAt: item.snapshot.recordedAt}, null, 2)}
            </pre>
          </details>
          {!canEdit ? null : <button type="button" className={`${button} self-start`} disabled={save.pending}
            data-testid="artifact-review-title-consider" onClick={() => {
              setConsidered({id: item.snapshot.id, expectedHash: item.snapshotHash}); save.reset();
            }}>记录已参考此建议</button>}
        </li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={save.pending || suggestions.status === 'loading' || offset === 0}
          onClick={() => setOffset(offset - 30)}>上一页建议</button>
        <span className="text-muted">第 {Math.floor(offset / 30) + 1} 页</span>
        <button type="button" className={button} disabled={save.pending || suggestions.status !== 'ready' || suggestions.data!.length < 30}
          onClick={() => setOffset(offset + 30)}>下一页建议</button>
      </div>
    </section>
    {considered === null ? null : <div className="flex flex-col gap-1">
      <p className="text-muted break-all">已参考建议 {considered.id}</p>
      {!canEdit ? null : <button type="button" className={`${button} self-start`} disabled={save.pending}
        onClick={() => {setConsidered(null); save.reset();}}>清除建议引用</button>}
    </div>}
    {!canEdit ? null : <form className="flex flex-col gap-2" data-testid="artifact-review-title-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || !canEdit || draft.decision === '') return;
      const body = {projectId, corpusId, expectedPlanHash: plan.snapshotHash, hitId, phase: 'title_abstract' as const,
        reviewerId, outcome: screeningOutcome(draft.decision, draft), consideredSuggestion: considered,
        parentDecisionId: parent === null ? null : parent.snapshot.id,
        expectedParentHash: parent === null ? null : parent.snapshotHash, revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {busy.current = false; onPending(false); if (result.ok) onSaved();});
    }}>
      <fieldset disabled={save.pending} className="flex flex-col gap-2">
        <ReviewScreeningOutcome protocol={protocol} value={draft} allowUncertain onChange={value => {setDraft(value); save.reset();}} />
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">筛选修订原因
          <textarea required aria-label="筛选修订原因" maxLength={10000} rows={3}
            className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`} value={revisionReason}
            onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={draft.decision === '' || (draft.decision === 'include' && draft.inclusionCriterionIds.length === 0)}
          data-testid="artifact-review-title-save">保存标题摘要人工决定</button>
      </fieldset>
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-title-history">
      <summary className="cursor-pointer text-muted">人工决定修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="break-words text-muted">
        版本 {item.snapshot.version} {screeningDecisions[item.snapshot.request.outcome.decision]} {item.snapshot.request.outcome.reason}
        <p>{item.snapshot.request.revisionReason}</p><p>记录人 {item.snapshot.actor.id} {item.snapshot.recordedAt}</p>
      </li>)}</ul>
    </details>}
  </section>;
}
