import {useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref} from 'react';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {ResearchDocumentPreview} from '../../shared/schemas/research-document-preview';
import type {
  ResearchDocumentAnnotationTarget, ResearchDocumentAnnotationCreateRequest,
  ResearchDocumentAnnotationInspection, ResearchDocumentAnnotationCaptureRequest
} from '../../shared/schemas/research-document-annotations';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ErrorBar} from '../shell/ErrorBar';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import {BEFORE_NAVIGATE, type NavigationRequest} from '../app/navigation-guard';
import {useImeGuard} from '../shared/hooks/use-ime-guard';
import {BEFORE_READING_CHANGE, type ReadingChangeRequest} from './reading-interactions';

const issues: ReadonlyArray<{value: ResearchDocumentAnnotationCreateRequest['issue']; label: string}> = [
  {value: 'note', label: '笔记'}, {value: 'number', label: '数字问题'}, {value: 'unit', label: '单位问题'},
  {value: 'formula', label: '公式问题'}, {value: 'table', label: '表格问题'}, {value: 'recognition', label: '识别问题'}
];
export type AnnotationDraft = {id: string; page: number; location: ResearchDocumentAnnotationTarget['location']};
export type AnnotationTransitionGuard = {request: (proceed: () => void) => void};
type AnnotationEditor = {dirty: () => boolean; busy: () => boolean; clearDirty: () => void};
type Props = {
  client: RocClient; projectId: string; document: ResearchDocument; parsed: ResearchDocumentParse; preview: ResearchDocumentPreview;
  canAnnotate: boolean; draft: AnnotationDraft | null; onCreatePage: () => void; onCloseDraft: () => void;
  onSelect: (target: ResearchDocumentAnnotationTarget) => void;
  transitionGuardRef?: Ref<AnnotationTransitionGuard>;
};

