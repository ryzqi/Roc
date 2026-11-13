import { useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewExtractionInspection} from '../../shared/schemas/research-review-extraction';
import type {ResearchReviewQualityPlanCreate} from '../../shared/schemas/research-review-quality';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {blankQualityDomain, ReviewQualityDefinition} from './ReviewQualityDefinition';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const ReviewQualityAssessment = retryableLazy(async () => ({default: (await import('./ReviewQualityAssessment')).ReviewQualityAssessment}));
export function ReviewQualityPlan({client, protocol, phase, extraction, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewFullTextFrozenPhase;
  extraction: ResearchReviewExtractionInspection; writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const {projectId, corpusId, hitId} = extraction.snapshot.request, extractionId = extraction.snapshot.id;
  const read = useAsyncResource(`review:quality-plan:${projectId}:${corpusId}:${extractionId}:${extraction.snapshotHash}`,
    () => client.api.research.getReviewQualityPlan({projectId, corpusId, extractionId}), {label: '读取准确质量框架'});
  const create = useAsyncAction((request: ResearchReviewQualityPlanCreate) => client.api.research.createReviewQualityPlan(request),
    {label: '确认并冻结质量框架'});
  const [frameworkIndex, setFrameworkIndex] = useState(''), [reviewerId, setReviewerId] = useState(''), [reviewNote, setReviewNote] = useState('');
  const [documentationNote, setDocumentationNote] = useState('');
  const [domains, setDomains] = useState(() => [blankQualityDomain()]), [overall, setOverall] = useState(['', '']);
  const [assessmentOpen, setAssessmentOpen] = useState(false), [assessmentPending, setAssessmentPending] = useState(false);
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('质量框架声明', {frameworkIndex, reviewerId, reviewNote, documentationNote, domains, overall}, busy);
  const guard = useArtifactEditorGuard();
  const selectionLocked = guard.locked();
  const design = extraction.snapshot.request.studyDesign.value;
  const frameworks = protocol.version.body.qualityAssessment.filter(framework => design.kind === 'text' && framework.studyDesign === design.text);
  const selected = frameworkIndex === '' ? undefined : frameworks[Number(frameworkIndex)];
  const editable = writable && extraction.isLatest && extraction.currentProtocol && extraction.referenceStatus === 'current' &&
    phase.sourcesCurrent && read.status === 'ready' && read.data === null && design.kind === 'text' && frameworks.length > 0;
  const validChoices = (values: string[]): boolean => values.every(value => value.trim() !== '') &&
    new Set(values.map(value => value.trim())).size === values.length;
  const complete = selected !== undefined && domains.every(domain => domain.id.trim() !== '' && domain.label.trim() !== '' &&
    domain.question.trim() !== '' && validChoices(domain.judgements)) && validChoices(overall) &&
    new Set(domains.map(domain => domain.id.trim())).size === domains.length && documentationNote.trim() !== '' &&
    reviewerId !== '' && reviewNote.trim() !== '';
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-quality-plan">
    <h2 className="font-medium">研究设计与质量框架</h2>
    <p className="text-muted break-words">提取版本 {extraction.snapshot.version} 研究设计 {design.kind === 'text' ? design.text : design.kind === 'missing' ? '原文未报告' : '无法判断'}</p>
    <button type="button" className={`${button} self-start`} disabled={create.pending || assessmentPending || selectionLocked || read.status === 'loading'}
      data-testid="artifact-review-quality-plan-refresh" onClick={() => {if (!guard.locked()) read.reload();}}>重读质量框架</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确质量框架…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的质量框架回执。</p>}
    {read.status !== 'ready' || read.data !== null ? null : <p className="text-muted">此提取版本尚未冻结质量框架。</p>}
    {design.kind === 'text' ? frameworks.length > 0 ? null : <p className="text-[var(--st-warn)]">协议未声明此研究设计的框架。</p> :
      <p className="text-[var(--st-warn)]">研究设计尚不能确定，无法选择质量框架。</p>}
    {read.data === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-quality-plan-frozen">
      <h3 className="font-medium">{read.data.snapshot.request.framework.framework} {read.data.snapshot.request.framework.version}</h3>
      <p>用户声明的评价框架已冻结</p>
      <p className="text-muted">{read.data.currentExtraction && read.data.currentProtocol && read.data.referenceStatus === 'current' ?
        '对应当前提取与来源' : '框架引用的提取或来源已变化'}</p>
      <p className="break-words">{read.data.snapshot.request.reviewNote}</p>
      <p className="text-muted break-words">审核人 {read.data.snapshot.reviewer.name} {read.data.snapshot.reviewer.id}</p>
      <p className="text-muted break-all">记录人 {read.data.snapshot.actor.id} {read.data.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">冻结的逐域定义与准确版本</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(read.data.snapshot, null, 2)}</pre>
      </details>
      <button type="button" className={`${button} self-start`} disabled={create.pending || assessmentPending || selectionLocked}
        data-testid="artifact-review-quality-assessment-inspect"
        onClick={() => {if (!guard.locked()) setAssessmentOpen(true);}}>核查逐域人工质量评价</button>
      {!assessmentOpen ? null : <LazyBoundary fallback={<p role="status">正在加载质量评价…</p>}>
        <ReviewQualityAssessment key={`assessment:${read.data.snapshot.id}:${read.data.snapshotHash}`} client={client}
          phase={phase} extraction={extraction} plan={read.data} writable={writable && read.status === 'ready' && !create.pending}
          onPending={value => {setAssessmentPending(value); onPending(value);}} />
      </LazyBoundary>}
    </section>}
    {!editable ? null : <form className="flex flex-col gap-3" data-testid="artifact-review-quality-plan-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || !editable || draft.isLocked() || !complete || selected === undefined) return;
      const body = {projectId, corpusId, hitId, extractionId, expectedExtractionHash: extraction.snapshotHash, framework: selected,
        definition: {origin: 'user_declared' as const, documentationNote, domains: domains.map(({key: _key, ...domain}) => domain), overallJudgements: overall},
        reviewerId, reviewNote};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void create.run({...body, requestId}).then(result => {
        busy.current = false; onPending(false); if (result.ok) {draft.saved(); read.reload();}
      });
    }}>
      <fieldset disabled={create.pending || draft.locked} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-muted">协议声明的质量框架
          <select required aria-label="协议声明的质量框架" className={`${formInputClass} border-[0.5px]`} value={frameworkIndex}
            onChange={event => {setFrameworkIndex(event.target.value); create.reset();}}>
            <option value="">明确选择已声明框架</option>
            {frameworks.map((framework, index) => <option key={index} value={index}>{framework.framework} {framework.version}</option>)}
          </select>
        </label>
        <ReviewQualityDefinition domains={domains} overall={overall} documentationNote={documentationNote}
          onDomains={value => {setDomains(value); create.reset();}} onOverall={value => {setOverall(value); create.reset();}}
          onDocumentation={value => {setDocumentationNote(value); create.reset();}} />
        <label className="flex flex-col gap-1 text-muted">框架审核人
          <select required aria-label="框架审核人" className={`${formInputClass} border-[0.5px]`} value={reviewerId}
            onChange={event => {setReviewerId(event.target.value); create.reset();}}>
            <option value="">选择已声明审核人</option>
            {[...new Map([...phase.plan.snapshot.request.fullTextReviewers, phase.plan.snapshot.request.adjudicator]
              .map(reviewer => [reviewer.id, reviewer])).values()].map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name} {reviewer.id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted">框架审核说明
          <textarea required aria-label="框架审核说明" maxLength={10000} rows={3} className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={reviewNote} onChange={event => {setReviewNote(event.target.value); create.reset();}} />
        </label>
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={!complete}
          data-testid="artifact-review-quality-plan-create">确认并冻结质量框架</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-quality-plan-discard" onDiscard={() => {
        const next = {frameworkIndex: '', reviewerId: '', reviewNote: '', documentationNote: '', domains: [blankQualityDomain()], overall: ['', '']};
        setFrameworkIndex(''); setReviewerId(''); setReviewNote(''); setDocumentationNote(''); setDomains(next.domains); setOverall(next.overall);
        create.reset(); draft.reset(next);
      }} />
    </form>}
    {create.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{create.error}</p>}
  </section>;
}
