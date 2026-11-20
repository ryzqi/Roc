import { useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewFullTextBindingInspection} from '../../shared/schemas/research-review-fulltext';
import type {ResearchReviewExtractionSave, ResearchReviewExtractionInspection} from '../../shared/schemas/research-review-extraction';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewExtractionField, extractionFieldDraft, extractionValue, type ExtractionFieldDraft} from './ReviewExtractionField';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const ReviewQualityPlan = retryableLazy(async () => ({default: (await import('./ReviewQualityPlan')).ReviewQualityPlan}));
export function ReviewExtractionEditor({client, protocol, phase, binding, parent, writable, onPending, onSaved}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewFullTextFrozenPhase;
  binding: ResearchReviewFullTextBindingInspection; parent: ResearchReviewExtractionInspection | null; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const {projectId, corpusId} = phase.plan.snapshot.request, hitId = binding.snapshot.request.hitId;
  const evidence = useAsyncResource(`review:extraction-evidence-list:${projectId}`,
    () => client.api.research.listEvidence({projectId}), {label: '读取已有原文 Evidence'});
  const history = useAsyncResource(`review:extraction-history:${projectId}:${corpusId}:${hitId}:${parent?.snapshotHash ?? 'new'}`,
    () => client.api.research.getReviewExtractionHistory({projectId, corpusId, hitId}), {label: '读取提取修订历史'});
  const [editing, setEditing] = useState(parent === null);
  const [qualityOpen, setQualityOpen] = useState(false), [qualityPending, setQualityPending] = useState(false);
  const [qualitySelection, setQualitySelection] = useState<ResearchReviewExtractionInspection | null>(null);
  const [reviewerId, setReviewerId] = useState(parent?.snapshot.request.reviewerId ?? '');
  const [reviewNote, setReviewNote] = useState(parent?.snapshot.request.reviewNote ?? ''), [revisionReason, setRevisionReason] = useState('');
  const [study, setStudy] = useState(() => extractionFieldDraft(parent?.snapshot.request.studyDesign.value ?? null, parent?.snapshot.request.studyDesign.evidence ?? []));
  const [fields, setFields] = useState<Record<string, {enabled: boolean; draft: ExtractionFieldDraft}>>(() =>
    Object.fromEntries(protocol.version.body.extractionFields.map(field => {
      const saved = parent?.snapshot.request.fields.find(item => item.fieldId === field.id);
      return [field.id, {enabled: field.required || saved !== undefined, draft: extractionFieldDraft(saved?.value ?? null, saved?.evidence ?? [])}];
    })));
  const save = useAsyncAction((request: ResearchReviewExtractionSave) => client.api.research.saveReviewExtraction(request), {label: '保存人工证据提取'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('人工证据提取', {reviewerId, reviewNote, revisionReason, study, fields}, busy);
  const guard = useArtifactEditorGuard();
  const selectionLocked = guard.locked();
  const selectedFields = protocol.version.body.extractionFields.filter(field => fields[field.id]!.enabled);
  const complete = study.kind !== '' && study.kind !== 'number' && study.evidence.length > 0 && selectedFields.length > 0 &&
    selectedFields.every(field => {
      const draft = fields[field.id]!.draft;
      return draft.kind !== '' && draft.evidence.length > 0 && (draft.kind !== 'number' || draft.number.trim() !== '');
    });
  const canEdit = writable && phase.freezeHash !== null && phase.sourcesCurrent && binding.referenceStatus === 'current' && editing;
  const pending = save.pending || qualityPending, qualityExtraction = qualitySelection ?? parent;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-extraction-editor">
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-extraction-current">
      <h3 className="font-medium">已保存人工提取 版本 {parent.snapshot.version}</h3>
      <p className="text-muted">{parent.referenceStatus === 'current' ? '当前来源提取' : '提取来源引用已变化'}</p>
      <p className="break-words">{parent.snapshot.request.reviewNote}</p>
      <p className="text-muted break-words">审核人 {parent.snapshot.reviewer.name} {parent.snapshot.reviewer.id}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">字段值、单位与准确 Evidence</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(parent.snapshot, null, 2)}</pre>
      </details>
      <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked} data-testid="artifact-review-quality-inspect"
        onClick={() => {if (!guard.locked()) {setQualitySelection(null); setQualityOpen(true);}}}>核查研究设计与质量框架</button>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`} disabled={pending || draft.locked} data-testid="artifact-review-extraction-revise"
        onClick={() => {if (!draft.isLocked()) setEditing(true);}}>修订人工提取</button>}
    </section>}
    {evidence.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{evidence.error}</p>}
    <button type="button" className={`${button} self-start`} disabled={pending || draft.locked || evidence.status === 'loading'}
      onClick={() => {if (!draft.isLocked()) evidence.reload();}}>重读已有 Evidence</button>
    {!canEdit ? null : <form className="flex flex-col gap-3" data-testid="artifact-review-extraction-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || pending || !canEdit || draft.isLocked() || !complete || phase.freezeHash === null || study.kind === '' || study.kind === 'number' || evidence.status !== 'ready') return;
      const studyValue: ResearchReviewExtractionSave['studyDesign']['value'] = study.kind === 'text' ?
        {kind: 'text', text: study.text} : {kind: study.kind, reason: study.reason};
      const body = {projectId, corpusId, hitId, expectedFullFreezeHash: phase.freezeHash, bindingId: binding.snapshot.id,
        expectedBindingHash: binding.snapshotHash, reviewerId, reviewNote, studyDesign: {value: studyValue, evidence: study.evidence},
        fields: selectedFields.map(field => {
          const draft = fields[field.id]!.draft;
          if (draft.kind === '') throw new Error('research_review_extraction_value_required');
          return {fieldId: field.id, unit: field.unit, value: extractionValue(draft.kind, draft), evidence: draft.evidence};
        }), parentExtractionId: parent === null ? null : parent.snapshot.id, expectedParentHash: parent === null ? null : parent.snapshotHash,
        revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {
        busy.current = false; onPending(false); if (result.ok) {draft.saved(); onSaved();}
      });
    }}>
      <fieldset disabled={pending || draft.locked || evidence.status !== 'ready'} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-muted">提取审核人
          <select required aria-label="提取审核人" className={`${formInputClass} border-[0.5px]`} value={reviewerId}
            onChange={event => {setReviewerId(event.target.value); save.reset();}}>
            <option value="">选择已声明审核人</option>
            {[...new Map([...phase.plan.snapshot.request.fullTextReviewers, phase.plan.snapshot.request.adjudicator]
              .map(reviewer => [reviewer.id, reviewer])).values()].map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name} {reviewer.id}</option>)}
          </select>
        </label>
        <ReviewExtractionField client={client} projectId={projectId} binding={binding} label="研究设计" unit={null} allowNumber={false}
          value={study} evidence={evidence.data ?? []} onChange={value => {setStudy(value); save.reset();}} />
        {protocol.version.body.extractionFields.map(field => <section key={field.id}>
          {field.required ? <p className="text-muted">必填字段 {field.label}</p> : <label className="flex items-center gap-2">
            <input type="checkbox" checked={fields[field.id]!.enabled} onChange={event => {
              setFields({...fields, [field.id]: {...fields[field.id]!, enabled: event.target.checked}}); save.reset();
            }} />记录可选字段 {field.label}</label>}
          {!fields[field.id]!.enabled ? null : <ReviewExtractionField client={client} projectId={projectId} binding={binding} label={field.label}
            unit={field.unit} allowNumber value={fields[field.id]!.draft} evidence={evidence.data ?? []} onChange={value => {
              setFields({...fields, [field.id]: {...fields[field.id]!, draft: value}}); save.reset();
            }} />}
        </section>)}
        <label className="flex flex-col gap-1 text-muted">提取审核说明
          <textarea required aria-label="提取审核说明" maxLength={10000} rows={3} className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={reviewNote} onChange={event => {setReviewNote(event.target.value); save.reset();}} />
        </label>
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">提取修订原因
          <textarea required aria-label="提取修订原因" maxLength={10000} rows={3} className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={revisionReason} onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={!complete}
          data-testid="artifact-review-extraction-save">保存人工证据提取</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-extraction-discard" onDiscard={() => {
        const next = {reviewerId: parent?.snapshot.request.reviewerId ?? '', reviewNote: parent?.snapshot.request.reviewNote ?? '',
          revisionReason: '', study: extractionFieldDraft(parent?.snapshot.request.studyDesign.value ?? null, parent?.snapshot.request.studyDesign.evidence ?? []),
          fields: Object.fromEntries(protocol.version.body.extractionFields.map(field => {
            const saved = parent?.snapshot.request.fields.find(item => item.fieldId === field.id);
            return [field.id, {enabled: field.required || saved !== undefined, draft: extractionFieldDraft(saved?.value ?? null, saved?.evidence ?? [])}];
          }))};
        setReviewerId(next.reviewerId); setReviewNote(next.reviewNote); setRevisionReason(''); setStudy(next.study); setFields(next.fields);
        setEditing(parent === null); save.reset(); draft.reset(next);
      }} />
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-extraction-history">
      <summary className="cursor-pointer text-muted">提取修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="text-muted break-words">
        版本 {item.snapshot.version} {item.snapshot.request.reviewNote}<p>{item.snapshot.request.revisionReason}</p>
        <p>记录人 {item.snapshot.actor.id} {item.snapshot.recordedAt}</p>
        <details><summary className="cursor-pointer">此版本字段与原文证据</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(item.snapshot, null, 2)}</pre>
        </details>
        <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked}
          onClick={() => {if (!guard.locked()) {setQualitySelection(item); setQualityOpen(true);}}}>核查此提取版本的质量框架</button>
      </li>)}</ul>
    </details>}
    {!qualityOpen || qualityExtraction === null ? null : <LazyBoundary fallback={<p role="status">正在加载质量框架…</p>}>
      <ReviewQualityPlan key={`quality:${qualityExtraction.snapshot.id}:${qualityExtraction.snapshotHash}`}
        client={client} protocol={protocol} phase={phase} extraction={qualityExtraction} writable={writable && !editing && !save.pending}
        onPending={value => {setQualityPending(value); onPending(value);}} />
    </LazyBoundary>}
  </section>;
}
