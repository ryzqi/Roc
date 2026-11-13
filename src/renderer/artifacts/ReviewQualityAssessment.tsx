import {useRef, useState} from 'react';
import type {ResearchReviewExtractionInspection} from '../../shared/schemas/research-review-extraction';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewQualityPlanInspection, ResearchReviewQualityAssessmentInspection, ResearchReviewQualityAssessmentSave} from '../../shared/schemas/research-review-quality';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewQualityJudgement, qualityJudgementDraft, qualityJudgementValue} from './ReviewQualityJudgement';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
type Props = {
  client: RocClient; phase: ResearchReviewFullTextFrozenPhase; extraction: ResearchReviewExtractionInspection;
  plan: ResearchReviewQualityPlanInspection; writable: boolean; onPending: (pending: boolean) => void
};
export function ReviewQualityAssessment({client, phase, extraction, plan, writable, onPending}: Props): React.JSX.Element {
  const {projectId, corpusId, extractionId} = plan.snapshot.request, qualityPlanId = plan.snapshot.id;
  const selection = {projectId, corpusId, extractionId, qualityPlanId};
  const read = useAsyncResource(`review:quality-assessment:${projectId}:${corpusId}:${qualityPlanId}:${plan.snapshotHash}`,
    () => client.api.research.getReviewQualityAssessment(selection), {label: '读取准确人工质量评价'});
  const history = useAsyncResource(`review:quality-assessment-history:${projectId}:${corpusId}:${qualityPlanId}:${read.data?.snapshotHash ?? 'unread'}`,
    () => client.api.research.getReviewQualityAssessmentHistory(selection), {label: '读取质量评价历史'});
  const [pending, setPending] = useState(false);
  const guard = useArtifactEditorGuard();
  const selectionLocked = guard.locked();
  const editable = writable && plan.currentExtraction && plan.currentProtocol && plan.referenceStatus === 'current' &&
    extraction.isLatest && extraction.currentProtocol && extraction.referenceStatus === 'current' && phase.sourcesCurrent && read.status === 'ready';
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-quality-assessment">
    <h2 className="font-medium">逐域人工质量评价</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked || read.status === 'loading'}
      data-testid="artifact-review-quality-assessment-refresh" onClick={() => {if (!guard.locked()) {read.reload(); history.reload();}}}>重读质量评价</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确人工质量评价…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的质量评价回执。</p>}
    {read.status !== 'ready' || read.data !== null ? null : <p className="text-muted">此框架尚未保存人工评价。</p>}
    {read.status !== 'ready' && read.data === null ? null : <ReviewQualityAssessmentEditor
      key={`assessment:${qualityPlanId}:${read.data?.snapshotHash ?? 'new'}`} client={client} phase={phase} extraction={extraction}
      plan={plan} parent={read.data} writable={editable}
      onPending={value => {setPending(value); onPending(value);}} onSaved={read.reload} />}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-quality-assessment-history">
      <summary className="cursor-pointer text-muted">质量评价修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="text-muted break-words">
        版本 {item.snapshot.version} {item.snapshot.request.reviewNote}<p>{item.snapshot.request.revisionReason}</p>
        <p>记录人 {item.snapshot.actor.id} {item.snapshot.recordedAt}</p>
        <details><summary className="cursor-pointer">此版本判断与准确证据</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(item.snapshot, null, 2)}</pre>
        </details>
      </li>)}</ul>
    </details>}
  </section>;
}
function ReviewQualityAssessmentEditor({client, phase, extraction, plan, parent, writable, onPending, onSaved}: Props & {
  parent: ResearchReviewQualityAssessmentInspection | null; onSaved: () => void
}): React.JSX.Element {
  const {projectId, corpusId, extractionId} = plan.snapshot.request, qualityPlanId = plan.snapshot.id, definition = plan.snapshot.request.definition;
  const [editing, setEditing] = useState(parent === null), [reviewerId, setReviewerId] = useState(parent?.snapshot.request.reviewerId ?? '');
  const [reviewNote, setReviewNote] = useState(parent?.snapshot.request.reviewNote ?? ''), [revisionReason, setRevisionReason] = useState('');
  const [domains, setDomains] = useState(() => Object.fromEntries(definition.domains.map(domain => {
    const saved = parent?.snapshot.request.domains.find(item => item.domainId === domain.id);
    return [domain.id, qualityJudgementDraft(saved?.value ?? null, saved?.evidence ?? [])];
  })));
  const [overall, setOverall] = useState(() => qualityJudgementDraft(parent?.snapshot.request.overall.value ?? null, parent?.snapshot.request.overall.evidence ?? []));
  const save = useAsyncAction((request: ResearchReviewQualityAssessmentSave) => client.api.research.saveReviewQualityAssessment(request),
    {label: '保存逐域人工质量评价'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('逐域人工质量评价', {reviewerId, reviewNote, revisionReason, domains, overall}, busy);
  const judgements = [...Object.values(domains), overall];
  const complete = judgements.every(value => value.kind !== '' && value.evidence.length > 0 && value.reason.trim() !== '' &&
    (value.kind !== 'judged' || value.judgement !== '')) && reviewerId !== '' && reviewNote.trim() !== '' &&
    (parent === null || revisionReason.trim() !== '');
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-quality-assessment-editor">
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-quality-assessment-current">
      <h3 className="font-medium">已保存人工质量评价 版本 {parent.snapshot.version}</h3>
      <p>{parent.snapshot.request.overall.value.kind === 'judged' ? parent.snapshot.request.overall.value.judgement : '总体无法判断'}</p>
      <p className="text-muted">{parent.currentExtraction && parent.currentProtocol && parent.referenceStatus === 'current' ?
        '对应当前框架、提取与来源' : '评价引用的提取或来源已变化'}</p>
      <p className="break-words">{parent.snapshot.request.reviewNote}</p>
      <p className="text-muted break-words">审核人 {parent.snapshot.reviewer.name} {parent.snapshot.reviewer.id}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">逐域判断与准确 Evidence</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(parent.snapshot, null, 2)}</pre>
      </details>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`} data-testid="artifact-review-quality-assessment-revise"
        disabled={draft.locked} onClick={() => {if (!draft.isLocked()) setEditing(true);}}>修订人工质量评价</button>}
    </section>}
    {!writable || !editing ? null : <form className="flex flex-col gap-3" data-testid="artifact-review-quality-assessment-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || !writable || draft.isLocked() || !complete) return;
      const body = {projectId, corpusId, extractionId, qualityPlanId, expectedPlanHash: plan.snapshotHash,
        expectedExtractionHash: extraction.snapshotHash, domains: definition.domains.map(domain => ({
          domainId: domain.id, value: qualityJudgementValue(domains[domain.id]!), evidence: domains[domain.id]!.evidence
        })), overall: {value: qualityJudgementValue(overall), evidence: overall.evidence}, reviewerId, reviewNote,
        parentAssessmentId: parent?.snapshot.id ?? null, expectedParentHash: parent?.snapshotHash ?? null,
        revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {
        busy.current = false; onPending(false); if (result.ok) {draft.saved(); onSaved();}
      });
    }}>
      <fieldset disabled={save.pending || draft.locked} className="flex flex-col gap-3">
        {definition.domains.map(domain => <ReviewQualityJudgement key={domain.id} label={domain.label} question={domain.question}
          choices={domain.judgements} sources={extraction.snapshot.sources} value={domains[domain.id]!}
          onChange={value => {setDomains({...domains, [domain.id]: value}); save.reset();}} />)}
        <ReviewQualityJudgement label="总体评价" question="按冻结框架明确记录总体判断" choices={definition.overallJudgements}
          sources={extraction.snapshot.sources} value={overall} onChange={value => {setOverall(value); save.reset();}} />
        <label className="flex flex-col gap-1 text-muted">质量评价审核人
          <select required aria-label="质量评价审核人" className={`${formInputClass} border-[0.5px]`} value={reviewerId}
            onChange={event => {setReviewerId(event.target.value); save.reset();}}>
            <option value="">选择已声明审核人</option>
            {[...new Map([...phase.plan.snapshot.request.fullTextReviewers, phase.plan.snapshot.request.adjudicator]
              .map(reviewer => [reviewer.id, reviewer])).values()].map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name} {reviewer.id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted">质量评价审核说明
          <textarea required aria-label="质量评价审核说明" maxLength={10000} rows={3} className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={reviewNote} onChange={event => {setReviewNote(event.target.value); save.reset();}} />
        </label>
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">质量评价修订原因
          <textarea required aria-label="质量评价修订原因" maxLength={10000} rows={3} className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={revisionReason} onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={!complete}
          data-testid="artifact-review-quality-assessment-save">保存人工质量评价</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-quality-assessment-discard" onDiscard={() => {
        const next = {reviewerId: parent?.snapshot.request.reviewerId ?? '', reviewNote: parent?.snapshot.request.reviewNote ?? '', revisionReason: '',
          domains: Object.fromEntries(definition.domains.map(domain => {
            const saved = parent?.snapshot.request.domains.find(item => item.domainId === domain.id);
            return [domain.id, qualityJudgementDraft(saved?.value ?? null, saved?.evidence ?? [])];
          })), overall: qualityJudgementDraft(parent?.snapshot.request.overall.value ?? null, parent?.snapshot.request.overall.evidence ?? [])};
        setReviewerId(next.reviewerId); setReviewNote(next.reviewNote); setRevisionReason(''); setDomains(next.domains); setOverall(next.overall);
        setEditing(parent === null); save.reset(); draft.reset(next);
      }} />
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
  </section>;
}