/** Window-owned draft and sealed saved notes. A user note never represents scientific approval. */
export default function PaperAnnotations(props: Props): React.JSX.Element {
  const {client, projectId, document, parsed, preview, canAnnotate, draft, onCreatePage, onCloseDraft, onSelect, transitionGuardRef} = props;
  const read = useAsyncResource(JSON.stringify([projectId, document.id, parsed.run.id]), () =>
    client.api.research.listDocumentAnnotations({projectId, documentId: document.id, parseId: parsed.run.id}), {label: '读取研究批注'});
  const [saved, setSaved] = useState<ResearchDocumentAnnotationInspection | null>(null);
  const editor = useRef<AnnotationEditor | null>(null);
  const captures = useRef(new Set<string>());
  const [, updateCapture] = useState(0);
  const [confirmation, setConfirmation] = useState<{proceed: () => void} | null>(null);
  const confirmationRef = useRef(confirmation);
  const closeDraft = useRef(onCloseDraft); closeDraft.current = onCloseDraft;
  const busy = (): boolean => editor.current?.busy() === true || captures.current.size > 0;
  const request = (proceed: () => void): void => {
    if (busy()) return;
    if (!editor.current?.dirty()) {proceed(); return;}
    const next = {proceed}; confirmationRef.current = next; setConfirmation(next);
  };
  useImperativeHandle(transitionGuardRef, () => ({request}));
  const capturePending = useCallback((id: string, pending: boolean): void => {
    if (pending) captures.current.add(id); else captures.current.delete(id);
    updateCapture(value => value + 1);
  }, []);
  const editorActivityChanged = useCallback(() => updateCapture(value => value + 1), []);
  useEffect(() => {
    const protect = (event: Event, defer: () => () => void): void => {
      if (busy()) {event.preventDefault(); return;}
      if (editor.current?.dirty()) request(defer());
    };
    const navigation = (event: Event): void => {
      const change = event as CustomEvent<NavigationRequest>;
      if (change.detail.next.projectId !== projectId) protect(event, change.detail.defer);
    };
    const selection = (event: Event): void => {
      const change = event as CustomEvent<ReadingChangeRequest>;
      if (change.detail.projectId === projectId) protect(event, change.detail.defer);
    };
    const unload = (event: BeforeUnloadEvent): void => {
      if (!busy() && !editor.current?.dirty()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener(BEFORE_NAVIGATE, navigation);
    window.addEventListener(BEFORE_READING_CHANGE, selection);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, navigation);
      window.removeEventListener(BEFORE_READING_CHANGE, selection);
      window.removeEventListener('beforeunload', unload);
    };
  }, [projectId]);
  const annotations = read.status === 'ready' ? read.data : null;
  return <section className="mb-2 min-w-0 border-b-[0.5px] border-line pb-2 text-[length:var(--font-meta-size)]"
    data-testid="reader-annotations" aria-label="研究批注">
    <div className="flex items-center gap-2">
      <span className="mr-auto font-medium">研究批注</span>
      <button type="button" disabled={busy()} onClick={() => {if (!busy()) read.reload();}}
        className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">重读批注</button>
      {canAnnotate ? <button type="button" disabled={busy()} onClick={() => request(onCreatePage)}
        className="rounded-control px-1 hover:bg-[var(--overlay-hover)]">本页批注</button> : null}
    </div>
    {read.status === 'loading' ? <p role="status" className="text-muted">读取批注…</p> : null}
    {read.error === null ? null : <ErrorBar error={{level: 'blocked', message: read.error, retry: read.reload}}/>}
    {saved === null ? null : <p role="status" data-testid="reader-annotation-saved">批注已保存，第 {saved.annotation.request.target.page} 页。</p>}
    {draft === null ? null : <AnnotationForm key={draft.id} client={client} projectId={projectId} document={document}
      parsed={parsed} preview={preview} draft={draft} writable={canAnnotate} editorRef={editor} onCancel={() => request(onCloseDraft)}
      onActivityChanged={editorActivityChanged}
      onSaved={result => {setSaved(result); onCloseDraft(); read.reload();}}/>}
    {annotations === null ? null : annotations.length === 0 ? <p className="text-muted">此解析版本暂无批注。</p> :
      <ul className="mt-1 min-w-0">{annotations.map(inspection => <AnnotationItem key={inspection.annotation.id}
        client={client} inspection={inspection} canCapture={canAnnotate && document.currentParseId === parsed.run.id}
        onSelect={target => request(() => onSelect(target))} onChanged={read.reload} onPendingChange={capturePending}/>)}</ul>}
    <ConfirmDialog open={confirmation !== null} title="放弃未保存的批注？"
      message="当前批注中未保存的说明、类型和解析块选择将被放弃。" confirmLabel="放弃批注并继续"
      tone="destructive" confirmDisabled={busy()} testId="annotation-draft-discard"
      onCancel={() => {confirmationRef.current = null; setConfirmation(null);}}
      onConfirm={() => {
        if (busy()) return;
        const next = confirmationRef.current;
        confirmationRef.current = null; setConfirmation(null);
        editor.current?.clearDirty(); closeDraft.current();
        next?.proceed();
      }}/>
  </section>;
}

