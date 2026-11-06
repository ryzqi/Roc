import {useState} from 'react';
import type {ScholarlyProvider, ScholarlyRelation, ScholarlySnapshotSummary} from '../../shared/schemas/research-scholarly-relations';
import {useAsyncResource} from '../app/use-async-resource';
import type {RocClient} from '../shared/roc-client';

export const providerNames: Record<ScholarlyProvider, string> = {openalex: 'OpenAlex', crossref: 'Crossref', semantic_scholar: 'Semantic Scholar'};
export const scholarlyButton = 'inline-flex min-h-[var(--control-height-compact)] flex-wrap items-center gap-x-2 rounded-control border-[0.5px] border-line px-2 py-1 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40';
const relationNames: Record<ScholarlyRelation['kind'], string> = {cites: '引用', version: '版本关系',
  correction: '勘误', retraction: '撤稿', provider_relation: '来源关系'};
const reported = (value: boolean | null): string => value === null ? '未知' : value ? '已报告' : '未报告';
const identity = (value: ScholarlyRelation['subject']): string => `${value.scheme}: ${value.value}`;

export default function ScholarlySnapshotView({client, snapshot, currentRevision, busy, canQuery, onNextPage}: {
  client: RocClient; snapshot: ScholarlySnapshotSummary; currentRevision: number; busy: boolean; canQuery: boolean;
  onNextPage: (offset: number, limit: number) => void;
}): React.JSX.Element {
  const [source, setSource] = useState<ScholarlyProvider>(snapshot.request.sources[0]!);
  const [offset, setOffset] = useState(0);
  const relations = useAsyncResource(JSON.stringify([snapshot.projectId, snapshot.itemId, snapshot.id, source, offset]),
    () => client.api.research.getScholarlyRelations({projectId: snapshot.projectId, itemId: snapshot.itemId,
      snapshotId: snapshot.id, source, offset, limit: 50}), {label: '读取关系'});
  const next = relations.data?.nextOffset ?? null;
  return <div className="space-y-2 border-t-[0.5px] border-line pt-2" data-testid="reader-scholarly-snapshot">
    <div className="flex flex-wrap gap-x-3 text-muted">
      <span>{snapshot.queriedAt}</span><span>文献版本 {snapshot.itemRevision}</span>
      <span>{snapshot.doi}</span>
    </div>
    {snapshot.itemRevision === currentRevision ? null : <p role="status" className="text-[var(--st-warn)]">文献版本已改变，此处展示历史来源观察</p>}
    {snapshot.sources.map(observation => <details key={observation.source} className="border-b-[0.5px] border-line pb-1"
      data-testid={`reader-scholarly-source-${observation.source}`}>
      <summary className="cursor-pointer">
        {providerNames[observation.source]}：{observation.status === 'ok' ? `本次请求成功，${observation.relationCount} 条关系` : '请求失败'}
      </summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted text-[var(--font-meta-size)]">
        <dt>参考文献字段</dt><dd>{reported(observation.referencesReported)}</dd>
        <dt>关系字段</dt><dd>{reported(observation.relationsReported)}</dd>
        <dt>更新字段</dt><dd>{reported(observation.updatesReported)}</dd>
        <dt>未映射参考文献</dt><dd>{observation.unmappedReferences === null ? '未知' : observation.unmappedReferences}</dd>
        <dt>撤稿观察</dt><dd>{observation.retraction === 'retracted' ? '来源报告撤稿' : observation.retraction === 'not_reported' ? '来源未报告撤稿' : '未知'}</dd>
        <dt>获取时间</dt><dd>{observation.fetchedAt ?? '未知'}</dd>
        <dt>缓存</dt><dd>{observation.cache === 'hit' ? '命中' : '未命中'}</dd>
        <dt>请求回执</dt><dd>{observation.requests.length} 次 GET</dd>
        <dt>响应 SHA-256</dt><dd className="break-all font-mono">{observation.responseHash ?? '未知'}</dd>
        <dt>查询端点</dt><dd className="break-all font-mono">{observation.endpoint}</dd>
        {observation.errorCode === null ? null : <><dt>错误</dt><dd className="break-words text-[var(--st-bad)]">{observation.errorCode}</dd></>}
        {observation.retryAfterMs === null ? null : <><dt>来源要求等待</dt><dd>{observation.retryAfterMs} ms</dd></>}
      </dl>
      {observation.nextOffset === null ? null : <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">来源还有后续页（offset {observation.nextOffset}），需另存一次观察</span>
        <button type="button" className={scholarlyButton} disabled={busy || !canQuery || observation.nextOffset > 9900}
          onClick={() => onNextPage(observation.nextOffset!, snapshot.request.limit)}>查询来源下一页</button>
        {observation.nextOffset > 9900 ? <span>已达到当前查询上限</span> : null}
      </div>}
    </details>)}
    <div className="flex flex-wrap items-center gap-2">
      <label>关系来源 <select value={source} disabled={busy} className="rounded-control border-[0.5px] border-line bg-surface px-2 py-1"
        onChange={event => {setSource(event.target.value as ScholarlyProvider); setOffset(0);}}>
        {snapshot.request.sources.map(value => <option key={value} value={value}>{providerNames[value]}</option>)}
      </select></label>
      <span className="text-muted tabular-nums">{relations.data === null ? '' : `${relations.data.total} 条，当前 ${offset + (relations.data.relations.length > 0 ? 1 : 0)}–${offset + relations.data.relations.length}`}</span>
    </div>
    {relations.status === 'loading' ? <p role="status">读取关系中</p> : null}
    {relations.error === null ? null : <div role="alert"><p>{relations.error}</p>
      <button type="button" className={scholarlyButton} onClick={relations.reload}>重试关系</button></div>}
    {relations.data === null ? null : <>
      {relations.data.relations.length === 0 ? <p className="text-muted">本次观察没有映射关系，请结合来源字段状态判断</p> :
        <ol className="space-y-2" data-testid="reader-scholarly-relations">
          {relations.data.relations.map((row, index) => <li key={offset + index} className="border-b-[0.5px] border-line pb-2">
            <p className="break-all">{identity(row.subject)} → {identity(row.object)}</p>
            <p className="flex flex-wrap gap-x-3 text-muted text-[var(--font-meta-size)]">
              <span>{relationNames[row.kind]}</span><span className="break-all">{row.providerType}</span>
              <span className="break-all">{row.field}</span>
              {row.assertedBy === null ? null : <span>断言方：{row.assertedBy}</span>}
            </p>
          </li>)}
        </ol>}
      <div className="flex gap-2">
        <button type="button" className={scholarlyButton} disabled={busy || offset === 0}
          onClick={() => setOffset(current => Math.max(0, current - 50))}>关系上一页</button>
        <button type="button" className={scholarlyButton} disabled={busy || next === null}
          onClick={() => setOffset(next!)}>关系下一页</button>
      </div>
    </>}
  </div>;
}
