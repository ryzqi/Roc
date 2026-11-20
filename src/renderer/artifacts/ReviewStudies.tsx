import {useRef, useState} from 'react';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewStudiesSave, ResearchReviewStudiesInspection} from '../../shared/schemas/research-review-studies';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ReviewStudyGroup, blankStudyGroup, type StudyGroupDraft} from './ReviewStudyGroup';
import {ArtifactDraftDiscard, useArtifactDraft, useArtifactEditorGuard} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
type Props = {client: RocClient; phase: ResearchReviewFullTextFrozenPhase; writable: boolean; onPending: (pending: boolean) => void};
export function ReviewStudies({client, phase, writable, onPending}: Props): React.JSX.Element {
  const {projectId, corpusId} = phase.plan.snapshot.request;
  const read = useAsyncResource(`review:studies:${projectId}:${corpusId}:${phase.freezeHash}`,
    () => client.api.research.getReviewStudies({projectId, corpusId}), {label: '读取真实人工研究归组'});
  const history = useAsyncResource(`review:studies-history:${projectId}:${corpusId}:${read.data?.snapshotHash ?? 'unread'}`,
    () => client.api.research.getReviewStudiesHistory({projectId, corpusId}), {label: '读取研究归组历史'});
  const [pending, setPending] = useState(false);
  const guard = useArtifactEditorGuard();
  const selectionLocked = guard.locked();
  const editable = writable && phase.sourcesCurrent && phase.plan.currentProtocol && read.status === 'ready';
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-studies">
    <h2 className="font-medium">纳入报告与人工声明研究</h2>
    <button type="button" className={`${button} self-start`} disabled={pending || selectionLocked || read.status === 'loading'}
      data-testid="artifact-review-studies-refresh" onClick={() => {if (!guard.locked()) {read.reload(); history.reload();}}}>重读研究归组</button>
    {read.status !== 'loading' ? null : <p role="status">正在读取准确研究归组…</p>}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
    {read.data === null || read.status === 'ready' ? null : <p className="text-muted">以下为上次成功读取的研究归组回执。</p>}
    {read.status !== 'ready' || read.data !== null ? null : <p className="text-muted" data-testid="artifact-review-studies-unreviewed">研究归组尚未审核，研究数未报告。</p>}
    {read.status !== 'ready' && read.data === null ? null : <ReviewStudiesEditor key={`studies:${read.data?.snapshotHash ?? 'new'}`}
      client={client} phase={phase} parent={read.data} writable={editable}
      onPending={value => {setPending(value); onPending(value);}} onSaved={read.reload} />}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-studies-history">
      <summary className="cursor-pointer text-muted">研究归组修订历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="text-muted break-words">
        版本 {item.snapshot.version} 纳入报告 {item.includedReports} 声明研究 {item.includedStudies}<p>{item.snapshot.request.revisionReason}</p>
        <details><summary className="cursor-pointer">此版本研究与准确报告来源</summary>
          <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(item.snapshot, null, 2)}</pre>
        </details>
      </li>)}</ul>
    </details>}
  </section>;
}
function ReviewStudiesEditor({client, phase, parent, writable, onPending, onSaved}: Props & {
  parent: ResearchReviewStudiesInspection | null; onSaved: () => void
}): React.JSX.Element {
  const {projectId, corpusId} = phase.plan.snapshot.request;
  const included = phase.freeze?.authority.items.filter(item => item.status === 'included') ?? [];
  const [editing, setEditing] = useState(parent === null), [reviewerId, setReviewerId] = useState(parent?.snapshot.request.reviewerId ?? '');
  const [reviewNote, setReviewNote] = useState(parent?.snapshot.request.reviewNote ?? ''), [revisionReason, setRevisionReason] = useState('');
  const [groups, setGroups] = useState<StudyGroupDraft[]>(() => parent?.snapshot.request.groups.map(group => ({
    ...group, key: crypto.randomUUID(), pendingReport: {hitId: '', sourceNote: ''}
  })) ?? []);
  const save = useAsyncAction((request: ResearchReviewStudiesSave) => client.api.research.saveReviewStudies(request), {label: '保存人工研究归组'});
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('人工研究归组', {reviewerId, reviewNote, revisionReason, groups}, busy);
  const covered = new Set(groups.flatMap(group => group.reports.map(report => report.hitId)));
  const complete = covered.size === included.length && groups.every(group => group.studyId.trim() !== '' && group.label.trim() !== '' &&
    group.reason.trim() !== '' && group.reports.length > 0 && group.pendingReport.hitId === '' && group.pendingReport.sourceNote === '') &&
    new Set(groups.map(group => group.studyId.trim())).size === groups.length &&
    reviewerId !== '' && reviewNote.trim() !== '' && (parent === null || revisionReason.trim() !== '');
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-studies-editor">
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-studies-current">
      <h3 className="font-medium">已保存人工研究归组 版本 {parent.snapshot.version}</h3>
      <p className="tabular-nums">纳入报告 {parent.includedReports} 人工声明研究 {parent.includedStudies}</p>
      <p className="text-muted">{parent.currentProtocol && parent.sourcesCurrent ? '对应当前冻结协议与来源' : '归组的协议或来源引用已变化'}</p>
      <p className="break-words">{parent.snapshot.request.reviewNote}</p>
      <p className="text-muted break-words">审核人 {parent.snapshot.reviewer.name} {parent.snapshot.reviewer.id}</p>
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">声明研究、报告与准确来源</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(parent.snapshot, null, 2)}</pre>
      </details>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`} data-testid="artifact-review-studies-revise"
        disabled={draft.locked} onClick={() => {if (!draft.isLocked()) setEditing(true);}}>修订人工研究归组</button>}
    </section>}
    {!writable || !editing ? null : <form className="flex flex-col gap-3" data-testid="artifact-review-studies-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || !writable || draft.isLocked() || !complete || phase.freezeHash === null) return;
      const body = {projectId, corpusId, expectedFullFreezeHash: phase.freezeHash,
        groups: groups.map(({key: _key, pendingReport: _pendingReport, ...group}) => group), reviewerId, reviewNote,
        parentGroupingId: parent?.snapshot.id ?? null, expectedParentHash: parent?.snapshotHash ?? null,
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
        <p className="text-muted tabular-nums">已关联报告 {covered.size} / {included.length} 人工声明研究 {groups.length}</p>
        {included.length !== 0 ? null : <p className="text-muted">无冻结纳入报告；保存空归组仍需明确人工审核。</p>}
        {groups.map((group, index) => <ReviewStudyGroup key={group.key} group={group} index={index} included={included}
          onChange={value => {if (!busy.current && !draft.isLocked()) {setGroups(groups.map(item => item.key === group.key ? value : item)); save.reset();}}}
          onRemove={() => {if (!busy.current && !draft.isLocked()) {setGroups(groups.filter(item => item.key !== group.key)); save.reset();}}} />)}
        <button type="button" className={`${button} self-start`} disabled={included.length === 0 || groups.length >= 1620}
          onClick={() => {setGroups([...groups, blankStudyGroup()]); save.reset();}}>添加声明研究</button>
        <label className="flex flex-col gap-1 text-muted">归组审核人
          <select required aria-label="归组审核人" className={`${formInputClass} border-[0.5px]`} value={reviewerId}
            onChange={event => {setReviewerId(event.target.value); save.reset();}}>
            <option value="">选择已声明审核人</option>
            {[...new Map([...phase.plan.snapshot.request.fullTextReviewers, phase.plan.snapshot.request.adjudicator]
              .map(reviewer => [reviewer.id, reviewer])).values()].map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name} {reviewer.id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted">归组审核说明
          <textarea required maxLength={10000} rows={3} aria-label="归组审核说明" className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={reviewNote} onChange={event => {setReviewNote(event.target.value); save.reset();}} />
        </label>
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">归组修订原因
          <textarea required maxLength={10000} rows={3} aria-label="归组修订原因" className={`${formInputClass} border-[0.5px] h-auto resize-y py-1`}
            value={revisionReason} onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={!complete}
          data-testid="artifact-review-studies-save">保存人工研究归组</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-studies-discard" onDiscard={() => {
        const next = {reviewerId: parent?.snapshot.request.reviewerId ?? '', reviewNote: parent?.snapshot.request.reviewNote ?? '', revisionReason: '',
          groups: parent?.snapshot.request.groups.map(group => ({...group, key: crypto.randomUUID(), pendingReport: {hitId: '', sourceNote: ''}})) ?? []};
        setReviewerId(next.reviewerId); setReviewNote(next.reviewNote); setRevisionReason(''); setGroups(next.groups); setEditing(parent === null);
        save.reset(); draft.reset(next);
      }} />
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
  </section>;
}
