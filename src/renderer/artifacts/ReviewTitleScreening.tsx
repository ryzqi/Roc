import { useEffect, useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewScreeningFrozenPhase, ResearchReviewScreeningPlanInspection, ResearchReviewScreeningFreezeRequest} from '../../shared/schemas/research-review-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewTitleDecision} from './ReviewTitleDecision';
import {ReviewTitleArbitration} from './ReviewTitleArbitration';
import {screeningStatuses} from './ReviewScreeningOutcome';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const ReviewFullTextBindings = retryableLazy(async () => ({default: (await import('./ReviewFullTextBindings')).ReviewFullTextBindings}));
export function ReviewTitleScreening({client, protocol, plan, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; plan: ResearchReviewScreeningPlanInspection;
  writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const {projectId, corpusId} = plan.snapshot.request;
  const phaseRead = useAsyncResource(`review:title-phase:${plan.snapshotHash}`,
    () => client.api.research.getReviewScreeningPhase({projectId, corpusId, phase: 'title_abstract'}), {label: '读取标题摘要人工筛选'});
  const phase = phaseRead.data;
  const [hitId, setHitId] = useState<string | null>(null), [recordPending, setRecordPending] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [fullOpen, setFullOpen] = useState(false), [fullPending, setFullPending] = useState(false);
  const freeze = useAsyncAction((request: ResearchReviewScreeningFreezeRequest) => client.api.research.freezeReviewScreeningPhase(request),
    {label: '冻结标题摘要人工筛选'});
  const pending = recordPending || freeze.pending || fullPending;
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('标题摘要整轮审核说明', reviewNote, busy);
  const guard = useArtifactEditorGuard();
  const locked = guard.locked();
  const [offset, setOffset] = useState(0);
  const focus = useRef<HTMLDivElement>(null);
  const selected = phase?.items.find(item => item.hit.id === hitId);
  useEffect(() => {
    if (selected === undefined) return;
    focus.current?.scrollIntoView({block: 'start', behavior: 'instant'}); focus.current?.focus();
  }, [hitId, selected?.hit.id]);
  const editable = writable && phaseRead.status === 'ready' && phase?.plan.currentProtocol === true &&
    phase.freeze === null && plan.currentProtocol;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-title">
    <h2 className="font-medium">标题摘要筛选</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || locked || phaseRead.status === 'loading'}
      data-testid="artifact-review-title-refresh" onClick={() => {if (!guard.locked()) phaseRead.reload();}}>重读标题摘要筛选</button>
    {phaseRead.status !== 'loading' ? null : <p role="status">正在读取实际人工筛选状态…</p>}
    {phaseRead.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{phaseRead.error}</p>}
    {phase === null || phaseRead.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的筛选回执。</p>}
    {phase === null ? null : <>
      <p className="tabular-nums" data-testid="artifact-review-title-counts">待筛选 {phase.counts.recordsToScreen} = 待审 {phase.counts.pending}
        {' + '}无法判断 {phase.counts.uncertain}{' + '}冲突 {phase.counts.conflict}
        {' + '}纳入 {phase.counts.included}{' + '}排除 {phase.counts.excluded}</p>
      {phase.freeze === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-title-frozen">
        <h3 className="font-medium">标题摘要筛选已冻结</h3>
        <p className="break-words">{phase.freeze.request.reviewNote}</p>
        <p className="text-muted break-all">审核人 {phase.freeze.actor.id} {phase.freeze.frozenAt}</p>
        <button type="button" className={`${button} self-start`} disabled={pending || locked}
          data-testid="artifact-review-fulltext-inspect" onClick={() => {if (!guard.locked()) setFullOpen(true);}}>核查全文获取与资格筛选</button>
        {!fullOpen ? null : <LazyBoundary fallback={<p role="status">正在加载全文核查…</p>}>
          <ReviewFullTextBindings key={`fulltext:${phase.freezeHash}`} client={client} protocol={protocol} projectId={projectId} corpusId={corpusId}
            writable={writable && phaseRead.status === 'ready' && !recordPending && !freeze.pending}
            onPending={value => {setFullPending(value); onPending(value);}} />
        </LazyBoundary>}
      </section>}
      <ol start={offset + 1} className="flex flex-col gap-2">{phase.items.slice(offset, offset + 10).map((item, index) =>
        <li key={item.hit.id} className="flex flex-col gap-1" data-testid="artifact-review-title-item">
          <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending || locked}
            data-testid="artifact-review-title-select" aria-pressed={hitId === item.hit.id} onClick={() => {if (!guard.locked()) setHitId(item.hit.id);}}>
            {offset + index + 1}. 原始命中 {item.hit.recordIndex + 1} {screeningStatuses[item.status]}
            {' '}审核 {item.decisions.length}/{plan.snapshot.request.titleAbstractReviewers.length} 建议 {item.suggestionCount}
          </button>
          <p className="text-muted break-all">{item.hit.id}</p>
        </li>)}</ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending || offset === 0} onClick={() => setOffset(offset - 10)}>上一页记录</button>
        <span className="text-muted">第 {Math.floor(offset / 10) + 1} 页</span>
        <button type="button" className={button} disabled={pending || offset + 10 >= phase.items.length}
          onClick={() => setOffset(offset + 10)}>下一页记录</button>
      </div>
      {selected === undefined ? null : <div ref={focus} tabIndex={-1} aria-label="标题摘要原始记录核查" data-testid="artifact-review-title-focus">
        <ReviewTitleRecord key={`title-record:${selected.hit.id}`}
          client={client} protocol={protocol} phase={phase} item={selected} writable={editable && !freeze.pending}
          onPending={value => {setRecordPending(value); onPending(value);}} onSaved={phaseRead.reload} />
      </div>}
      {!editable ? null : <form className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2"
        data-testid="artifact-review-title-freeze-form" onSubmit={event => {
          event.preventDefault();
          if (busy.current || draft.isLocked() || !editable || pending || phase.counts.pending !== 0 || phase.counts.uncertain !== 0 || phase.counts.conflict !== 0) return;
          const body = {projectId, corpusId, phase: 'title_abstract' as const, expectedReviewHash: phase.reviewHash, reviewNote};
          const signature = JSON.stringify(body);
          let requestId = requests.current.get(signature);
          if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
          busy.current = true; onPending(true);
          void freeze.run({...body, requestId}).then(result => {
            busy.current = false; onPending(false); if (result.ok) {draft.saved(); phaseRead.reload();}
          });
        }}>
        <label className="flex flex-col gap-1 text-muted">标题摘要整轮审核说明
          <textarea required aria-label="标题摘要整轮审核说明" disabled={pending || draft.locked} maxLength={10000} rows={3}
            className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`} value={reviewNote}
            onChange={event => {setReviewNote(event.target.value); freeze.reset();}} />
        </label>
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={pending || draft.locked || reviewNote.trim() === '' || phase.counts.pending !== 0 || phase.counts.uncertain !== 0 || phase.counts.conflict !== 0}
          data-testid="artifact-review-title-freeze">确认并冻结整轮标题摘要筛选</button>
        <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-title-discard" onDiscard={() => {
          setReviewNote(''); freeze.reset(); draft.reset('');
        }} />
      </form>}
      {freeze.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{freeze.error}</p>}
    </>}
  </section>;
}

function ReviewTitleRecord({client, protocol, phase, item, writable, onPending, onSaved}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewScreeningFrozenPhase;
  item: ResearchReviewScreeningFrozenPhase['items'][number]; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const plan = phase.plan, {projectId, corpusId} = plan.snapshot.request;
  const read = useAsyncResource(`review:title-record:${plan.snapshotHash}:${item.hit.id}`,
    () => client.api.research.getReviewCorpusHit({projectId, corpusId, hitId: item.hit.id}), {label: '读取标题摘要原始记录'});
  const [reviewerId, setReviewerId] = useState(''), [decisionPending, setDecisionPending] = useState(false);
  const [arbitrationPending, setArbitrationPending] = useState(false);
  const pending = decisionPending || arbitrationPending;
  const guard = useArtifactEditorGuard();
  const locked = guard.locked();
  const parent = item.decisions.find(decision => decision.snapshot.request.reviewerId === reviewerId) ?? null;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-title-record">
    <h3 className="font-medium">原始标题摘要 {screeningStatuses[item.status]}</h3>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确原始命中…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.status !== 'ready' ? null : <>
      <p className="font-medium break-words">{read.data!.record.record.title}</p>
      <p className="break-words">{read.data!.record.record.abstract ?? '摘要未提供'}</p>
      <p className="text-muted">数据库 {read.data!.source.databaseIndex + 1} 检索式 {read.data!.source.queryIndex + 1}
        {' '}原始记录 {read.data!.reference.recordIndex + 1}</p>
      <details><summary className="cursor-pointer text-muted">完整原始元数据与固定引用</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">
          {JSON.stringify(read.data, null, 2)}
        </pre>
      </details>
      <label className="flex flex-col gap-1 text-muted">标题摘要审核人
        <select aria-label="标题摘要审核人" className={`${formInputClass} border-[0.5px]`} disabled={pending || locked} value={reviewerId}
          onChange={event => {if (!guard.locked()) setReviewerId(event.target.value);}}>
          <option value="">选择已声明审核人</option>
          {plan.snapshot.request.titleAbstractReviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>
            {reviewer.name} {reviewer.id}</option>)}
        </select>
      </label>
      {reviewerId === '' ? null : <ReviewTitleDecision key={`title-decision:${reviewerId}:${parent?.snapshotHash ?? 'new'}`}
        client={client} protocol={protocol} plan={plan} hitId={item.hit.id} reviewerId={reviewerId} parent={parent}
        writable={writable && !arbitrationPending} onPending={value => {setDecisionPending(value); onPending(value);}} onSaved={onSaved} />}
      <ReviewTitleArbitration key={`title-arbitration:${item.hit.id}:${item.arbitration?.snapshotHash ?? 'new'}:${item.decisions.map(decision => decision.snapshotHash).join(':')}`}
        client={client} protocol={protocol} phase={phase} item={item} writable={writable && !decisionPending}
        onPending={value => {setArbitrationPending(value); onPending(value);}} onSaved={onSaved} />
    </>}
  </section>;
}