function AnnotationForm({client, projectId, document, parsed, preview, draft, writable, editorRef, onActivityChanged, onCancel, onSaved}: {
  client: RocClient; projectId: string; document: ResearchDocument; parsed: ResearchDocumentParse; preview: ResearchDocumentPreview;
  draft: AnnotationDraft; writable: boolean; editorRef: Ref<AnnotationEditor>;
  onActivityChanged: () => void;
  onCancel: () => void; onSaved: (result: ResearchDocumentAnnotationInspection) => void
}): React.JSX.Element {
  const [blockId, setBlockId] = useState('');
  const [issue, setIssue] = useState<ResearchDocumentAnnotationCreateRequest['issue']>('note');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(draft.id);
  const saving = useRef(false);
  const fields = useRef({blockId: '', issue: 'note', note: '', region: draft.location.kind === 'pdf-region'});
  const ime = useImeGuard();
  useImperativeHandle(editorRef, () => ({
    dirty: () => fields.current.blockId !== '' || fields.current.issue !== 'note' || fields.current.note !== '' || fields.current.region,
    busy: () => saving.current,
    clearDirty: () => {fields.current = {blockId: '', issue: 'note', note: '', region: false};}
  }));
  const mounted = useRef(true);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    noteRef.current?.focus({preventScroll: true});
    noteRef.current?.scrollIntoView({block: 'nearest'});
    return () => {mounted.current = false;};
  }, []);
  const edit = (): void => {requestId.current = crypto.randomUUID(); setError(null);};
  const frame = preview.coordinates?.pages.find(value => value.page === draft.page)?.frame;
  const basis = preview.coordinates !== null && frame?.kind === 'pdf' ? {snapshotHash: preview.coordinates.snapshotHash, frame} : null;
  const blocks = parsed.content.blocks.filter(block => block.locations.some(location => location.page === draft.page));
  const save = async (): Promise<void> => {
    if (saving.current || !writable || !note.trim()) return;
    saving.current = true;
    onActivityChanged();
    const target: ResearchDocumentAnnotationTarget = {projectId, documentId: document.id, parseId: parsed.run.id,
      sourceHash: preview.sourceHash, parseHash: preview.parseHash, parserFingerprint: parsed.content.parserFingerprint,
      page: draft.page, blockId: blockId === '' ? null : blockId, coordinateBasis: basis, location: draft.location};
    setPending(true); setError(null);
    try {
      const result = await client.api.research.createDocumentAnnotation({requestId: requestId.current, target, issue, note});
      if (!mounted.current) return;
      if (!result.ok) {setError(result.error.message); return;}
      fields.current = {blockId: '', issue: 'note', note: '', region: false};
      onSaved(result.data);
    } catch (error) {if (mounted.current) setError(error instanceof Error ? error.message : String(error));}
    finally {
      saving.current = false;
      if (mounted.current) {setPending(false); onActivityChanged();}
    }
  };
  return <form className="my-2 flex min-w-0 flex-col gap-2" data-testid="reader-annotation-form"
    onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
    onKeyDown={event => {if (ime.shouldIgnoreKeyDown(event) && event.key === 'Enter') event.preventDefault();}}
    onSubmit={event => {event.preventDefault(); void save();}}>
    <p className="text-muted">第 {draft.page} 页，{draft.location.kind === 'page' ? '页定位' : '原文框选区域'}</p>
    {basis !== null || draft.location.kind !== 'page' ? null : <p role="note" className="text-muted">此页未保存测量坐标，批注仅记录页。</p>}
    <label className="flex flex-wrap items-center gap-1">解析块
      <select aria-label="批注解析块" value={blockId} disabled={pending || !writable} onChange={event => {
        if (saving.current) return;
        edit(); fields.current.blockId = event.target.value; setBlockId(event.target.value);
      }}
        className="min-w-0 max-w-full rounded-control border-[0.5px] border-line bg-surface px-1">
        <option value="">不关联解析块</option>
        {blocks.map(block => <option key={block.id} value={block.id}>{block.label}，{block.locator}</option>)}
      </select>
    </label>
    <label className="flex items-center gap-1">类型
      <select aria-label="批注类型" value={issue} disabled={pending || !writable} onChange={event => {
        if (saving.current) return;
        edit(); fields.current.issue = event.target.value; setIssue(event.target.value as ResearchDocumentAnnotationCreateRequest['issue']);
      }} className="rounded-control border-[0.5px] border-line bg-surface px-1">
        {issues.map(issue => <option key={issue.value} value={issue.value}>{issue.label}</option>)}
      </select>
    </label>
    <label className="flex flex-col gap-1">说明
      <textarea ref={noteRef} aria-label="批注说明" rows={3} maxLength={10000} value={note} disabled={pending || !writable}
        onChange={event => {if (saving.current) return; edit(); fields.current.note = event.target.value; setNote(event.target.value);}}
        className="min-w-0 resize-y rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink"/>
    </label>
    {error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!writable || pending || !note.trim()}
        className="rounded-control bg-accent px-2 py-1 text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40">{pending ? '保存中…' : '保存批注'}</button>
      <button type="button" disabled={pending} onClick={onCancel}
        className="rounded-control px-2 py-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">取消批注</button>
    </div>
  </form>;
}

