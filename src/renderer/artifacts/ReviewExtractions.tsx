import {useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewExtractionEditor} from './ReviewExtractionEditor';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewExtractions({client, protocol, phase, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewFullTextFrozenPhase;
  writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const {projectId, corpusId} = phase.plan.snapshot.request;
  const read = useAsyncResource(`review:extractions:${projectId}:${corpusId}:${phase.freezeHash}`,
    () => client.api.research.listReviewExtractions({projectId, corpusId}), {label: '读取真实证据提取'});
  const [hitId, setHitId] = useState<string | null>(null), [pending, setPending] = useState(false);
  const included = phase.freeze?.authority.items.filter(item => item.status === 'included') ?? [];
  const item = phase.items.find(item => item.hit.id === hitId);
  const parent = read.data?.find(extraction => extraction.snapshot.request.hitId === hitId) ?? null;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-extractions">
    <h2 className="font-medium">证据提取</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || read.status === 'loading'}
      data-testid="artifact-review-extractions-refresh" onClick={read.reload}>重读提取记录</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确提取记录…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的提取回执。</p>}
    <ul className="flex flex-col gap-2">{included.map((includedItem, index) => <li key={includedItem.hit.id}>
      <button type="button" className={`${button} h-auto py-1 text-left break-words`} disabled={pending}
        data-testid="artifact-review-extraction-select" aria-pressed={hitId === includedItem.hit.id} onClick={() => setHitId(includedItem.hit.id)}>
        纳入报告 {index + 1} 原始命中 {includedItem.hit.recordIndex + 1}
      </button>
    </li>)}</ul>
    {item?.binding === null || item === undefined || read.data === null ? null :
      <ReviewExtractionEditor key={`extraction:${item.hit.id}:${parent?.snapshotHash ?? 'new'}`} client={client} protocol={protocol}
        phase={phase} binding={item.binding} parent={parent} writable={writable && read.status === 'ready' && phase.plan.currentProtocol && phase.sourcesCurrent}
        onPending={value => {setPending(value); onPending(value);}} onSaved={read.reload} />}
  </section>;
}
