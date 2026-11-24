import {useEffect, useRef} from 'react';
import {ArrowLeft, Check, Copy} from 'lucide-react';
import type {LiteratureCandidate} from '../../shared/schemas/literature-import';
import {ActionButton, formButtonClass} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';
import {useCopyFeedback} from '../shared/hooks/use-copy-feedback';
import {LiteratureCandidateReview} from './LiteratureCandidateReview';

export function DiscoveryCandidatePreview({candidate, onBack, revealed, onAdd, pending, adding, inLibrary}: {
  candidate: LiteratureCandidate; onBack: () => void; revealed: boolean; onAdd: () => void;
  pending: boolean; adding: boolean; inLibrary: boolean;
}): React.JSX.Element {
  const copy = useCopyFeedback();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {if (revealed) heading.current?.focus({preventScroll: true});}, [revealed, candidate.candidateId]);
  const url = candidate.record.url ?? candidate.record.openAccessUrl;
  return <aside className="discovery-preview" aria-label="候选文献预览" data-testid="discovery-preview"
    onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); onBack();}}}>
    <div className="discovery-preview-heading">
      <button type="button" className={`${formButtonClass} discovery-preview-back`} onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true"/>返回搜索结果
      </button>
      <h3 ref={heading} tabIndex={-1}>文献预览</h3>
    </div>
    <div className="discovery-preview-scroll">
      <LiteratureCandidateReview candidate={candidate} pending={false} onAdd={() => {}} preview/>
      <section className="discovery-abstract" aria-label="摘要">
        <h4>摘要</h4>
        <p>{candidate.record.abstract?.trim() || '来源未提供摘要'}</p>
      </section>
      <dl className="discovery-preview-identifiers">
        <dt>DOI</dt><dd>{candidate.record.doi ?? '未提供'}</dd>
        <dt>来源链接</dt><dd>{url ?? '未提供'}</dd>
      </dl>
      {url ? <button type="button" className={formButtonClass} onClick={() => copy.copy(url)}>
        {copy.copied ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}
        {copy.copied ? '已复制链接' : '复制来源链接'}
      </button> : null}
      {copy.error ? <ActionStatus state="error">{copy.error}</ActionStatus> : null}
    </div>
    <div className="discovery-preview-heading">
      <ActionButton disabled={pending || inLibrary || candidate.archived} loading={adding} loadingLabel="正在加入文献库"
        onClick={onAdd} data-testid="discovery-preview-add">
        {candidate.archived ? '文献已归档' : inLibrary ? '已在当前项目' : '加入文献库'}
      </ActionButton>
    </div>
  </aside>;
}
