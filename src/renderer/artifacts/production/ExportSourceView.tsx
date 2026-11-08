import type {ResearchProductionInput} from '../../../shared/schemas/research-production-inputs';

export function ExportSourceView({source}: {source: Extract<ResearchProductionInput['source'],{kind:'export'}>}): React.JSX.Element {
  const run=source.execution;
  return <section className="flex flex-col gap-2" data-testid="artifact-production-export">
    <h2 className="font-medium">导出交付来源</h2>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>导出标识</dt><dd className="break-all">{run.id}</dd>
      <dt>正文工件</dt><dd className="break-all">{run.request.manuscriptArtifactId}</dd>
      <dt>来源 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{run.sourceHash??'未记录'}</dd>
      <dt>工具链 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{run.toolchainHash??'未记录'}</dd>
      <dt>交付包 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{run.archive?.sha256??'尚未保存交付包'}</dd>
    </dl>
    {run.sources===null?<p role="alert" className="text-[var(--st-warn)]">未保存导出来源快照。</p>:<p className="text-muted">
      保存的来源包含 {run.sources.bibliography.length} 条题录、{run.sources.figures.length} 个图稿和 {run.sources.review.reportArtifactIds.length} 份审稿报告。
    </p>}
  </section>;
}
