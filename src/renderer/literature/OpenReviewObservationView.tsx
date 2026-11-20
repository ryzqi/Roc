import {useState} from 'react';
import type {OpenReviewSummary} from '../../shared/schemas/research-openreview';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';
import OpenReviewEntryView from './OpenReviewEntryView';

export default function OpenReviewObservationView({client, observation, writable, onNextPage}: {
  client: RocClient; observation: OpenReviewSummary; writable: boolean; onNextPage: () => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const read = useAsyncResource(JSON.stringify([observation.projectId, observation.id, offset]),
    () => client.api.research.getOpenReviewObservation({projectId: observation.projectId, observationId: observation.id, offset, limit: 20}),
    {label: '读取 OpenReview 来源'});
  const sourceReady = read.status === 'ready' && read.data?.observation.contentHash === observation.contentHash;
  return <section aria-label="OpenReview 观察" className="space-y-2" data-testid="reader-openreview-observation">
    <h3 className="break-all font-medium">{observation.request.query.target}</h3>
    <p className="text-muted">公开意见未核查；当前 Note 与修改差量分别保存。</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>查询时间</dt><dd>{observation.queriedAt}</dd>
      <dt>获取时间</dt><dd>{observation.fetchedAt ?? '未报告'}</dd>
      <dt>本次观察</dt><dd>{observation.status === 'ok' ? '公开来源已保存' : '公开来源不可用'}</dd>
      <dt>本页记录</dt><dd className="tabular-nums">{observation.entryCount ?? '未知'}</dd>
      <dt>来源报告总数</dt><dd className="tabular-nums">{observation.providerTotal ?? '未知'}</dd>
      <dt>请求游标</dt><dd className="break-all font-mono">{observation.request.query.after ?? '起始页'}</dd>
      {observation.errorCode === null ? null : <><dt>错误</dt><dd className="break-all text-[var(--st-bad)]">{observation.errorCode}</dd></>}
    </dl>
    <details data-testid="reader-openreview-receipts">
      <summary className="cursor-pointer text-muted">OpenReview 请求回执</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted">
        <dt>观察 SHA-256</dt><dd className="break-all font-mono">{observation.contentHash}</dd>
        <dt>响应 SHA-256</dt><dd className="break-all font-mono">{observation.responseHash ?? '未报告'}</dd>
        <dt>端点</dt><dd className="break-all">{observation.endpoint}</dd>
        <dt>缓存</dt><dd>{observation.cache === 'hit' ? '命中' : '未命中'}</dd>
        <dt>实际 GET</dt><dd>{observation.requests.length} 次</dd>
        <dt>治理状态</dt><dd>{observation.governance.state}</dd>
        <dt>下一查询游标</dt><dd className="break-all font-mono">{observation.nextAfter ?? '无'}</dd>
      </dl>
    </details>
    {read.status === 'loading' ? <p role="status">读取 OpenReview 记录中</p> : null}
    {read.error === null ? null : <div role="alert"><p>{read.error}</p>
      <button type="button" className={scholarlyButton} onClick={read.reload}>重试 OpenReview 来源读取</button></div>}
    {read.data === null ? null : <>
      {read.data.total === null ? <p className="text-muted">公开记录数量未知</p> : read.data.total === 0 ?
        <p className="text-muted">来源本页报告 0 条公开记录</p> : null}
      <ul className="space-y-2 py-1" data-testid="reader-openreview-entries">
        {read.data.entries.map(entry => <li key={entry.kind === 'note' ? entry.note.id : entry.edit.id}
          className="border-b-[0.5px] border-line pb-1"><OpenReviewEntryView entry={entry}/></li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={scholarlyButton} disabled={read.status === 'loading' || offset === 0}
          onClick={() => setOffset(value => Math.max(0, value - 20))}>OpenReview 记录上一页</button>
        <button type="button" className={scholarlyButton} disabled={read.status === 'loading' || read.data.nextOffset === null}
          onClick={() => setOffset(read.data!.nextOffset!)}>OpenReview 记录下一页</button>
      </div>
    </>}
    {observation.nextAfter === null ? null : <button type="button" className={scholarlyButton} disabled={!writable || !sourceReady}
      onClick={onNextPage}>查询并保存下一来源页</button>}
  </section>;
}
