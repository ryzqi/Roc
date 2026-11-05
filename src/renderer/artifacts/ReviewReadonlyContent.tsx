import type {ResearchReviewLink} from '../../shared/schemas/research-review-links';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewCorpusInspection} from '../../shared/schemas/research-review-corpus';
import type {ResearchReviewReportInspection} from '../../shared/schemas/research-review-report';
import type {ResearchReviewSearchInspection} from '../../shared/schemas/research-review-search';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewCorpusRecords} from './ReviewCorpusRecords';
import {ReviewReportBody} from './ReviewReport';
import {ReviewSearchPool} from './ReviewSearchPool';
import {reviewSearchStatuses} from './ReviewSearchQuery';

type Inspection =
  | {kind: 'protocol'; protocol: ResearchReviewProtocolInspection}
  | {kind: 'corpus'; corpus: ResearchReviewCorpusInspection; protocol: ResearchReviewProtocolInspection}
  | {kind: 'query'; search: ResearchReviewSearchInspection; protocol: ResearchReviewProtocolInspection}
  | {kind: 'report'; report: ResearchReviewReportInspection};

export function ReviewReadonlyContent({client, link}: {client: RocClient; link: ResearchReviewLink}): React.JSX.Element {
  const read = useAsyncResource<Inspection>(`review:readonly:${JSON.stringify([link.projectId, link.target])}`, async () => {
    const {projectId, target} = link;
    switch (target.kind) {
      case 'protocol': {
        const result = await client.api.research.getReviewProtocol({projectId, versionId: target.versionId});
        if (!result.ok) return result;
        if (result.data.versionHash !== target.expectedVersionHash || result.data.freezeHash !== target.expectedFreezeHash) {
          throw new Error('协议或冻结回执与链接不一致，无法核查。');
        }
        return {ok: true, data: {kind: 'protocol', protocol: result.data}};
      }
      case 'query': {
        const result = await client.api.research.getReviewSearch({projectId, reviewSearchId: target.reviewSearchId});
        if (!result.ok) return result;
        if (result.data.snapshotHash !== target.expectedSnapshotHash) throw new Error('查询快照与链接不一致，无法核查。');
        const snapshot = result.data.snapshot;
        const protocol = await client.api.research.getReviewProtocol({projectId, versionId: snapshot.request.versionId});
        if (!protocol.ok) return protocol;
        if (protocol.data.versionHash !== snapshot.protocolVersionHash || protocol.data.freezeHash !== snapshot.request.expectedFreezeHash) {
          throw new Error('查询对应的协议回执与保存记录不一致，无法核查。');
        }
        return {ok: true, data: {kind: 'query', search: result.data, protocol: protocol.data}};
      }
      case 'corpus': {
        const result = await client.api.research.getReviewCorpus({projectId, corpusId: target.corpusId});
        if (!result.ok) return result;
        if (result.data.snapshotHash !== target.expectedCorpusHash) throw new Error('语料回执与链接不一致，无法核查。');
        const protocol = await client.api.research.getReviewProtocol({projectId, versionId: result.data.snapshot.request.versionId});
        if (!protocol.ok) return protocol;
        if (protocol.data.versionHash !== result.data.snapshot.protocolVersionHash ||
            protocol.data.freezeHash !== result.data.snapshot.request.expectedFreezeHash) {
          throw new Error('语料对应的协议回执已变化，无法核查。');
        }
        return {ok: true, data: {kind: 'corpus', corpus: result.data, protocol: protocol.data}};
      }
      case 'report': {
        const result = await client.api.research.getReviewReport({projectId, corpusId: target.corpusId});
        if (!result.ok) return result;
        if (result.data.bodyHash !== target.expectedBodyHash) throw new Error('报告内容已变化，请从助手重新读取后打开新链接。');
        return {ok: true, data: {kind: 'report', report: result.data}};
      }
    }
  }, {label: '读取链接对应的准确综述回执'});
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-readonly">
    <h2 className="font-medium">{link.title}</h2>
    <p className="text-muted">仅阅读链接对应的记录</p>
    <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`}
      data-testid="artifact-review-readonly-refresh" disabled={read.status === 'loading'} onClick={read.reload}>重读准确回执</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确综述回执…</p>}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次已核对的回执。</p>}
    <details><summary className="cursor-pointer text-muted">链接目标与校验依据</summary>
      <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
        {JSON.stringify({projectId: link.projectId, target: link.target}, null, 2)}
      </pre>
    </details>
    {read.data === null ? null : <ReceiptBody key={JSON.stringify(link.target)} client={client} inspection={read.data} />}
  </section>;
}

function ProtocolBody({protocol}: {protocol: ResearchReviewProtocolInspection}): React.JSX.Element {
  const {body} = protocol.version;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-review-readonly-protocol">
    <h3 className="font-medium whitespace-pre-wrap break-words">{body.question}</h3>
    <p className="text-muted">版本 {protocol.version.version} {protocol.isLatest ? '当前版本' : '历史版本'}
      {' '}{protocol.freeze === null ? '草稿' : '已冻结'}</p>
    <p className="break-all text-muted text-[var(--font-meta-size)]">版本 SHA-256 {protocol.versionHash}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-muted">发表年份</dt><dd>{body.publicationYears.from ?? '不限'} 至 {body.publicationYears.to ?? '不限'}</dd>
      <dt className="text-muted">标题摘要审核</dt><dd>{body.screening.titleAbstractReviewers} 人</dd>
      <dt className="text-muted">全文审核</dt><dd>{body.screening.fullTextReviewers} 人</dd>
      <dt className="text-muted">冲突处理</dt><dd>人工仲裁</dd>
      {body.pico === null ? <><dt className="text-muted">PICO</dt><dd>未声明</dd></> :
        [['人群', body.pico.population], ['干预', body.pico.intervention], ['对照', body.pico.comparator], ['结局', body.pico.outcome]]
        .map(([key, value]) => <div key={key} className="contents">
          <dt className="text-muted">{key}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd>
        </div>)}
    </dl>
    <h4 className="font-medium">纳入标准</h4>
    <ol className="list-decimal pl-5">{body.inclusionCriteria.map(criterion =>
      <li key={criterion.id} className="whitespace-pre-wrap break-words">{criterion.text}</li>)}</ol>
    <h4 className="font-medium">排除标准</h4>
    <ol className="list-decimal pl-5">{body.exclusionCriteria.map(criterion =>
      <li key={criterion.id} className="whitespace-pre-wrap break-words">{criterion.text}</li>)}</ol>
    <details><summary className="cursor-pointer font-medium">分库查询 {body.databases.length}</summary>
      <ul className="mt-2 flex flex-col gap-2">{body.databases.map(database => <li key={database.source}>
        <p>{database.source} 每页 {database.pageSize} 条 最多 {database.maxPages} 页</p>
        <ol className="list-decimal pl-5">{database.queries.map(query => <li key={query} className="whitespace-pre-wrap break-words">{query}</li>)}</ol>
      </li>)}</ul>
    </details>
    <details><summary className="cursor-pointer font-medium">质量框架与提取字段</summary>
      <ul className="mt-2 flex flex-col gap-1">{body.qualityAssessment.map((framework, index) => <li key={index} className="break-words">
        {framework.studyDesign} {framework.framework} {framework.version}
      </li>)}</ul>
      <ul className="mt-2 flex flex-col gap-1">{body.extractionFields.map(field => <li key={field.id} className="break-words">
        {field.label} {field.unit ?? '未声明单位'} {field.required ? '必填' : '可选'}
      </li>)}</ul>
    </details>
    <details><summary className="cursor-pointer text-muted">完整协议与冻结回执</summary>
      <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
        {JSON.stringify(protocol, null, 2)}
      </pre>
    </details>
  </section>;
}

function ReceiptBody({client, inspection}: {client: RocClient; inspection: Inspection}): React.JSX.Element {
  switch (inspection.kind) {
    case 'protocol': return <ProtocolBody protocol={inspection.protocol} />;
    case 'report': return <ReviewReportBody report={inspection.report} />;
    case 'query': return <QueryBody client={client} search={inspection.search} protocol={inspection.protocol} />;
    case 'corpus': return <>
      <ProtocolBody protocol={inspection.protocol} />
      <p data-testid="artifact-review-readonly-corpus">准确语料原始记录 {inspection.corpus.identifiedRecords}
        {' '}{inspection.corpus.searchCoverageComplete ? '查询分页覆盖完整' : '查询分页覆盖有缺口'}
        {' '}{inspection.corpus.currentProtocol ? '对应当前协议' : '协议版本已变化'}</p>
      <details><summary className="cursor-pointer text-muted">固定查询来源与回执</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
          {JSON.stringify(inspection.corpus.snapshot.sources, null, 2)}
        </pre>
      </details>
      <ReviewCorpusRecords client={client} corpus={inspection.corpus} disabled={false} onSelect={null} />
    </>;
  }
}

function QueryBody({client, search, protocol}: {
  client: RocClient; search: ResearchReviewSearchInspection; protocol: ResearchReviewProtocolInspection
}): React.JSX.Element {
  const {snapshot} = search, parameters = snapshot.parameters;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-review-readonly-query">
    <h3 className="font-medium">{parameters.sources.join(' / ')} 查询回执</h3>
    <p className="whitespace-pre-wrap break-words">{parameters.query}</p>
    <p role="status" data-testid="artifact-review-readonly-query-status">{reviewSearchStatuses[search.status]}</p>
    <p className="text-muted">{search.receipt === null ? '记录数与覆盖等待终态回执' :
      `原始记录 ${search.rawRecordCount} 条，${search.coverageComplete ? '查询范围已到数据库报告终点' : '检索覆盖不完整'}`}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-muted">查询开始</dt><dd className="break-words">{snapshot.startedAt}</dd>
      <dt className="text-muted">查询结束</dt><dd className="break-words">{search.receipt?.endedAt ?? '尚无终态回执'}</dd>
      <dt className="text-muted">分页上限</dt><dd>每页 {parameters.limit} 条，最多 {parameters.maxPages} 页</dd>
      <dt className="text-muted">发表年份</dt><dd>{parameters.yearFrom ?? '不限'} 至 {parameters.yearTo ?? '不限'}</dd>
      <dt className="text-muted">协议版本</dt><dd>{protocol.version.version} {protocol.isLatest ? '当前版本' : '历史版本'}</dd>
      <dt className="text-muted">调用来源</dt><dd className="break-all">{snapshot.actor.kind === 'agent' ? '助手' : '人工'} {snapshot.actor.id}</dd>
      <dt className="text-muted">查询 ID</dt><dd className="break-all">{snapshot.id}</dd>
    </dl>
    {search.receipt?.errorCode == null ? null :
      <p role="alert" className="break-words text-[var(--st-warn)]">{search.receipt.errorCode}</p>}
    <details><summary className="cursor-pointer text-muted">准确请求、来源与终态回执</summary>
      <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">
        {JSON.stringify(search, null, 2)}
      </pre>
    </details>
    {search.receipt?.poolHash == null ? <p className="text-muted">{search.receipt === null ?
      '原始记录等待终态回执。' : '本次未产生原始记录回执。'}</p> :
      <ReviewSearchPool key={`${snapshot.id}:${search.receipt.poolHash}`} client={client}
        projectId={snapshot.request.projectId} searchId={snapshot.id} />}
  </section>;
}