function AnnotationItem({client, inspection, canCapture, onSelect, onChanged, onPendingChange}: {
  client: RocClient; inspection: ResearchDocumentAnnotationInspection; canCapture: boolean;
  onSelect: (target: ResearchDocumentAnnotationTarget) => void; onChanged: () => void;
  onPendingChange: (id: string, pending: boolean) => void
}): React.JSX.Element {
  const {annotation, capture, capturedReferenceStatus} = inspection, {target, issue, note} = annotation.request;
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const capturing = useRef(false);
  const request = useRef<ResearchDocumentAnnotationCaptureRequest | null>(null);
  useEffect(() => {mounted.current = true; return () => {
    mounted.current = false; onPendingChange(annotation.id, false);
  };}, [annotation.id, onPendingChange]);
  const captureBlock = async (): Promise<void> => {
    if (capturing.current || !canCapture) return;
    capturing.current = true; onPendingChange(annotation.id, true);
    request.current ??= {projectId: target.projectId, annotationId: annotation.id,
      requestId: crypto.randomUUID(), expectedAnnotationHash: inspection.annotationHash};
    setPending(true); setError(null);
    try {
      const result = await client.api.research.captureDocumentAnnotation(request.current);
      if (!mounted.current) return;
      if (!result.ok) {setError(result.error.message); return;}
      onChanged();
    } catch (error) {if (mounted.current) setError(error instanceof Error ? error.message : String(error));}
    finally {
      capturing.current = false; onPendingChange(annotation.id, false);
      if (mounted.current) setPending(false);
    }
  };
  return <li className="min-w-0 border-t-[0.5px] border-line py-2" data-testid="reader-annotation">
    <p>{issues.find(value => value.value === issue)!.label}，第 {target.page} 页，{target.location.kind === 'page' ? '页定位' : '框选区域'}</p>
    <p className="whitespace-pre-wrap break-words">{note}</p>
    <p className="break-words text-muted">{annotation.block === null ? '未关联解析块' : `${annotation.block.label}，${annotation.block.locator}`}</p>
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => onSelect(target)} className="rounded-control px-1 hover:bg-[var(--overlay-hover)]">回到批注位置</button>
      {capture !== null ? <span className="text-muted">{capturedReferenceStatus === 'superseded' ? '已捕获证据，来源引用已失效' : '已捕获证据，科学结论待审核'}</span> :
        canCapture && annotation.block !== null && annotation.block.text.trim() ? <button type="button" disabled={pending}
          onClick={() => void captureBlock()} className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">
          {pending ? '捕获中…' : '捕获所选块为证据'}
        </button> : annotation.block !== null ? <span className="text-muted">历史或只读来源，不能捕获新证据</span> : null}
    </div>
    {error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{error}</p>}
    <details className="mt-1 min-w-0 text-muted">
      <summary className="cursor-pointer">来源版本</summary>
      <p className="break-all">原文 SHA-256 {target.sourceHash}</p>
      <p className="break-all">解析 {target.parseId}，SHA-256 {target.parseHash}</p>
      {target.location.kind === 'page' ? null : <p className="break-words">PDF 区域 {target.location.bbox.join(', ')}</p>}
      <p className="break-words">记录人 {annotation.actor.id}，{annotation.recordedAt}</p>
    </details>
  </li>;
}
