import type {ScientificEvidenceReference, ScientificReviewInspection} from '../../shared/schemas/research-scientific-review';

const verdicts = {supports: '支持建议', contradicts: '反驳建议', qualifies: '需要限定', insufficient: '证据不足'};
const severities = {fatal: '致命问题', major: '主要问题', minor: '次要问题'};
const reasons: Record<string, string> = {
  rules_changed: '核验规则已变化', manuscript_replaced: '已有新修改稿',
  manuscript_or_claim_changed: '稿件或主张已变化', evidence_or_source_changed: '证据或来源已变化',
  human_relation_changed: '人工证据关系已变化', skill_changed: '审稿规范已变化'
};

function References({items, report}: {items: ScientificEvidenceReference[]; report: ScientificReviewInspection}): React.JSX.Element {
  return <ul className="flex min-w-0 flex-col gap-2">
    {items.map((item, index) => {
      const source = report.input.evidence.find(source => source.evidence.id === item.evidenceId);
      return <li key={`${item.evidenceId}:${index}`} className="min-w-0">
        <p className="break-words text-muted">{source?.evidence.title ?? item.evidenceId}，字符 {item.start}–{item.end}</p>
        <blockquote className="whitespace-pre-wrap break-words">{item.quote}</blockquote>
        <p className="break-all text-muted">{source?.evidence.locator}</p>
      </li>;
    })}
  </ul>;
}

export function ScientificReviewView({report}: {report: ScientificReviewInspection}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="结构化科学审查" data-testid="artifact-scientific-review">
    <h2 className="font-medium">{report.output.kind === 'verifier' ? '主张核验建议' : '独立审稿意见'}</h2>
    <p className="text-muted">{report.status === 'current' ? '绑定当前材料，待人工判断' : '历史意见，材料已变化'}</p>
    {report.status !== 'stale' ? null : <ul role="status" className="text-[var(--st-warn)]">
      {report.reasons.map(reason => <li key={reason}>{reasons[reason] ?? reason}</li>)}
    </ul>}
    {report.output.kind === 'verifier' ? report.output.suggestions.map(suggestion => <details key={suggestion.claimId} className="min-w-0 border-b-[0.5px] border-line pb-2">
      <summary className="cursor-pointer break-words focus-visible:outline-auto">{verdicts[suggestion.verdict]}：{report.input.claims.find(claim => claim.id === suggestion.claimId)?.content}</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <p className="whitespace-pre-wrap break-words">{suggestion.rationale}</p>
        <h3 className="font-medium">支持原文</h3><References items={suggestion.supporting} report={report}/>
        <h3 className="font-medium">反证与负结果</h3><References items={[...suggestion.counterevidence, ...suggestion.negativeResults]} report={report}/>
        {suggestion.alternativeExplanations.map((item, index) => <div key={index} className="min-w-0">
          <p className="break-words">替代解释：{item.explanation}</p><References items={item.references} report={report}/>
        </div>)}
        <h3 className="font-medium">适用条件</h3>
        {suggestion.conditions.map(item => <div key={item.criterion} className="min-w-0">
          <p className="break-words">{item.status === 'met' ? '具备' : item.status === 'missing' ? '缺少' : '不确定'}：{item.rationale}</p>
          <References items={item.references} report={report}/>
        </div>)}
        <ul>{suggestion.limitations.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul>
        <p className="text-muted">已检查 {suggestion.coverage.examinedEvidenceIds.length} / {report.input.evidence.length} 条证据；未发现反例不代表不存在。</p>
        {suggestion.coverage.unexaminedReason === null ? null : <p className="break-words text-muted">未检查原因：{suggestion.coverage.unexaminedReason}</p>}
      </div>
    </details>) : <>
      {report.output.findings.map(finding => <details key={finding.id} className="min-w-0 border-b-[0.5px] border-line pb-2">
        <summary className="cursor-pointer break-words focus-visible:outline-auto">{severities[finding.severity]}：{finding.observation}</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <p className="break-words">修改建议：{finding.action}</p>
          <p className="break-words">验收条件：{finding.acceptance}</p>
          <References items={finding.references} report={report}/>
        </div>
      </details>)}
      {report.output.noFindingsRationale === null ? null : <p className="break-words">{report.output.noFindingsRationale}</p>}
    </>}
    <details className="min-w-0 text-muted"><summary className="cursor-pointer focus-visible:outline-auto">审查记录</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>审稿人</dt><dd>{report.producer.role}</dd>
        <dt>模型</dt><dd className="break-all">{report.producer.providerId} / {report.producer.modelId}</dd>
        <dt>稿件</dt><dd className="break-all">{report.manuscriptArtifactId}</dd>
        <dt>输入版本</dt><dd className="break-all">{report.inputHash}</dd>
        <dt>报告版本</dt><dd className="break-all">{report.reportHash}</dd>
      </dl>
    </details>
  </section>;
}
