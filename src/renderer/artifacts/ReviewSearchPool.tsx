import {useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewSearchPool({client, projectId, searchId}: {
  client: RocClient; projectId: string; searchId: string
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const read = useAsyncResource(`review:pool:${projectId}:${searchId}:${offset}`,
    () => client.api.research.getReviewSearchPool({projectId, reviewSearchId: searchId, offset, limit: 10}), {label: '读取原始检索记录'});
  const result = read.status === 'ready' ? read.data : null;
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-pool">
    <h3 className="font-medium">原始检索记录</h3>
    <button type="button" className={`${button} self-start`} disabled={read.status === 'loading'} onClick={read.reload}>重读原始记录</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取原始记录…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {result === null ? null : <>
      <p className="text-muted">原始记录 {result.pool.total} 条，保留重复记录与未知字段</p>
      <ol className="flex flex-col gap-3" start={offset + 1}>{result.pool.records.map((ranked, index) =>
        <li key={offset + index} className="flex min-w-0 flex-col gap-1" data-testid="artifact-review-pool-record">
          <p className="font-medium break-words">{offset + index + 1}. {ranked.record.title}</p>
          <p className="text-muted break-words">{ranked.record.source} 原始排名 {ranked.rank}
            {ranked.record.publishedYear === null ? ' 发表年份未知' : ` 发表年份 ${ranked.record.publishedYear}`}</p>
          <p className="break-words">{ranked.record.abstract ?? '摘要未提供'}</p>
          <details><summary className="cursor-pointer text-muted">原始元数据与来源声明</summary>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]"
              tabIndex={0}>{JSON.stringify(ranked, null, 2)}</pre>
          </details>
        </li>)}</ol>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={offset === 0} data-testid="artifact-review-pool-previous"
          onClick={() => setOffset(offset - 10)}>上一页</button>
        <p className="text-muted">第 {Math.floor(offset / 10) + 1} 页</p>
        <button type="button" className={button} disabled={result.pool.nextOffset === null} data-testid="artifact-review-pool-next"
          onClick={() => {if (result.pool.nextOffset !== null) setOffset(result.pool.nextOffset);}}>下一页</button>
      </div>
    </>}
  </section>;
}
