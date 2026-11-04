import {useState} from 'react';
import type {ResearchReviewReportInspection} from '../../shared/schemas/research-review-report';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewReportEvidence} from './ReviewReportEvidence';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewReport({client, projectId, corpusId, disabled}: {
  client: RocClient; projectId: string; corpusId: string; disabled: boolean
}): React.JSX.Element {
  const read = useAsyncResource(`review:report:${projectId}:${corpusId}`,
    () => client.api.research.getReviewReport({projectId, corpusId}), {label: '读取准确综述报告'});
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-report">
    <h2 className="font-medium">综述计数与证据报告</h2>
    <button type="button" className={`${button} self-start`} disabled={disabled || read.status === 'loading'}
      data-testid="artifact-review-report-refresh" onClick={read.reload}>重读综述报告</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确综述报告…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的报告回执。</p>}
    {read.data === null ? null : <ReviewReportBody key={read.data.bodyHash} report={read.data} />}
  </section>;
}
function ReportPage({label, offset, total, onOffset}: {
  label: string; offset: number; total: number; onOffset: (offset: number) => void
}): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" className={button} disabled={offset === 0} onClick={() => onOffset(offset - 10)}>上一页{label}</button>
    <span className="text-muted">第 {Math.floor(offset / 10) + 1} 页 共 {total} 项</span>
    <button type="button" className={button} disabled={offset + 10 >= total} onClick={() => onOffset(offset + 10)}>下一页{label}</button>
  </div>;
}
function ReviewReportBody({report}: {report: ResearchReviewReportInspection}): React.JSX.Element {
  const {body} = report, c = body.counts;
  const [recordOffset, setRecordOffset] = useState(0), [exclusionOffset, setExclusionOffset] = useState(0), [evidenceOffset, setEvidenceOffset] = useState(0);
  const evidenceStatus = new Map(report.evidenceStatus.map(status => [status.hitId, status]));
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-report-body">
    <p className="text-muted break-all">正文 SHA-256 {report.bodyHash}</p>
    <p className="text-muted">{report.currentProtocol ? '对应当前冻结协议' : '协议版本已变化'} {report.sourcesCurrent ? '全文来源引用当前有效' : '全文来源引用已变化'}</p>
    <p className={body.searchCoverageComplete ? 'text-muted' : 'text-[var(--st-warn)]'}>{body.searchCoverageComplete ?
      '已声明查询的分页覆盖完整' : '已声明查询仍有检索覆盖缺口'}</p>
    <section className="flex flex-col gap-2" data-testid="artifact-review-report-counts">
      <h3 className="font-medium">筛选流程计数</h3>
      <ol className="flex flex-col gap-2">
        <li>识别记录 {c.identifiedRecords} = 移除重复 {c.removedDuplicates} + 筛选记录 {c.recordsScreened}</li>
        <li>筛选记录 {c.recordsScreened} = 标题摘要排除 {c.recordsExcluded} + 寻求全文报告 {c.reportsSought}</li>
        <li>寻求全文报告 {c.reportsSought} = 未取得报告 {c.reportsNotRetrieved} + 已资格评估报告 {c.reportsAssessed}</li>
        <li>已资格评估报告 {c.reportsAssessed} = 全文排除 {c.reportsExcluded} + 纳入报告 {c.includedReports}</li>
      </ol>
      <p>纳入报告 {c.includedReports} 人工声明研究 {c.includedStudies === null ? '尚未审核，未报告' : c.includedStudies}</p>
      <p className="text-muted">计数依据 PRISMA 2020 的记录、报告与研究定义。正式模板尚需确认综述类型及全部检索来源。</p>
    </section>
    <details data-testid="artifact-review-report-basis"><summary className="cursor-pointer font-medium">准确冻结依据与协议</summary>
      <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify({
        basis: body.basis, protocol: body.protocol, deduplication: body.deduplication, title: body.title, fullText: body.fullText, studyGrouping: body.studyGrouping
      }, null, 2)}</pre>
    </details>
    <details data-testid="artifact-review-report-queries"><summary className="cursor-pointer font-medium">查询附录 {body.queries.length}</summary>
      <ol className="mt-2 flex flex-col gap-3">{body.queries.map(query => <li key={query.source.reviewSearchId} className="flex min-w-0 flex-col gap-1">
        <p className="whitespace-pre-wrap break-words">{query.search.snapshot.parameters.query}</p>
        <p className="text-muted">分库 {query.source.databaseIndex + 1} 查询 {query.source.queryIndex + 1} 原始记录 {query.source.rawRecordCount}</p>
        <p className="text-muted break-words">{query.source.status} {query.source.coverageComplete ? '分页覆盖完整' : '分页覆盖有缺口'}
          {' '}开始 {query.search.snapshot.startedAt} 结束 {query.search.receipt!.endedAt}</p>
        <details><summary className="cursor-pointer text-muted">查询参数、来源错误与真实回执</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(query, null, 2)}</pre>
        </details>
      </li>)}</ol>
    </details>
    <details data-testid="artifact-review-report-records"><summary className="cursor-pointer font-medium">全部原始记录 {body.records.length}</summary>
      <ol start={recordOffset + 1} className="mt-2 flex flex-col gap-3">{body.records.slice(recordOffset, recordOffset + 10).map(row => <li key={row.hit.id} className="flex min-w-0 flex-col gap-1">
        <p className="break-words">{row.record.record.title}</p>
        <p className="text-muted">原始命中 {row.hit.recordIndex + 1} 年份 {row.record.record.publishedYear ?? '未报告'}</p>
        <details><summary className="cursor-pointer text-muted">原始元数据与准确命中</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(row, null, 2)}</pre>
        </details>
      </li>)}</ol>
      <ReportPage label="原始记录" offset={recordOffset} total={body.records.length} onOffset={setRecordOffset} />
    </details>
    <details data-testid="artifact-review-report-exclusions"><summary className="cursor-pointer font-medium">人工排除清单 {body.exclusions.length}</summary>
      <ol start={exclusionOffset + 1} className="mt-2 flex flex-col gap-3">{body.exclusions.slice(exclusionOffset, exclusionOffset + 10).map(row => <li key={row.hit.id} className="flex min-w-0 flex-col gap-1">
        <p>{row.phase === 'title_abstract' ? '标题摘要排除' : '全文资格排除'} 原始命中 {row.hit.recordIndex + 1}</p>
        <p className="break-words">主原因 {row.criterion.text}</p>
        <details><summary className="cursor-pointer text-muted">人工决定、仲裁与来源引用</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(row, null, 2)}</pre>
        </details>
      </li>)}</ol>
      <ReportPage label="排除清单" offset={exclusionOffset} total={body.exclusions.length} onOffset={setExclusionOffset} />
    </details>
    <details data-testid="artifact-review-report-evidence"><summary className="cursor-pointer font-medium">报告级证据表 {body.evidenceTable.length}</summary>
      <ul className="mt-2 flex flex-col gap-3">{body.evidenceTable.slice(evidenceOffset, evidenceOffset + 10).map(row => <li key={row.hit.id}>
        <ReviewReportEvidence row={row} status={evidenceStatus.get(row.hit.id)!} />
      </li>)}</ul>
      <ReportPage label="证据表" offset={evidenceOffset} total={body.evidenceTable.length} onOffset={setEvidenceOffset} />
    </details>
  </section>;
}
