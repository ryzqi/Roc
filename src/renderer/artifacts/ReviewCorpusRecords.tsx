import {useState} from 'react';
import type {ResearchReviewCorpusInspection} from '../../shared/schemas/research-review-corpus';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewCorpusRecords({client, corpus, disabled, onSelect}: {
  client: RocClient; corpus: ResearchReviewCorpusInspection; disabled: boolean;
  onSelect: ((side: 'left' | 'right', hitId: string) => void) | null
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const hits = corpus.snapshot.hits.slice(offset, offset + 10);
  const read = useAsyncResource(`review:corpus-records:${corpus.snapshotHash}:${offset}`, async () => {
    const results = await Promise.all(hits.map(hit => client.api.research.getReviewCorpusHit({
      projectId: corpus.snapshot.request.projectId, corpusId: corpus.snapshot.id, hitId: hit.id
    })));
    const items = [];
    for (const result of results) {
      if (!result.ok) return result;
      items.push(result.data);
    }
    return {ok: true as const, data: items};
  }, {label: '读取固定原始记录'});
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-review-corpus-records">
    <h3 className="font-medium">固定原始记录</h3>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确原始记录…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.status !== 'ready' ? null : read.data!.length === 0 ? <p className="text-muted">该语料没有原始记录。</p> :
      <ol start={offset + 1} className="flex flex-col gap-3">{read.data!.map((item, index) => <li key={item.reference.id}
        className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-corpus-record">
        <p className="font-medium break-words">{offset + index + 1}. {item.record.record.title}</p>
        <p className="text-muted">数据库 {item.source.databaseIndex + 1} 检索式 {item.source.queryIndex + 1} 原始记录 {item.reference.recordIndex + 1}</p>
        <p className="break-words">{item.record.record.doi ?? 'DOI 未提供'}</p>
        <p className="break-words">{item.record.record.abstract ?? '摘要未提供'}</p>
        {onSelect === null ? null : <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={disabled} data-testid="artifact-review-record-left"
            onClick={() => onSelect('left', item.reference.id)}>选为记录 A</button>
          <button type="button" className={button} disabled={disabled} data-testid="artifact-review-record-right"
            onClick={() => onSelect('right', item.reference.id)}>选为记录 B</button>
        </div>}
        <details><summary className="cursor-pointer text-muted">核对完整原始元数据</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono" tabIndex={0}>
            {JSON.stringify(item.record, null, 2)}
          </pre>
        </details>
      </li>)}</ol>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={disabled || offset === 0 || read.status === 'loading'}
        data-testid="artifact-review-records-previous" onClick={() => setOffset(offset - 10)}>上一页</button>
      <p className="text-muted">第 {Math.floor(offset / 10) + 1} 页</p>
      <button type="button" className={button} disabled={disabled || offset + 10 >= corpus.identifiedRecords || read.status === 'loading'}
        data-testid="artifact-review-records-next" onClick={() => setOffset(offset + 10)}>下一页</button>
    </div>
  </section>;
}
