import {TriangleAlert} from 'lucide-react';
import type {LiteratureCandidate} from '../../shared/schemas/literature-import';
import {ActionButton} from '../shared/form-ui';

const fields = {doi: 'DOI', title: '标题', authors: '作者', publishedYear: '年份',
  citationCount: '引用量', url: '来源链接', openAccessUrl: '开放获取链接'} as const;
const versions: Record<string, string> = {publishedVersion: '出版版本', acceptedVersion: '接收稿', submittedVersion: '投稿稿'};
const types: Record<string, string> = {article: '文章', 'journal-article': '期刊文章', preprint: '预印本',
  'posted-content': '发布内容', dataset: '数据集', book: '书籍', review: '综述', erratum: '勘误', retraction: '撤稿通知'};
function valueText(value: unknown): string {
  return Array.isArray(value) ? value.join('；') : String(value);
}
function retractionText(status: LiteratureCandidate['origins'][number]['review']['retraction']['status']): string {
  return status === 'retracted' ? '来源标记已撤稿' : status === 'not_reported' ? '来源未报告撤稿' : '撤稿状态未知';
}

export function LiteratureCandidateReview({candidate, pending, onAdd, inLibrary = false, adding = false, selected, onSelectionChange,
  compact = false, preview = false, active = false, onPreview}: {
  candidate: LiteratureCandidate; pending: boolean; onAdd: () => void;
  inLibrary?: boolean; adding?: boolean; selected?: boolean; onSelectionChange?: (selected: boolean) => void;
  compact?: boolean; preview?: boolean; active?: boolean; onPreview?: () => void;
}): React.JSX.Element {
  const publicationTypes = [...new Set(candidate.origins.flatMap(origin => origin.review.publicationType === null ? [] :
    [types[origin.review.publicationType] ?? origin.review.publicationType]))];
  const copies = candidate.origins.flatMap(origin => origin.review.copies);
  const versionValues = [...new Set(copies.flatMap(copy => copy.version === null ? [] : [versions[copy.version] ?? copy.version]))];
  const licenses = [...new Set(copies.flatMap(copy => copy.license === null ? [] : [copy.license]))];
  const retracted = candidate.origins.some(origin => origin.review.retraction.status === 'retracted');
  const reported = candidate.origins.some(origin => origin.review.retraction.status === 'not_reported');
  const hasConflicts = candidate.conflicts.length + candidate.identityConflicts.length > 0;
  const updates = candidate.origins.flatMap(origin => origin.review.updates);
  const Container = preview ? 'article' : 'li';
  return <Container className={`min-w-0 border-b-[0.5px] border-line py-2${compact ? ' discovery-candidate-row' : ''}`}
    data-active={active} data-testid={preview ? 'discovery-preview-review' : 'literature-candidate'}>
    <div className="flex items-start gap-2">
      {onSelectionChange === undefined ? null : <label className="flex min-h-6 min-w-6 shrink-0 items-center justify-center">
        <input type="checkbox" checked={selected} disabled={pending || inLibrary || candidate.archived}
          onChange={event => onSelectionChange(event.target.checked)} aria-label={`选择 ${candidate.record.title}`} />
      </label>}
      <div className="min-w-0 flex-1">
        {onPreview ? <button type="button" onClick={onPreview} aria-current={active ? 'true' : undefined}
          data-testid={`discovery-preview-${candidate.candidateId}`} className="discovery-candidate-title">{candidate.record.title}</button>
          : <p className="break-words text-ink text-[length:var(--font-body-size)]">{candidate.record.title}</p>}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted text-[length:var(--font-meta-size)]">
          <span>{[...new Set(candidate.origins.map(origin => origin.source))].join(' / ')}</span>
          <span>{candidate.record.publishedYear ?? '年份未知'}</span>
          <span>{candidate.record.authors.slice(0, 2).join('；') || '作者未知'}</span>
          <span>{candidate.record.openAccessUrl === null ? '未提供全文链接' : '提供全文链接'}</span>
        </div>
      </div>
      {preview ? null : <ActionButton variant="unstyled" disabled={pending || inLibrary || candidate.archived}
        onClick={onAdd} loading={adding} loadingLabel="添加中"
        title={candidate.archived ? '文献已归档，请先在文献库恢复' : inLibrary ? '已在当前项目文献库' : '加入文献库并提交后台全文处理'}
        data-testid={`literature-import-hit-${candidate.record.id}`}
        className="inline-flex min-h-[var(--control-height-compact)] shrink-0 items-center gap-2 rounded-control border-[0.5px] border-line px-2 text-ink text-[length:var(--font-meta-size)] enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)] disabled:opacity-40">
        {candidate.archived ? '已归档' : inLibrary ? '已在文献库' : candidate.matchedLibraryItemId === null ? '加入' : '关联到项目'}
      </ActionButton>}
    </div>
    {hasConflicts || retracted || updates.length > 0 ? <p className="mt-2 flex items-start gap-1 text-[var(--st-warn)] text-[length:var(--font-meta-size)]">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      {retracted ? '来源标记已撤稿，请核对来源。' : hasConflicts ? '来源信息存在冲突，请核对后收录。' : '有更正/更新关系，请核对对象。'}
    </p> : null}
    {compact ? null : <details className="mt-2 text-[length:var(--font-meta-size)]">
      <summary className="min-h-7 cursor-pointer py-1 text-muted hover:text-ink" data-testid="literature-candidate-review-toggle">核对来源与冲突</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-4" data-testid="literature-candidate-review">
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[length:var(--font-meta-size)]">
          <dt className="text-muted">类型</dt><dd className="break-words text-ink">{publicationTypes.join(' / ') || '未知'}</dd>
          <dt className="text-muted">版本</dt><dd className="break-words text-ink">{versionValues.join(' / ') || '未知'}</dd>
          <dt className="text-muted">许可</dt><dd className="break-all text-ink">{licenses.join(' / ') || '未知'}</dd>
          <dt className="text-muted">撤稿</dt><dd className={retracted ? 'text-[var(--st-bad)]' : 'text-ink'}>
            {retracted ? '来源标记已撤稿' : reported ? '来源未报告撤稿' : '未知'}
          </dd>
          <dt className="text-muted">更正/更新</dt><dd className={updates.length > 0 ? 'break-words text-[var(--st-warn)]' : 'text-ink'}>
            {updates.length === 0 ? '未知' : [...new Set(updates.map(update => update.label || update.type))].join('；')}
          </dd>
        </dl>

        <p className="break-all text-muted">身份 {candidate.identity}</p>
        {candidate.origins.map((origin, index) => <section key={index} className="min-w-0">
          <h4 className="font-medium text-ink">{origin.source}，来源排名 {origin.rank}</h4>
          <p className="break-all text-muted">{origin.externalId}</p>
          <p className="text-muted">观察于 {origin.retrievedAt}</p>
          <p className="break-words text-ink">{origin.record.title}</p>
          <p className="break-words text-muted">{origin.record.authors.join('；') || '作者未知'}</p>
          <p className="break-all text-muted">DOI {origin.record.doi ?? '未知'}</p>
          <p className="text-muted">类型 {origin.review.publicationType ?? '未知'}；{retractionText(origin.review.retraction.status)}</p>
          {origin.review.copies.map((copy, copyIndex) => <div key={copyIndex} className="mt-1 break-all text-muted">
            <p>{copy.field}，版本 {copy.version ?? '未知'}，许可 {copy.license ?? '未知'}</p>
            {copy.locationUrl === null ? null : <p>适用副本 {copy.locationUrl}</p>}
          </div>)}
          {origin.review.updates.map((update, updateIndex) => <p key={updateIndex} className="mt-1 break-all text-[var(--st-warn)]">
            {update.label || update.type} ({update.type})，更新对象 DOI {update.doi}，来源 {update.source}
          </p>)}
        </section>)}
        {candidate.conflicts.map(conflict => <section key={conflict.field}>
          <h4 className="font-medium text-[var(--st-warn)]">{fields[conflict.field]}冲突</h4>
          {conflict.values.map((value, index) => <p key={index} className="break-all text-muted">
            {value.source} ({value.externalId})：{valueText(value.value)}
          </p>)}
        </section>)}
        {candidate.identityConflicts.map((conflict, index) => <p key={index} className="break-all text-[var(--st-warn)]">
          身份冲突 {conflict.alias}：{conflict.doiIdentities.join('；')}
        </p>)}
        {candidate.versionRelations.map((relation, index) => <p key={index} className="break-all text-muted">
          实际观察的 arXiv 修订 {relation.arxivId}：v{relation.older.version} 至 v{relation.newer.version}
        </p>)}
        <p className="text-muted">引用量不代表可信度。</p>
      </div>
    </details>}
  </Container>;
}
