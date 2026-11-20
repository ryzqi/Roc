import { useEffect, useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewFullTextFreezeRequest} from '../../shared/schemas/research-review-fulltext-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewFullTextBinding} from './ReviewFullTextBinding';
import {ReviewFullTextEligibility} from './ReviewFullTextEligibility';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const ReviewExtractions = retryableLazy(async () => ({default: (await import('./ReviewExtractions')).ReviewExtractions}));
const ReviewStudies = retryableLazy(async () => ({default: (await import('./ReviewStudies')).ReviewStudies}));
const ReviewReport = retryableLazy(async () => ({default: (await import('./ReviewReport')).ReviewReport}));
const statuses = {retrieval_pending: '待获取', not_retrieved: '未获取', source_changed: '来源已变化',
  pending: '待资格筛选', uncertain: '无法判断', conflict: '决定冲突', included: '全文纳入', excluded: '全文排除'} as const;
export function ReviewFullTextBindings({client, protocol, projectId, corpusId, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; projectId: string; corpusId: string;
  writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const read = useAsyncResource(`review:fulltext-phase:${projectId}:${corpusId}`,
    () => client.api.research.getReviewFullTextScreeningPhase({projectId, corpusId, phase: 'full_text'}), {label: '读取全文获取与资格筛选'});
  const phase = read.data;
  const [hitId, setHitId] = useState<string | null>(null), [bindingPending, setBindingPending] = useState(false);
  const [eligibilityPending, setEligibilityPending] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [extractionsOpen, setExtractionsOpen] = useState(false), [extractionPending, setExtractionPending] = useState(false);
  const [studiesOpen, setStudiesOpen] = useState(false), [studiesPending, setStudiesPending] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const freeze = useAsyncAction((request: ResearchReviewFullTextFreezeRequest) => client.api.research.freezeReviewFullTextScreening(request),
    {label: '冻结全文获取与资格筛选'});
  const pending = bindingPending || eligibilityPending || freeze.pending || extractionPending || studiesPending;
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('全文整轮审核说明', reviewNote, busy);
  const guard = useArtifactEditorGuard();
  const selectionLocked = guard.locked();
  const editable = writable && read.status === 'ready' && phase?.plan.currentProtocol === true && phase.freeze === null;
  const complete = phase !== null && phase.sourcesCurrent && phase.counts.retrieval_pending === 0 && phase.counts.source_changed === 0 &&
    phase.counts.pending === 0 && phase.counts.uncertain === 0 && phase.counts.conflict === 0;
  const [offset, setOffset] = useState(0);
  const selected = phase?.items.find(item => item.hit.id === hitId);
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected === undefined) return;
    focus.current?.scrollIntoView({block: 'start', behavior: 'instant'}); focus.current?.focus();
  }, [hitId, selected?.hit.id]);
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-fulltext">
    <h2 className="font-medium">全文获取与来源绑定</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked || read.status === 'loading'}
      data-testid="artifact-review-fulltext-refresh" onClick={() => {if (!guard.locked()) read.reload();}}>重读全文获取与来源</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取实际全文状态…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {phase === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的全文回执。</p>}
    {phase === null ? null : <>
      <p className="tabular-nums" data-testid="artifact-review-fulltext-counts">需获取报告 {phase.counts.reportsToSeek} 待获取 {phase.counts.retrieval_pending}
        {' '}未获取 {phase.counts.not_retrieved} 来源变化 {phase.counts.source_changed} 待资格筛选 {phase.counts.pending}
        {' '}无法判断 {phase.counts.uncertain} 冲突 {phase.counts.conflict} 全文纳入 {phase.counts.included} 全文排除 {phase.counts.excluded}</p>
      {phase.freeze === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-fulltext-frozen">
        <h3 className="font-medium">全文资格筛选已冻结</h3>
        <p className="tabular-nums">需获取报告 {phase.freeze.authority.counts.reportsToSeek} = 未获取 {phase.freeze.authority.counts.not_retrieved}
          {' + '}全文纳入 {phase.freeze.authority.counts.included}{' + '}全文排除 {phase.freeze.authority.counts.excluded}</p>
        <p className="break-words">{phase.freeze.request.reviewNote}</p>
        <p className="text-muted break-all">审核人 {phase.freeze.actor.id} {phase.freeze.frozenAt}</p>
        {phase.sourcesCurrent ? null : <p className="text-[var(--st-warn)]">冻结后的来源引用已变化，旧审查收据保留。</p>}
        <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked} data-testid="artifact-review-extractions-inspect"
          onClick={() => {if (!guard.locked()) setExtractionsOpen(true);}}>核查证据提取</button>
        {!extractionsOpen ? null : <LazyBoundary fallback={<p role="status">正在加载证据提取…</p>}>
          <ReviewExtractions key={`extractions:${phase.freezeHash}`} client={client} protocol={protocol} phase={phase}
            writable={writable && read.status === 'ready' && !studiesPending} onPending={value => {setExtractionPending(value); onPending(value);}} />
        </LazyBoundary>}
        <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked} data-testid="artifact-review-studies-inspect"
          onClick={() => {if (!guard.locked()) setStudiesOpen(true);}}>核查纳入报告与研究归组</button>
        {!studiesOpen ? null : <LazyBoundary fallback={<p role="status">正在加载研究归组…</p>}>
          <ReviewStudies key={`studies:${phase.freezeHash}`} client={client} phase={phase}
            writable={writable && read.status === 'ready' && !extractionPending} onPending={value => {setStudiesPending(value); onPending(value);}} />
        </LazyBoundary>}
        <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked} data-testid="artifact-review-report-inspect"
          onClick={() => {if (!guard.locked()) setReportOpen(true);}}>核查综述计数与证据报告</button>
        {!reportOpen ? null : <LazyBoundary fallback={<p role="status">正在加载综述报告…</p>}>
          <ReviewReport key={`report:${phase.freezeHash}`} client={client} projectId={projectId} corpusId={corpusId}
            disabled={pending || read.status !== 'ready'} />
        </LazyBoundary>}
      </section>}
      <ol start={offset + 1} className="flex flex-col gap-2">{phase.items.slice(offset, offset + 10).map((item, index) => <li key={item.hit.id}>
        <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending || selectionLocked}
          data-testid="artifact-review-fulltext-select" aria-pressed={hitId === item.hit.id} onClick={() => {if (!guard.locked()) setHitId(item.hit.id);}}>
          {offset + index + 1}. 原始命中 {item.hit.recordIndex + 1} {statuses[item.status]}
        </button>
      </li>)}</ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending || selectionLocked || offset === 0}
          onClick={() => {if (!guard.locked()) setOffset(offset - 10);}}>上一页全文</button>
        <span className="text-muted tabular-nums">第 {Math.floor(offset / 10) + 1} 页</span>
        <button type="button" className={button} disabled={pending || selectionLocked || offset + 10 >= phase.items.length}
          onClick={() => {if (!guard.locked()) setOffset(offset + 10);}}>下一页全文</button>
      </div>
      {selected === undefined ? null : <div ref={focus} tabIndex={-1} aria-label="全文来源核查" data-testid="artifact-review-fulltext-focus">
        <ReviewFullTextBinding key={`fulltext-binding:${selected.hit.id}:${selected.binding?.snapshotHash ?? 'new'}`}
          client={client} projectId={projectId} corpusId={corpusId} hitId={selected.hit.id} titleFreezeHash={phase.titleFreezeHash}
          parent={selected.binding} writable={editable && !eligibilityPending && !freeze.pending}
          onPending={value => {setBindingPending(value); onPending(value);}} onSaved={read.reload} />
        {selected.binding?.snapshot.source === null || selected.binding === null ? null : <ReviewFullTextEligibility
          key={`full-eligibility:${selected.hit.id}:${selected.binding.snapshotHash}`}
          client={client} protocol={protocol} phase={phase} item={selected}
          writable={editable && !bindingPending && !freeze.pending}
          onPending={value => {setEligibilityPending(value); onPending(value);}} onSaved={read.reload} />}
      </div>}
      {!editable ? null : <form className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2"
        data-testid="artifact-review-full-freeze-form" onSubmit={event => {
          event.preventDefault();
          if (busy.current || pending || !editable || !complete || draft.isLocked()) return;
          const body = {projectId, corpusId, phase: 'full_text' as const, expectedReviewHash: phase.reviewHash, reviewNote};
          const signature = JSON.stringify(body);
          let requestId = requests.current.get(signature);
          if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
          busy.current = true; onPending(true);
          void freeze.run({...body, requestId}).then(result => {
            busy.current = false; onPending(false); if (result.ok) {draft.saved(); read.reload();}
          });
        }}>
        <label className="flex flex-col gap-1 text-muted">全文整轮审核说明
          <textarea required aria-label="全文整轮审核说明" maxLength={10000} rows={3} disabled={pending || draft.locked}
            className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`} value={reviewNote}
            onChange={event => {setReviewNote(event.target.value); freeze.reset();}} />
        </label>
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={pending || draft.locked || !complete || reviewNote.trim() === ''} data-testid="artifact-review-full-freeze">确认并冻结整轮全文审查</button>
        <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-full-freeze-discard" onDiscard={() => {
          setReviewNote(''); freeze.reset(); draft.reset('');
        }} />
      </form>}
      {freeze.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{freeze.error}</p>}
    </>}
  </section>;
}
