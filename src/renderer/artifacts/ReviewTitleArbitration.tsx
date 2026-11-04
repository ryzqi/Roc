import {useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewScreeningFrozenPhase, ResearchReviewScreeningArbitrationSave} from '../../shared/schemas/research-review-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewScreeningOutcome, screeningFinalOutcome, screeningOutcomeDraft, screeningDecisions} from './ReviewScreeningOutcome';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewTitleArbitration({client, protocol, phase, item, writable, onPending, onSaved}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewScreeningFrozenPhase;
  item: ResearchReviewScreeningFrozenPhase['items'][number]; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const {projectId, corpusId, adjudicator} = phase.plan.snapshot.request;
  const parent = item.arbitration;
  const [editing, setEditing] = useState(parent === null);
  const [draft, setDraft] = useState(() => screeningOutcomeDraft(parent === null ? null : parent.snapshot.request.outcome));
  const [reviewerId, setReviewerId] = useState(''), [revisionReason, setRevisionReason] = useState('');
  const save = useAsyncAction((request: ResearchReviewScreeningArbitrationSave) => client.api.research.adjudicateReviewScreening(request),
    {label: '保存人工标题摘要仲裁'});
  const history = useAsyncResource(parent === null ? null : `review:title-arbitrations:${phase.plan.snapshotHash}:${parent.snapshotHash}`,
    () => {
      if (parent === null) throw new Error('research_review_screening_arbitration_required');
      return client.api.research.getReviewScreeningArbitrationHistory({projectId, corpusId, arbitrationId: parent.snapshot.id});
    }, {label: '读取人工仲裁修订历史'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const eligible = item.status === 'conflict' || item.status === 'uncertain' || parent?.currentDecisionSet === true;
  const canEdit = writable && eligible && editing;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-title-arbitration">
    <h3 className="font-medium">人工仲裁</h3>
    <ul className="flex flex-col gap-2">{item.decisions.map(decision => <li key={decision.snapshot.id} className="break-words">
      <p>{decision.snapshot.reviewer.name} {screeningDecisions[decision.snapshot.request.outcome.decision]} 版本 {decision.snapshot.version}</p>
      <p className="text-muted">{decision.snapshot.request.outcome.reason}</p>
      <details><summary className="cursor-pointer text-muted">准则与审核引用</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
          {JSON.stringify({request: decision.snapshot.request, id: decision.snapshot.id, snapshotHash: decision.snapshotHash}, null, 2)}
        </pre>
      </details>
    </li>)}</ul>
    {item.status !== 'pending' ? null : <p className="text-muted">等待全部声明审核人完成审查。</p>}
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-title-arbitration-current">
      <h4 className="font-medium">仲裁 {screeningDecisions[parent.snapshot.request.outcome.decision]} 版本 {parent.snapshot.version}</h4>
      <p className="text-muted">{parent.currentDecisionSet ? '对应当前全部审核决定' : '原审核决定已变化，此仲裁不适用于当前集合'}</p>
      <p className="break-words">{parent.snapshot.request.outcome.reason}</p>
      <p className="text-muted break-words">仲裁人 {parent.snapshot.adjudicator.name} {parent.snapshot.adjudicator.id}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      {!writable || !eligible || editing ? null : <button type="button" className={`${button} self-start`}
        data-testid="artifact-review-title-arbitration-revise" onClick={() => setEditing(true)}>修订当前集合仲裁</button>}
    </section>}
    {!canEdit ? null : <form className="flex flex-col gap-2" data-testid="artifact-review-title-arbitration-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || !canEdit || reviewerId !== adjudicator.id || draft.decision === '' || draft.decision === 'uncertain') return;
      const body = {projectId, corpusId, expectedPlanHash: phase.plan.snapshotHash, phase: 'title_abstract' as const, hitId: item.hit.id,
        reviewerId, outcome: screeningFinalOutcome(draft.decision, draft),
        decisions: item.decisions.map(decision => ({id: decision.snapshot.id, expectedHash: decision.snapshotHash})),
        parentArbitrationId: parent === null ? null : parent.snapshot.id,
        expectedParentHash: parent === null ? null : parent.snapshotHash, revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {busy.current = false; onPending(false); if (result.ok) onSaved();});
    }}>
      <fieldset disabled={save.pending} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-muted">标题摘要仲裁人
          <select required aria-label="标题摘要仲裁人" className={`${formInputClass} border-[0.5px]`} value={reviewerId}
            onChange={event => {setReviewerId(event.target.value); save.reset();}}>
            <option value="">选择已声明仲裁人</option>
            <option value={adjudicator.id}>{adjudicator.name} {adjudicator.id}</option>
          </select>
        </label>
        <ReviewScreeningOutcome protocol={protocol} value={draft} allowUncertain={false}
          onChange={value => {setDraft(value); save.reset();}} />
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">仲裁修订原因
          <textarea required aria-label="仲裁修订原因" maxLength={10000} rows={3}
            className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`} value={revisionReason}
            onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={reviewerId === '' || draft.decision === '' || (draft.decision === 'include' && draft.inclusionCriterionIds.length === 0)}
          data-testid="artifact-review-title-arbitration-save">保存当前审核集合仲裁</button>
      </fieldset>
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-title-arbitration-history">
      <summary className="cursor-pointer text-muted">仲裁修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(arbitration => <li key={arbitration.snapshot.id} className="break-words text-muted">
        版本 {arbitration.snapshot.version} {screeningDecisions[arbitration.snapshot.request.outcome.decision]} {arbitration.snapshot.request.outcome.reason}
        <p>{arbitration.currentDecisionSet ? '对应当前审核集合' : '历史审核集合'}</p>
        <p>{arbitration.snapshot.request.revisionReason}</p><p>记录人 {arbitration.snapshot.actor.id} {arbitration.snapshot.recordedAt}</p>
      </li>)}</ul>
    </details>}
  </section>;
}
