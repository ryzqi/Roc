import {useState} from 'react';
import type {ResourceSummary} from '../../shared/schemas/research-resources';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {scholarlyButton} from './ScholarlySnapshotView';

const reported = (value: string | null): string => value === null ? '未报告' : value;
export default function ResourceObservationView({client, resource}: {
  client: RocClient; resource: ResourceSummary;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const read = useAsyncResource(JSON.stringify([resource.projectId, resource.id, offset]),
    () => client.api.research.getResource({projectId: resource.projectId, resourceId: resource.id, offset, limit: 50}),
    {label: '读取资源观察'});
  const metadata = resource.metadata;
  const next = read.data?.nextOffset ?? null;
  return <section aria-label="资源观察" className="space-y-2" data-testid="reader-resource-observation">
    <h3 className="break-words font-medium">{metadata === null ? resource.request.doi : metadata.titles[0].title}</h3>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-muted">
      <dt>DOI</dt><dd className="break-all">{resource.request.doi}</dd>
      <dt>查询时间</dt><dd>{resource.queriedAt}</dd>
      <dt>获取时间</dt><dd>{reported(resource.fetchedAt)}</dd>
      <dt>本次请求</dt><dd>{resource.status === 'ok' ? '元数据已保存' : '元数据不可用'}</dd>
      {metadata === null ? null : <>
        <dt>资源类型</dt><dd>{metadata.kind === 'dataset' ? '数据集' : '软件'} {reported(metadata.resourceType)}</dd>
        <dt>报告版本</dt><dd>{reported(metadata.version)}</dd>
        <dt>报告 Schema</dt><dd>{reported(metadata.reportedSchemaVersion)}</dd>
        <dt>资源页面</dt><dd className="break-all">{reported(metadata.landingPage)}</dd>
      </>}
      {resource.errorCode === null ? null : <><dt>错误</dt><dd className="text-[var(--st-bad)]">{resource.errorCode}</dd></>}
    </dl>
    {metadata === null ? null : <details data-testid="reader-resource-rights">
      <summary className="cursor-pointer text-muted">来源许可字段</summary>
      {metadata.rights === null ? <p>来源未报告许可</p> : metadata.rights.length === 0 ? <p>来源报告的许可集合为空</p> :
        <ul className="space-y-2 py-1">{metadata.rights.map((right, index) => <li key={index}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
            {Object.entries(right).map(([key, value]) => <div key={key} className="contents">
              <dt>{key}</dt><dd className="break-all">{reported(value)}</dd>
            </div>)}
          </dl>
        </li>)}</ul>}
    </details>}
    <details data-testid="reader-resource-receipts">
      <summary className="cursor-pointer text-muted">观察与请求回执</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-muted">
        <dt>观察 SHA-256</dt><dd className="break-all font-mono">{resource.contentHash}</dd>
        <dt>响应 SHA-256</dt><dd className="break-all font-mono">{reported(resource.responseHash)}</dd>
        <dt>端点</dt><dd className="break-all">{resource.endpoint}</dd>
        <dt>缓存</dt><dd>{resource.cache === 'hit' ? '命中已验证观察' : '未命中'}</dd>
        <dt>实际 GET</dt><dd>{resource.requests.length} 次</dd>
        <dt>治理状态</dt><dd>{resource.governance.state}</dd>
      </dl>
      <ul className="space-y-1 text-muted">{resource.requests.map((request, index) => <li key={index} className="break-all">
        {request.status === null ? '未取得 HTTP 状态' : `HTTP ${request.status}`} {request.errorCode === null ? '' : request.errorCode}
      </li>)}</ul>
    </details>
    <details data-testid="reader-resource-relations-disclosure">
    <summary className="cursor-pointer text-muted">来源关系</summary>
    {read.status === 'loading' ? <p role="status">读取关系中</p> : null}
    {read.error === null ? null : <div role="alert"><p>{read.error}</p>
      <button type="button" className={scholarlyButton} onClick={read.reload}>重试资源读取</button></div>}
    {read.data === null ? null : <>
      <p className="text-muted">{read.data.total === null ? '来源未报告关系集合' : `来源报告 ${read.data.total} 条关系`}</p>
      <ol className="space-y-2" data-testid="reader-resource-relations">{read.data.relatedIdentifiers.map((relation, index) =>
        <li key={offset + index} className="border-b-[0.5px] border-line pb-2">
          <p className="break-all">{resource.request.doi} → {relation.relatedIdentifier}</p>
          <p className="break-words text-muted">{relation.relatedIdentifierType} {relation.relationType}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
            {Object.entries(relation).filter(([key]) => !['relatedIdentifier', 'relatedIdentifierType', 'relationType'].includes(key))
              .map(([key, value]) => <div key={key} className="contents"><dt>{key}</dt><dd className="break-all">{reported(value)}</dd></div>)}
          </dl>
        </li>)}</ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={scholarlyButton} disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>资源关系上一页</button>
        <button type="button" className={scholarlyButton} disabled={next === null} onClick={() => setOffset(next!)}>资源关系下一页</button>
      </div>
    </>}
    </details>
  </section>;
}
