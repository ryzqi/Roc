import {useRef, useState} from 'react';
import {researchFeedbackImportSchema, type ResearchFeedbackImport, type ResearchFeedbackInspection, type ResearchFeedbackMerge} from '../../shared/schemas/research-feedback';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactDraftDiscard, useArtifactEditorStatus} from './artifact-editor-guard';
import type {CollaborationProps} from './ArtifactCollaboration';

const button = formSecondaryButtonClass;
const kinds = {comment: '批注', insertion: '插入建议', deletion: '删除建议'};
const mappings = {exact: '准确定位', ambiguous: '多处匹配', unmatched: '尚未匹配'};
export function CollaborationFeedback({client, snapshot, writable, onChanged}: CollaborationProps): React.JSX.Element {
  const projectId = snapshot.artifact.projectId, artifactId = snapshot.artifact.id;
  const [path, setPath] = useState(''), [dirty, setDirty] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ResearchFeedbackInspection | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [itemIds, setItemIds] = useState<string[]>([]), [offset, setOffset] = useState(0);
  const busy = useRef(false), importId = useRef(crypto.randomUUID()), mergeId = useRef(crypto.randomUUID());
  const status = useArtifactEditorStatus({label: '协作意见', dirty, pending: () => busy.current});
  const importFile = useAsyncAction((input: ResearchFeedbackImport) => client.api.research.importFeedback(input), {label: '导入协作意见'});
  const merge = useAsyncAction((input: ResearchFeedbackMerge) => client.api.research.mergeFeedback(input), {label: '合并协作意见'});
  const history = useAsyncResource(`feedback:list:${projectId}:${artifactId}:${offset}`,
    () => client.api.research.listFeedback({projectId, artifactId, offset, limit: 10}), {label: '读取意见导入记录'});
  const get = useAsyncResource(selectedId === null ? null : `feedback:get:${projectId}:${selectedId}`,
    () => client.api.research.getFeedback({projectId, feedbackId: selectedId!}), {label: '核对意见原文件'});
  const current = selectedId === null ? receipt : get.status === 'ready' ? get.data : null;
  const pending = importFile.pending || merge.pending;
  const reset = (): void => {setPath(''); setDirty(false); setItemIds([]); setValidation(null); importFile.reset(); merge.reset();
    importId.current = crypto.randomUUID(); mergeId.current = crypto.randomUUID();};
  return <section className="flex min-w-0 flex-col gap-3" aria-label="Word 与 PDF 意见导入" data-testid="artifact-feedback">
    <fieldset disabled={!writable || status.locked || pending} className="flex min-w-0 flex-col gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-muted">意见文件（工作区 .docx / .pdf 相对路径）
        <input className={formInputClass} maxLength={1024} value={path} onChange={event => {
          setPath(event.target.value); setDirty(true); importId.current = crypto.randomUUID(); setValidation(null); importFile.reset();
        }}/>
      </label>
      <button type="button" className={`${button} self-start`} data-testid="artifact-feedback-import" disabled={path.trim() === ''} onClick={() => {
        if (busy.current || status.isLocked()) return;
        const parsed = researchFeedbackImportSchema.safeParse({projectId, artifactId, expectedArtifactVersion: snapshot.version,
          requestId: importId.current, path: path.trim(), expectedFileHash: null});
        if (!parsed.success) {setValidation('请选择工作区内的 .docx 或 .pdf 文件。'); return;}
        busy.current = true;
        void importFile.run(parsed.data).then(result => {busy.current = false; if (result.ok) {
          setReceipt(result.data); setSelectedId(null); setItemIds([]); setDirty(false); setPath(''); history.reload();
        }});
      }}>{importFile.pending ? '正在读取意见…' : '读取原始批注与修订'}</button>
    </fieldset>
    {current === null ? null : <>
      <p className="break-words text-muted">{current.snapshot.source.path}，{current.snapshot.items.length.toLocaleString()} 条原始记录</p>
      {!current.currentArtifact || !current.sourceCurrent ? <p role="alert" className="text-[var(--st-warn)]">
        {!current.currentArtifact ? '稿件内容已变化。' : ''}{!current.sourceCurrent ? '原文件已变化。' : ''}请重新导入后合并。
      </p> : null}
      <p className="text-muted">所选原始记录将加入待回复意见，正文修订仍需另行确认。</p>
      {current.snapshot.issues.map(issue => <p key={issue} className="break-words text-muted">{issue}</p>)}
      <ul className="flex min-w-0 flex-col gap-3">{current.snapshot.items.map(item => <li key={item.id} className="min-w-0 border-t-[0.5px] border-line pt-2">
        <label className="flex min-w-0 items-start gap-2"><input type="checkbox" className="mt-1 shrink-0" checked={itemIds.includes(item.id)}
          disabled={!writable || status.locked || pending || !current.currentArtifact || !current.sourceCurrent}
          onChange={event => {setItemIds(event.target.checked ? [...itemIds, item.id] : itemIds.filter(id => id !== item.id));
            setDirty(true); mergeId.current = crypto.randomUUID(); merge.reset();}}/>
          <span className="min-w-0 whitespace-pre-wrap break-words">{kinds[item.kind]}：{item.text}</span>
        </label>
        <p className="mt-1 break-words text-muted">{item.author || '未记录作者'}{item.date ? `，${item.date}` : ''}，{mappings[item.mapping.status]}</p>
        {item.quote === '' ? null : <blockquote className="mt-2 whitespace-pre-wrap break-words text-muted">原文：{item.quote}</blockquote>}
        {item.mapping.location === null ? null : <p className="break-all text-muted">主张 {item.mapping.location.claimId}，字符 {item.mapping.location.start}–{item.mapping.location.end}</p>}
        {item.page === null ? null : <p className="text-muted tabular-nums">原 PDF 第 {item.page} 页</p>}
        <details className="mt-1 min-w-0 text-muted"><summary className="cursor-pointer">原记录身份</summary>
          <p className="break-all">{item.originalId}</p><p className="break-all font-mono">文件 SHA-256 {current.snapshot.source.sha256}</p>
        </details>
      </li>)}</ul>
      <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={!writable || status.locked || pending || itemIds.length === 0 || !current.currentArtifact || !current.sourceCurrent}
        data-testid="artifact-feedback-merge" onClick={() => {
          if (busy.current || status.isLocked()) return;
          busy.current = true;
          void merge.run({projectId, feedbackId: current.snapshot.id, expectedHash: current.snapshotHash, expectedArtifactVersion: snapshot.version,
            requestId: mergeId.current, itemIds}).then(result => {busy.current = false; if (result.ok) {setDirty(false); setItemIds([]); onChanged();}});
        }}>{merge.pending ? '正在保存待回复意见…' : `合并 ${itemIds.length} 条为待回复意见`}</button>
    </>}
    <ArtifactDraftDiscard dirty={dirty} testId="artifact-feedback-discard" onDiscard={reset}/>
    {[history.error, get.error, importFile.error, merge.error, validation].filter(error => error !== null).map((error, index) =>
      <p role="alert" key={index} className="break-words text-[var(--st-warn)]">{error}</p>)}
    {pending ? <p role="status">正在保存协作回执…</p> : null}
    <details className="min-w-0"><summary className="cursor-pointer text-muted">已导入意见</summary>
      <ul className="mt-2 flex min-w-0 flex-col gap-2">{history.data?.items.map(item => <li key={item.snapshot.id}>
        <button type="button" className={`${button} max-w-full break-words text-left`} disabled={dirty || pending} onClick={() => {setSelectedId(item.snapshot.id); setReceipt(null);}}>
          {item.snapshot.source.path}，{item.snapshot.recordedAt}
        </button>
      </li>)}</ul>
      {history.data === null ? null : <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={dirty || pending || offset === 0} onClick={() => setOffset(offset - 10)}>上一页导入</button>
        <button type="button" className={button} disabled={dirty || pending || offset + 10 >= history.data.total} onClick={() => setOffset(offset + 10)}>下一页导入</button>
      </div>}
    </details>
  </section>;
}
