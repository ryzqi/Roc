import {useEffect, useRef, useState} from 'react';
import type {ResearchCitationCoverageBody} from '../../shared/schemas/research-citation-coverage';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactEvidenceSource} from './ArtifactEvidenceSource';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const supportLabels = {unreviewed: '尚未确认支持', confirmed: '人工确认支持', qualified: '人工确认条件支持'};
const locationLabels = {locator: '来源定位', page: '页码定位', region: '原文区域定位'};
const issueLabels = {
  unreviewed_support: '引用尚无当前人工支持确认', confirmed_contradiction: '存在当前人工反对关系',
  changed_relation: '关系绑定的版本已变化', figure_claim_in_body: '图稿主张被用作正文',
  archived_bibliography: '文献已归档', unreviewed_directness: '引用直接性尚未人工审核',
  changed_directness: '直接性审核绑定的主张或来源已变化', indirect_citation: '人工标记为间接引用',
  unsupported_citation: '人工标记为不支持该主张'
};

export function ArtifactCitationCoverage({client, projectId, artifactId, artifactVersion}: {
  client: RocClient; projectId: string; artifactId: string; artifactVersion: string
}): React.JSX.Element {
  const baseline = useRef<string | null>(null);
  const [filter, setFilter] = useState('all');
  const read = useAsyncResource(`citation-coverage:${projectId}:${artifactId}:${artifactVersion}`,
    () => client.api.research.inspectCitationCoverage({projectId, artifactId, expectedHash: baseline.current}),
    {label: '检查正文引用'});
  const result = read.status === 'ready' ? read.data : null;
  useEffect(() => {
    if (result?.status === 'current') baseline.current = result.reportHash;
  }, [result]);
  const matchesArtifact = result === null || result.report.artifactVersion === artifactVersion;
  const report = result?.report;
  const paragraphs = report?.paragraphs.filter(paragraph => filter === 'all' ||
    (filter === 'issues' && paragraph.issues.length > 0) ||
    (filter === 'unreviewed' && paragraph.citations.some(citation => citation.supportReview === 'unreviewed')));
  return <section aria-label="正文引用覆盖" data-testid="artifact-citation-coverage" className="mt-2 flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-medium">正文引用覆盖</h2>
      <button type="button" className={button} disabled={read.status === 'loading'} data-testid="artifact-citation-coverage-refresh"
        onClick={read.reload}>重新检查引用</button>
    </div>
    {read.status === 'loading' ? <p role="status">正在读取当前正文与引用来源…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {!matchesArtifact ? <p role="alert" className="text-[var(--st-warn)]" data-testid="artifact-citation-coverage-artifact-changed">
      正文工件已变化。先刷新工件，再核对这份引用报告。
    </p> : null}
    {result?.status !== 'stale' ? null : <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-[var(--st-warn)]">正文、来源、人工关系或书目已变化。以下是当前报告，请重新核对。</p>
      <button type="button" className={button} disabled={!matchesArtifact} data-testid="artifact-citation-coverage-recapture"
        onClick={() => {baseline.current = result.reportHash; read.reload();}}>按当前版本核对引用</button>
    </div>}
    {report === undefined || result === null ? null : <>
      <p className="text-muted">人工关系确认支持性；原文位置只表示定位精度。</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
        <dt>段落</dt><dd>{report.counts.paragraphs}</dd>
        <dt>引用</dt><dd>{report.counts.citations}</dd>
        <dt>人工已审核引用</dt><dd>{report.counts.humanReviewedCitations}</dd>
        <dt>条件支持引用</dt><dd>{report.counts.qualifiedCitations}</dd>
        <dt>存在问题的段落</dt><dd>{report.counts.paragraphsWithIssues}</dd>
        <dt>报告版本</dt><dd className="break-all font-mono text-[var(--font-meta-size)]" data-testid="artifact-citation-coverage-hash">{result.reportHash}</dd>
        <dt>读取时间</dt><dd className="break-words">{result.readAt}</dd>
      </dl>
      <label className="flex items-center gap-2 text-muted">
        <span className="shrink-0 whitespace-nowrap">查看段落</span>
        <select className={`${formInputClass} min-w-0 flex-1 border-[0.5px]`} value={filter} aria-label="引用覆盖段落筛选"
          onChange={event => setFilter(event.target.value)} data-testid="artifact-citation-coverage-filter">
          <option value="all">全部段落</option><option value="issues">存在问题</option><option value="unreviewed">尚未确认支持</option>
        </select>
      </label>
      {paragraphs?.length === 0 ? <p className="text-muted">没有符合条件的段落。</p> :
        paragraphs?.map(paragraph => <CoverageParagraph key={`${paragraph.sectionIndex}:${paragraph.paragraphIndex}`} paragraph={paragraph}/>)}
      <section aria-label="引用原文与书目版本" className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">引用原文与书目版本</h3>
        {report.sources.map(source => <div key={source.source.evidence.id} className="min-w-0">
          <p className="break-words text-muted">{locationLabels[source.locationLevel]}</p>
          <p className="break-all text-muted">正文引用键 {source.manuscriptCitationKey}</p>
          {source.bibliography === null ? null : <p className="break-words text-muted">
            书目版本 {source.bibliography.revision}，引用键 {source.bibliography.entry.citationKey}
            {source.bibliography.archived ? '，已归档' : ''}
          </p>}
          {source.source.sourceLocator === null ? null : <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)] text-muted">
            {JSON.stringify(source.source.sourceLocator, null, 2)}
          </pre>}
          <ArtifactEvidenceSource client={client} source={source.source} canDecide={false} onChanged={read.reload}/>
        </div>)}
      </section>
    </>}
  </section>;
}

function CoverageParagraph({paragraph}: {paragraph: ResearchCitationCoverageBody['paragraphs'][number]}): React.JSX.Element {
  return <details className="min-w-0 border-t-[0.5px] border-line py-2 [&::details-content]:overflow-clip!"
    data-testid={`artifact-citation-paragraph-${paragraph.sectionIndex}-${paragraph.paragraphIndex}`}>
    <summary className="cursor-pointer break-words">{paragraph.sectionTitle}，第 {paragraph.paragraphIndex + 1} 段：{paragraph.claim.content}</summary>
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <p className="break-all text-muted">主张 {paragraph.claim.id}，版本 {paragraph.claim.version}</p>
      {paragraph.issues.map((issue, index) => <p key={`${issue.kind}:${issue.subjectId}:${index}`} className="break-words text-[var(--st-warn)]">
        {issueLabels[issue.kind]}：{issue.subjectId}
      </p>)}
      {paragraph.citations.map(citation => <div key={citation.evidenceId} className="flex min-w-0 flex-col gap-1">
        <p className="break-all">引用 {citation.manuscriptCitationKey}，{supportLabels[citation.supportReview]}</p>
        {paragraph.relations.filter(relation => relation.evidenceId === citation.evidenceId).map(relation =>
          <p key={relation.id} className="break-words text-muted">
            {relation.kind}，{relation.status}，{relation.reviewer?.id ?? '尚未人工审核'}
            {relation.condition === null ? '' : `，条件：${relation.condition}`}
          </p>)}
      </div>)}
    </div>
  </details>;
}
