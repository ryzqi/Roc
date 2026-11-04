import type {ResearchReviewReportInspection} from '../../shared/schemas/research-review-report';

type Row = ResearchReviewReportInspection['body']['evidenceTable'][number];
type Status = ResearchReviewReportInspection['evidenceStatus'][number];
export function ReviewReportEvidence({row, status}: {row: Row; status: Status}): React.JSX.Element {
  const extraction = row.extraction?.snapshot;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-review-report-evidence-row">
    <p className="text-muted break-all">原始命中 {row.hit.recordIndex + 1} {row.hit.id}</p>
    {extraction === undefined ? <p>尚未提取</p> : <>
      <h4 className="font-medium">提取版本 {extraction.version}</h4>
      <p className="text-muted">{status.extraction!.referenceStatus === 'current' ? '提取来源引用当前有效' : '提取来源引用已变化'}</p>
      <p className="break-words">研究设计 {extraction.request.studyDesign.value.kind === 'text' ? extraction.request.studyDesign.value.text :
        extraction.request.studyDesign.value.kind === 'missing' ? '原文未报告' : '无法判断'}</p>
      <dl className="flex flex-col gap-2">{extraction.request.fields.map(field => {
        const label = extraction.fieldDefinitions.find(definition => definition.id === field.fieldId)!.label;
        const value = field.value;
        return <div key={field.fieldId} className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2">
          <dt className="font-medium">{label} 单位 {field.unit ?? '未声明'}</dt>
          <dd className="whitespace-pre-wrap break-words">{value.kind === 'number' ? value.number : value.kind === 'text' ? value.text :
            value.kind === 'missing' ? `原文未报告：${value.reason}` : `无法判断：${value.reason}`}</dd>
          <dd className="text-muted break-all">{field.evidence.map(ref => `Evidence ${ref.id} SHA-256 ${ref.expectedHash}`).join('\n')}</dd>
        </div>;
      })}</dl>
      <details><summary className="cursor-pointer text-muted">字段及原文定位的完整提取</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(row.extraction, null, 2)}</pre>
      </details>
    </>}
    {row.qualityPlan === null ? <p>尚未冻结质量框架</p> : <>
      <p className="font-medium">{row.qualityPlan.snapshot.request.framework.framework} {row.qualityPlan.snapshot.request.framework.version}</p>
      <p className="text-muted">{status.qualityPlan!.currentExtraction && status.qualityPlan!.referenceStatus === 'current' ?
        '质量框架对应当前提取来源' : '质量框架引用已变化'}</p>
      <details><summary className="cursor-pointer text-muted">用户声明的框架定义</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(row.qualityPlan, null, 2)}</pre>
      </details>
    </>}
    {row.assessment === null ? <p>尚未人工评价</p> : <>
      <p className="font-medium">质量评价版本 {row.assessment.snapshot.version}</p>
      <p>总体 {row.assessment.snapshot.request.overall.value.kind === 'judged' ? row.assessment.snapshot.request.overall.value.judgement : '无法判断'}</p>
      <p className="text-muted">{status.assessment!.currentExtraction && status.assessment!.referenceStatus === 'current' ?
        '评价对应当前提取来源' : '评价引用已变化'}</p>
      <details><summary className="cursor-pointer text-muted">逐域判断、理由及准确证据</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[var(--font-meta-size)] font-mono">{JSON.stringify(row.assessment, null, 2)}</pre>
      </details>
    </>}
  </section>;
}
