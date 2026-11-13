import { useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewCorpusInspection} from '../../shared/schemas/research-review-corpus';
import type {ResearchReviewDeduplicationInspection} from '../../shared/schemas/research-review-deduplication';
import type {ResearchReviewScreeningPlanCreate} from '../../shared/schemas/research-review-screening';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const input = `${formInputClass} border-[0.5px]`;
const button = `${formSecondaryButtonClass} border-[0.5px]`;
const ReviewTitleScreening = retryableLazy(async () => ({default: (await import('./ReviewTitleScreening')).ReviewTitleScreening}));
type Reviewer = ResearchReviewScreeningPlanCreate['adjudicator'];
const blankReviewer = (): Reviewer => ({id: '', name: ''});

export function ReviewScreeningPlan({client, protocol, corpus, dedup, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; corpus: ResearchReviewCorpusInspection;
  dedup: ResearchReviewDeduplicationInspection; writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const projectId = corpus.snapshot.request.projectId, corpusId = corpus.snapshot.id;
  const read = useAsyncResource(`review:screening-plan:${projectId}:${corpusId}`,
    () => client.api.research.getReviewScreeningPlan({projectId, corpusId}), {label: '读取审核人声明'});
  const save = useAsyncAction((request: ResearchReviewScreeningPlanCreate) => client.api.research.createReviewScreeningPlan(request),
    {label: '冻结审核人声明'});
  const [titleReviewers, setTitleReviewers] = useState<Reviewer[]>(() =>
    Array.from({length: protocol.version.body.screening.titleAbstractReviewers}, blankReviewer));
  const [fullReviewers, setFullReviewers] = useState<Reviewer[]>(() =>
    Array.from({length: protocol.version.body.screening.fullTextReviewers}, blankReviewer));
  const [adjudicator, setAdjudicator] = useState<Reviewer>(blankReviewer);
  const [reviewNote, setReviewNote] = useState('');
  const [titleOpen, setTitleOpen] = useState(false), [titlePending, setTitlePending] = useState(false);
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('审核人声明', {titleReviewers, fullReviewers, adjudicator, reviewNote}, busy);
  const guard = useArtifactEditorGuard();
  const locked = guard.locked();
  const missing = read.status === 'error' && read.errorCode === 'research_review_screening_plan_not_found';
  const editable = writable && corpus.currentProtocol && dedup.currentProtocol && dedup.freezeHash !== null &&
    protocol.isLatest && protocol.version.id === corpus.snapshot.request.versionId;
  const plan = read.status === 'ready' ? read.data : null;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-screening-plan">
    <h2 className="font-medium">审核人声明</h2>
    <button type="button" className={`${button} self-start`} disabled={save.pending || titlePending || locked || read.status === 'loading'}
      data-testid="artifact-review-screening-plan-refresh" onClick={() => {if (!guard.locked()) read.reload();}}>重读审核人声明</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确审核人声明…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {!missing || !editable ? null : <form className="flex flex-col gap-3" data-testid="artifact-review-screening-plan-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || draft.isLocked() || !editable || !missing || dedup.freezeHash === null) return;
      const body = {projectId, corpusId, expectedCorpusHash: corpus.snapshotHash, expectedDedupFreezeHash: dedup.freezeHash,
        titleAbstractReviewers: titleReviewers, fullTextReviewers: fullReviewers, adjudicator, reviewNote};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {
        busy.current = false; onPending(false); if (result.ok) {draft.saved(); read.reload();}
      });
    }}>
      <fieldset className="flex flex-col gap-3" disabled={save.pending || draft.locked}>
        <p className="text-muted">协议要求标题摘要 {titleReviewers.length} 人、全文 {fullReviewers.length} 人；名单确认后冻结。</p>
        {([
          ['标题摘要', titleReviewers, setTitleReviewers],
          ['全文', fullReviewers, setFullReviewers]
        ] as const).map(([phase, reviewers, setReviewers]) => <section key={phase} className="flex flex-col gap-2">
          <h3 className="font-medium">{phase}审核人</h3>
          {reviewers.map((reviewer, index) => <ReviewerFields key={index} reviewer={reviewer} label={`${phase}审核人 ${index + 1}`}
            onChange={next => {setReviewers(reviewers.map((item, position) => position === index ? next : item)); save.reset();}} />)}
        </section>)}
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">仲裁人</h3>
          <ReviewerFields reviewer={adjudicator} label="仲裁人" onChange={next => {setAdjudicator(next); save.reset();}} />
        </section>
        <label className="flex flex-col gap-1 text-muted">审核人声明说明
          <textarea required aria-label="审核人声明说明" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
            value={reviewNote} onChange={event => {setReviewNote(event.target.value); save.reset();}} />
        </label>
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          data-testid="artifact-review-screening-plan-create">确认并冻结审核人声明</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-screening-plan-discard" onDiscard={() => {
        const next = {titleReviewers: Array.from({length: protocol.version.body.screening.titleAbstractReviewers}, blankReviewer),
          fullReviewers: Array.from({length: protocol.version.body.screening.fullTextReviewers}, blankReviewer),
          adjudicator: blankReviewer(), reviewNote: ''};
        setTitleReviewers(next.titleReviewers); setFullReviewers(next.fullReviewers);
        setAdjudicator(next.adjudicator); setReviewNote(''); save.reset(); draft.reset(next);
      }} />
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {plan === null ? null : <section className="flex flex-col gap-2" data-testid="artifact-review-screening-plan-frozen">
      <h3 className="font-medium">审核人名单已冻结</h3>
      <p className="text-muted">{plan.currentProtocol ? '当前协议' : '历史协议'}</p>
      {([
        ['标题摘要', plan.snapshot.request.titleAbstractReviewers],
        ['全文', plan.snapshot.request.fullTextReviewers],
        ['仲裁', [plan.snapshot.request.adjudicator]]
      ] as const).map(([phase, reviewers]) => <section key={phase}>
        <h4 className="font-medium">{phase}</h4>
        <ul>{reviewers.map(reviewer => <li key={reviewer.id} className="break-words">{reviewer.name} <span className="text-muted">{reviewer.id}</span></li>)}</ul>
      </section>)}
      <p className="break-words">{plan.snapshot.request.reviewNote}</p>
      <p className="text-muted break-all">声明记录人 {plan.snapshot.actor.id} {plan.snapshot.recordedAt}</p>
      <button type="button" className={`${button} self-start`} disabled={titlePending || locked}
        data-testid="artifact-review-title-inspect" onClick={() => {if (!guard.locked()) setTitleOpen(true);}}>核查标题摘要筛选</button>
      {!titleOpen ? null : <LazyBoundary fallback={<p role="status">正在加载标题摘要筛选…</p>}>
        <ReviewTitleScreening key={`title:${plan.snapshotHash}`} client={client} protocol={protocol} plan={plan}
          writable={editable && !save.pending} onPending={value => {setTitlePending(value); onPending(value);}} />
      </LazyBoundary>}
    </section>}
  </section>;
}

function ReviewerFields({label, reviewer, onChange}: {label: string; reviewer: Reviewer; onChange: (reviewer: Reviewer) => void}): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-2">
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}标识
      <input required aria-label={`${label}标识`} maxLength={300} className={input} value={reviewer.id}
        onChange={event => onChange({...reviewer, id: event.target.value})} />
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}姓名
      <input required aria-label={`${label}姓名`} maxLength={300} className={input} value={reviewer.name}
        onChange={event => onChange({...reviewer, name: event.target.value})} />
    </label>
  </div>;
}
