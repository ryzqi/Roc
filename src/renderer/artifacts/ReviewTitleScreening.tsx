import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewScreeningFrozenPhase, ResearchReviewScreeningPlanInspection} from '../../shared/schemas/research-review-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewTitleDecision} from './ReviewTitleDecision';
import {screeningStatuses} from './ReviewScreeningOutcome';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewTitleScreening({client, protocol, plan, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; plan: ResearchReviewScreeningPlanInspection;
  writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const {projectId, corpusId} = plan.snapshot.request;
  const phaseRead = useAsyncResource(`review:title-phase:${plan.snapshotHash}`,
    () => client.api.research.getReviewScreeningPhase({projectId, corpusId, phase: 'title_abstract'}), {label: '读取标题摘要人工筛选'});
  const phase = phaseRead.data;
  const [hitId, setHitId] = useState<string | null>(null), [pending, setPending] = useState(false);
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
    <button type="button" className={`${button} self-start`} disabled={pending || phaseRead.status === 'loading'}
      data-testid="artifact-review-title-refresh" onClick={phaseRead.reload}>重读标题摘要筛选</button>
    {phaseRead.status !== 'loading' ? null : <p role="status">正在读取实际人工筛选状态…</p>}
    {phaseRead.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{phaseRead.error}</p>}
    {phase === null || phaseRead.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的筛选回执。</p>}
    {phase === null ? null : <>
      <p data-testid="artifact-review-title-counts">待筛选 {phase.counts.recordsToScreen} = 待审 {phase.counts.pending}
        {' + '}无法判断 {phase.counts.uncertain}{' + '}冲突 {phase.counts.conflict}
        {' + '}纳入 {phase.counts.included}{' + '}排除 {phase.counts.excluded}</p>
      {phase.freeze === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-title-frozen">
        <h3 className="font-medium">标题摘要筛选已冻结</h3>
        <p className="break-words">{phase.freeze.request.reviewNote}</p>
        <p className="text-muted break-all">审核人 {phase.freeze.actor.id} {phase.freeze.frozenAt}</p>
      </section>}
      <ol start={offset + 1} className="flex flex-col gap-2">{phase.items.slice(offset, offset + 10).map((item, index) =>
        <li key={item.hit.id} className="flex flex-col gap-1" data-testid="artifact-review-title-item">
          <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending}
            data-testid="artifact-review-title-select" aria-pressed={hitId === item.hit.id} onClick={() => setHitId(item.hit.id)}>
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
          client={client} protocol={protocol} phase={phase} item={selected} writable={editable}
          onPending={value => {setPending(value); onPending(value);}} onSaved={phaseRead.reload} />
      </div>}
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
  const [reviewerId, setReviewerId] = useState(''), [pending, setPending] = useState(false);
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
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
          {JSON.stringify(read.data, null, 2)}
        </pre>
      </details>
      <label className="flex flex-col gap-1 text-muted">标题摘要审核人
        <select aria-label="标题摘要审核人" className={`${formInputClass} border-[0.5px]`} disabled={pending} value={reviewerId}
          onChange={event => setReviewerId(event.target.value)}>
          <option value="">选择已声明审核人</option>
          {plan.snapshot.request.titleAbstractReviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>
            {reviewer.name} {reviewer.id}</option>)}
        </select>
      </label>
      {reviewerId === '' ? null : <ReviewTitleDecision key={`title-decision:${reviewerId}:${parent?.snapshotHash ?? 'new'}`}
        client={client} protocol={protocol} plan={plan} hitId={item.hit.id} reviewerId={reviewerId} parent={parent}
        writable={writable} onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved} />}
    </>}
  </section>;
}
