import type {ResearchJournalReceipt} from '../../shared/schemas/research-journal-compliance';
import {journalKindLabels} from './JournalRuleEditor';

export const journalStatusLabels = {pass: '通过', fail: '不通过', manual: '需人工核对', not_applicable: '不适用'};
export function JournalReceipt({receipt}: {receipt: ResearchJournalReceipt}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt, {profile, manualReviews} = snapshot.request.selection;
  return <details className="min-w-0 text-muted" data-testid="artifact-journal-receipt">
    <summary className="cursor-pointer">投稿检查第 {snapshot.version} 版，{profile.journal}</summary>
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt>文章类型</dt><dd className="break-words">{profile.articleType}</dd>
      <dt>投稿阶段</dt><dd className="break-words">{profile.submissionStage}</dd>
      <dt>规则版本</dt><dd className="break-words">{profile.version}</dd>
      <dt>规则日期</dt><dd>{profile.revisionDate}，{profile.dateAuthority === 'official' ? '官方日期' : '人工整理日期'}</dd>
      <dt>资料获取时间</dt><dd className="break-all">{profile.retrievedAt}</dd>
      <dt>人工操作者</dt><dd className="break-all">{snapshot.actor.id}</dd>
      <dt>保存时间</dt><dd className="break-all">{snapshot.recordedAt}</dd>
      <dt>修订理由</dt><dd className="whitespace-pre-wrap break-words">{snapshot.request.rationale}</dd>
      <dt>回执 SHA-256</dt><dd className="break-all font-mono">{snapshotHash}</dd>
    </dl>
    <ul className="mt-2 flex min-w-0 flex-col gap-3">
      {profile.rules.map(rule => <li className="flex min-w-0 flex-col gap-1" key={rule.id}>
        <p className="break-words">{rule.label}，{journalKindLabels[rule.kind]}，{rule.authority === 'required' ? '硬性要求' : '指导性建议'}</p>
        <a href={rule.sourceUrl} target="_blank" rel="noreferrer" className="break-all underline">{rule.sourceUrl}</a>
        <blockquote className="whitespace-pre-wrap break-words">{rule.excerpt}</blockquote>
        {snapshot.checks.filter(check => check.ruleId === rule.id).map(check => <div key={check.ruleId}>
          <p>自动检查：{journalStatusLabels[check.status]}</p>
          <p className="break-words">{check.detail}</p>
          {check.subjectIds.length === 0 ? null : <p className="break-all">待核对项：{check.subjectIds.join('，')}</p>}
        </div>)}
        {manualReviews.filter(review => review.ruleId === rule.id).map(review =>
          <p className="whitespace-pre-wrap break-words" key={review.ruleId}>人工判断：{journalStatusLabels[review.decision]}，{review.rationale}</p>)}
        <details><summary className="cursor-pointer">检查条件</summary>
          <pre className="whitespace-pre-wrap break-all font-mono">{JSON.stringify(rule, null, 2)}</pre>
        </details>
      </li>)}
    </ul>
    <p className="mt-2 break-all">所选图稿：{snapshot.request.selection.figureIds.join('，') || '无'}</p>
    <ul className="mt-1">{snapshot.material.supplements.map(file =>
      <li className="break-all" key={file.path}>{file.path}，{file.size} bytes，SHA-256 {file.sha256}</li>)}</ul>
  </details>;
}
