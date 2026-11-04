import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewFullTextBinding} from './ReviewFullTextBinding';
import {ReviewFullTextEligibility} from './ReviewFullTextEligibility';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
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
  const pending = bindingPending || eligibilityPending;
  const [offset, setOffset] = useState(0);
  const selected = phase?.items.find(item => item.hit.id === hitId);
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected === undefined) return;
    focus.current?.scrollIntoView({block: 'start', behavior: 'instant'}); focus.current?.focus();
  }, [hitId, selected?.hit.id]);
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-fulltext">
    <h2 className="font-medium">全文获取与来源绑定</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || read.status === 'loading'}
      data-testid="artifact-review-fulltext-refresh" onClick={read.reload}>重读全文获取与来源</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取实际全文状态…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {phase === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的全文回执。</p>}
    {phase === null ? null : <>
      <p data-testid="artifact-review-fulltext-counts">需获取报告 {phase.counts.reportsToSeek} 待获取 {phase.counts.retrieval_pending}
        {' '}未获取 {phase.counts.not_retrieved} 来源变化 {phase.counts.source_changed} 待资格筛选 {phase.counts.pending}
        {' '}无法判断 {phase.counts.uncertain} 冲突 {phase.counts.conflict} 全文纳入 {phase.counts.included} 全文排除 {phase.counts.excluded}</p>
      {phase.freeze === null ? null : <p data-testid="artifact-review-fulltext-frozen" className="text-muted">全文资格筛选已冻结</p>}
      <ol start={offset + 1} className="flex flex-col gap-2">{phase.items.slice(offset, offset + 10).map((item, index) => <li key={item.hit.id}>
        <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending}
          data-testid="artifact-review-fulltext-select" aria-pressed={hitId === item.hit.id} onClick={() => setHitId(item.hit.id)}>
          {offset + index + 1}. 原始命中 {item.hit.recordIndex + 1} {statuses[item.status]}
        </button>
      </li>)}</ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending || offset === 0} onClick={() => setOffset(offset - 10)}>上一页全文</button>
        <span className="text-muted">第 {Math.floor(offset / 10) + 1} 页</span>
        <button type="button" className={button} disabled={pending || offset + 10 >= phase.items.length} onClick={() => setOffset(offset + 10)}>下一页全文</button>
      </div>
      {selected === undefined ? null : <div ref={focus} tabIndex={-1} aria-label="全文来源核查" data-testid="artifact-review-fulltext-focus">
        <ReviewFullTextBinding key={`fulltext-binding:${selected.hit.id}:${selected.binding?.snapshotHash ?? 'new'}`}
          client={client} projectId={projectId} corpusId={corpusId} hitId={selected.hit.id} titleFreezeHash={phase.titleFreezeHash}
          parent={selected.binding} writable={writable && !eligibilityPending && read.status === 'ready' && phase.plan.currentProtocol && phase.freeze === null}
          onPending={value => {setBindingPending(value); onPending(value);}} onSaved={read.reload} />
        {selected.binding?.snapshot.source === null || selected.binding === null ? null : <ReviewFullTextEligibility
          key={`full-eligibility:${selected.hit.id}:${selected.binding.snapshotHash}`}
          client={client} protocol={protocol} phase={phase} item={selected}
          writable={writable && !bindingPending && read.status === 'ready' && phase.plan.currentProtocol && phase.freeze === null}
          onPending={value => {setEligibilityPending(value); onPending(value);}} onSaved={read.reload} />}
      </div>}
    </>}
  </section>;
}
