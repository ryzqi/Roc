import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchResponseMatrixSaveSchema, type ResearchResponseMatrixInspection, type ResearchResponseMatrixSave} from '../../shared/schemas/research-response-matrix';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass, formTextAreaClass} from '../shared/form-ui';
import {ResponseMatrixRow} from './ResponseMatrixRow';
import {responseStatusLabels} from './ResponseMatrixReceipt';

export function ResponseMatrixEditor({client, snapshot, report, writable, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchResponseMatrixInspection['report'];
  writable: boolean; onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const initial = report.review?.snapshot.request.rows ?? [];
  const [rows, setRows] = useState(initial), [selected, setSelected] = useState(initial[0]?.commentId ?? '');
  const [rationale, setRationale] = useState(''), [dirty, setDirty] = useState(false), [candidateDirty, setCandidateDirty] = useState(false);
  const [validation, setValidation] = useState<string | null>(null), [nonce, setNonce] = useState(0);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((request: ResearchResponseMatrixSave) => client.api.research.saveResponseMatrix(request), {label: '保存审稿矩阵'});
  const change = (): void => {setDirty(true); onDirty(true); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();};
  const row = rows.find(item => item.commentId === selected);
  return <form className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-response-editor" onSubmit={event => {
    event.preventDefault();
    if (!writable || busy.current) return;
    if (candidateDirty) {setValidation('先关联或清空待关联位置，再保存整份矩阵。'); return;}
    const parent = report.review;
    const parsed = researchResponseMatrixSaveSchema.safeParse({
      projectId: report.projectId, artifactId: report.artifactId, expectedArtifactVersion: report.artifactVersion,
      requestId: requestId.current, parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
      rationale, rows
    });
    if (!parsed.success) {setValidation('填写原始意见、审稿人和修订理由；已处理意见需要回复和修改位置，未采纳意见需要理由。'); return;}
    busy.current = true; onPending(true);
    void save.run(parsed.data).then(reply => {
      busy.current = false;
      if (!mounted.current) return;
      onPending(false);
      if (reply.ok) {setDirty(false); onDirty(false); onSaved();}
    });
  }}>
    <fieldset disabled={!writable || save.pending} className="flex min-w-0 flex-col gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-muted">选择审稿意见
        <select aria-label="选择审稿意见" className={`${formInputClass} border-[0.5px]`} value={selected} disabled={!writable || save.pending || candidateDirty}
          onChange={event => setSelected(event.target.value)}>
          <option value="">请选择</option>
          {rows.map(item => <option key={item.commentId} value={item.commentId}>
            {item.reviewer.length === 0 ? '新审稿人' : item.reviewer}，{responseStatusLabels[item.status]}：{item.comment.length === 0 ? '新意见' : item.comment}
          </option>)}
        </select>
      </label>
      <button type="button" className={`${formSecondaryButtonClass} self-start`} disabled={!writable || save.pending || candidateDirty || rows.length >= 200}
        data-testid="artifact-response-new" onClick={() => {
          const commentId = crypto.randomUUID();
          setRows(previous => [...previous, {commentId, reviewer: '', comment: '', status: 'open', response: '', locations: [], evidenceIds: []}]);
          setSelected(commentId); change();
        }}>录入新意见</button>
      {row === undefined ? null : <>
        <ResponseMatrixRow key={`${row.commentId}:${nonce}`} row={row} original={initial.some(item => item.commentId === row.commentId)}
          snapshot={snapshot} report={report} disabled={!writable || save.pending}
          onChange={value => {setRows(previous => previous.map(item => item.commentId === value.commentId ? value : item)); change();}}
          onCandidate={value => {setCandidateDirty(value); if (value) change();}}/>
        {initial.some(item => item.commentId === row.commentId) ? null : <button type="button" className={`${formSecondaryButtonClass} self-start`}
          data-testid="artifact-response-remove-new" onClick={() => {setRows(previous => previous.filter(item => item.commentId !== row.commentId));
            setSelected(''); setCandidateDirty(false); change();}}>移除未保存意见</button>}
      </>}
      <label className="flex min-w-0 flex-col gap-1 text-muted">矩阵修订理由
        <textarea required rows={4} maxLength={12000} aria-label="矩阵修订理由" className={`${formTextAreaClass} border-[0.5px] font-sans`}
          value={rationale} onChange={event => {setRationale(event.target.value); change();}}/>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={formPrimaryButtonClass} data-testid="artifact-response-save">保存审稿矩阵</button>
        <button type="button" className={formSecondaryButtonClass} disabled={!dirty} data-testid="artifact-response-discard"
          onClick={() => {setRows(initial); setSelected(initial[0]?.commentId ?? ''); setRationale(''); setDirty(false); setCandidateDirty(false);
            onDirty(false); setNonce(value => value + 1); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();}}>
          放弃矩阵修改
        </button>
      </div>
    </fieldset>
    {!writable ? <p className="text-muted">当前工件只读。</p> : null}
    {save.pending ? <p role="status">正在保存审稿矩阵，请等待回执。</p> : null}
    {validation === null ? null : <p role="alert" className="text-[var(--st-warn)]">{validation}</p>}
    {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
  </form>;
}
