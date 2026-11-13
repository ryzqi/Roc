import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection, ResearchReviewProtocolSaveRequest, ResearchReviewProtocolFreezeRequest} from '../../shared/schemas/research-systematic-review';
import {researchReviewProtocolSaveRequestSchema} from '../../shared/schemas/research-systematic-review';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {emptyReviewProtocolBody, type ReviewProtocolDraft, type ReviewProtocolDrafts} from './review-protocol-draft';
import {ReviewProtocolFields} from './ReviewProtocolFields';
import {useArtifactEditorStatus} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewProtocolEditor({client, projectId, current, writable, drafts, onPending, onSaved}: {
  client: RocClient; projectId: string; current: ResearchReviewProtocolInspection | null;
  writable: boolean; drafts: ReviewProtocolDrafts; onPending: (pending: boolean) => void;
  onSaved: (inspection: ResearchReviewProtocolInspection) => void
}): React.JSX.Element {
  const draftKey = JSON.stringify([projectId, current?.version.id ?? null]);
  const [draft, setDraft] = useState<ReviewProtocolDraft>(() => drafts.get(draftKey) ?? {
    body: current === null ? emptyReviewProtocolBody() : current.version.body,
    deviationReason: '', reviewNote: '', editing: current === null,
    saveRequestId: crypto.randomUUID(), freezeRequestId: crypto.randomUUID()
  });
  const [validation, setValidation] = useState<string[] | null>(null);
  const busy = useRef(false);
  const activity = useArtifactEditorStatus({
    label: '综述协议', dirty: false, unloadDirty: drafts.has(draftKey), pending: () => busy.current
  });
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((input: ResearchReviewProtocolSaveRequest) => client.api.research.saveReviewProtocol(input), {label: '保存综述协议'});
  const freeze = useAsyncAction((input: ResearchReviewProtocolFreezeRequest) => client.api.research.freezeReviewProtocol(input), {label: '冻结综述协议'});
  const pending = save.pending || freeze.pending;
  const editable = writable && (current === null || current.isLatest) && draft.editing;
  const update = (change: Partial<ReviewProtocolDraft>): void => {
    if (busy.current || activity.isLocked()) return;
    const next = {...draft, ...change, saveRequestId: crypto.randomUUID(), freezeRequestId: crypto.randomUUID()};
    drafts.set(draftKey, next); setDraft(next); setValidation(null); save.reset(); freeze.reset();
  };
  const begin = (): void => {busy.current = true; onPending(true); drafts.set(draftKey, draft);};
  const finish = (result: {ok: true; data: ResearchReviewProtocolInspection} | {ok: false; error: string}): void => {
    busy.current = false;
    if (!mounted.current) return;
    onPending(false);
    if (result.ok) {drafts.delete(draftKey); onSaved(result.data);}
  };
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-protocol-editor">
    {current === null ? null : <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted" data-testid="artifact-review-protocol-state">
        <dt>协议状态</dt><dd>{current.freeze === null ? '草稿' : '已冻结'}{current.isLatest ? ' 当前版本' : ' 历史版本'}</dd>
        <dt>版本</dt><dd>{current.version.version}</dd>
        <dt>记录人</dt><dd className="break-all">{current.version.actor.id}</dd>
        <dt>记录时间</dt><dd>{current.version.recordedAt}</dd>
        {current.version.deviationReason === null ? null : <><dt>修订说明</dt><dd className="break-words">{current.version.deviationReason}</dd></>}
        {current.freeze === null ? null : <><dt>审核人</dt><dd className="break-all">{current.freeze.actor.id}</dd>
          <dt>冻结时间</dt><dd>{current.freeze.frozenAt}</dd><dt>审核说明</dt><dd className="break-words">{current.freeze.request.reviewNote}</dd></>}
      </dl>
      {!writable || !current.isLatest || draft.editing ? null : <button type="button" className={`${button} self-start`}
        disabled={pending || activity.locked} data-testid="artifact-review-revise" onClick={() => update({editing: true})}>修订协议</button>}
    </>}
    {!draft.editing || (!editable && current !== null) ? null : <p role="status" data-testid="artifact-review-draft-status">未保存草稿</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!editable || busy.current || activity.isLocked()) return;
      const input: ResearchReviewProtocolSaveRequest = {
        projectId, requestId: draft.saveRequestId, protocolId: current?.version.protocolId ?? null,
        expectedVersionId: current?.version.id ?? null, expectedVersionHash: current?.versionHash ?? null,
        body: draft.body, deviationReason: current === null ? null : draft.deviationReason
      };
      const parsed = researchReviewProtocolSaveRequestSchema.safeParse(input);
      if (!parsed.success) {
        setValidation(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return;
      }
      begin(); void save.run(parsed.data).then(finish);
    }} className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-save-form">
      <ReviewProtocolFields body={editable || current === null ? draft.body : current.version.body} disabled={!editable || pending || activity.locked}
        onChange={body => update({body})} />
      {!editable || current === null ? null : <label className="flex flex-col gap-1 text-muted">修订原因
        <textarea aria-label="修订原因" required maxLength={10000} rows={3} disabled={pending || activity.locked} value={draft.deviationReason}
          className={`${formInputClass} border-[0.5px] h-auto py-1 resize-y`} onChange={event => update({deviationReason: event.target.value})} />
      </label>}
      {!editable ? null : <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`} disabled={pending || activity.locked}
        data-testid="artifact-review-save">{pending ? '正在保存…' : current === null ? '保存协议草稿' : '保存新版本'}</button>}
    </form>
    {validation === null ? null : <ul role="alert" className="text-[var(--st-warn)] break-words">{validation.map((issue, at) => <li key={at}>{issue}</li>)}</ul>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {current === null || !writable || !current.isLatest || current.freeze !== null || draft.editing ? null :
      <form className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-freeze-form" onSubmit={event => {
        event.preventDefault();
        if (busy.current || activity.isLocked()) return;
        const input = {projectId, requestId: draft.freezeRequestId, versionId: current.version.id,
          expectedVersionHash: current.versionHash, reviewNote: draft.reviewNote};
        begin(); void freeze.run(input).then(finish);
      }}>
        <label className="flex flex-col gap-1 text-muted">人工审核说明
          <textarea aria-label="人工审核说明" required maxLength={10000} disabled={pending || activity.locked} rows={3} className={`${formInputClass} border-[0.5px] h-auto py-1 resize-y`}
            value={draft.reviewNote} onChange={event => update({reviewNote: event.target.value})} />
        </label>
        <button type="submit" disabled={pending || activity.locked || draft.reviewNote.trim() === ''} className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          data-testid="artifact-review-freeze">确认并冻结此版本</button>
      </form>}
    {freeze.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{freeze.error}</p>}
  </section>;
}
