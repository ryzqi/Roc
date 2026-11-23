import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Code2, FileText, Loader2, PanelLeft, Save } from 'lucide-react';
import type { FilePreviewResult } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { BEFORE_NAVIGATE, type NavigationRequest } from '../app/navigation-guard';
import { ModalShell } from '../shell/ModalShell';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime, formatBytes } from '../shared/format';
import {useViewActive} from '../shared/view-activity';
import { fileName } from '../workspace/paths';
import {previewFile, writeTextFile} from '../workspace/workspace-store';
import {workspaceDirectoryIndex} from '../workspace/directory-index';
import { SourceEditor } from './SourceEditor';
import type { SourceReplacement, SourceSelection } from './SourceEditor';
import {
  InlineCommandBar,
  type InlineCommandAction,
  type InlineReplacementProposal,
  type InlineSelectionContext
} from '../canvas/InlineCommandBar';
import { WorkspaceCompilePanel } from './WorkspaceCompilePanel';
import { InlineHint, primaryButtonClass } from './panel-shell';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import './authoring.css';

const ScientificMarkdown = retryableLazy(() => import('../literature/ScientificMarkdown'));
const ReadingFormula = retryableLazy(() => import('../literature/ReadingFormula'));
const FilePreview = retryableLazy(async () => ({ default: (await import('../canvas/files/FilePreview')).FilePreview }));

/**
 * 文稿 (P7/T7.5) — the workspace LaTeX/BibTeX editor behind the route's `latex` view.
 *
 * This replaces the legacy `LatexEditorView`, which "compiled" with a `setTimeout` over a local
 * file list. What it does now is the honest version of that surface:
 *
 *  - **Files come from the workspace** (`files.listTree` + `files.preview`), scoped to the
 *    extensions an author edits; nothing is synthesised.
 *  - **Saving is `files.writeText`** — and that call has **no `expectedHash`**: workspace writes
 *    are guarded by the backend's *recovery point* (`fileWriteResult.recoveryPoint` carries the
 *    pre-write sha256 and a snapshot path), not by optimistic concurrency. Hash-based concurrency
 *    exists only for *template* files (`research.template.saveFile`). The panel says so and shows
 *    the recovery point after a save, instead of claiming a guard the contract does not have.
 *  - **A truncated preview can never be saved.** `filePreviewResult.truncated` means the content
 *    is a prefix; saving it would overwrite the file with a fragment. The editor is read-only in
 *    that case with the reason.
 *  - **Compilation snapshots the saved workspace**, through the existing bounded compiler.
 *    PDF previews reuse the files.preview protocol and retain the editor beside the result.
 */

const EDITABLE_EXTENSIONS = ['.tex', '.bib', '.cls', '.sty', '.bbl', '.txt', '.md', '.json', '.yaml', '.yml', '.csv'];

export function LatexPanel(): React.JSX.Element {
  /**
   * Whether this panel may write.
   *
   * One rule now that the stage workspace is gone: the project's own archived flag. The
   * `writeAllowed` override this used to take existed for the *stage-group* half of the rule —
   * the stage workspace passed `scope.writable && stageGroupWriteAllowed(...)` because the
   * backend refuses artifact writes for a non-current stage but happily starts an experiment
   * run, so a panel gating on the archived flag alone would have offered live buttons behind a
   * 「只读：非当前阶段组」 badge. With the stage surface removed the override has no source, so the
   * prop went with it and the route-rendered predicate is the only one.
   */
  const scope = useWorkspaceScope();
  const active = useViewActive();
  const canWrite = scope.writable;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<{ proceed: () => void; kind?: 'unload' } | null>(null);
  const savingRef = useRef(false);
  const compilingRef = useRef(false);
  const [compiling, setCompiling] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<{ line: number; nonce: number } | null>(null);
  const dirtyRef = useRef(false);
  const [fileQuery, setFileQuery] = useState('');
  const [filesOpen, setFilesOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedFormula, setSelectedFormula] = useState('');
  const [sourceSelection, setSourceSelection] = useState<SourceSelection | null>(null);
  const [inlineProposal, setInlineProposal] = useState<InlineReplacementProposal | null>(null);
  const [replacement, setReplacement] = useState<SourceReplacement | null>(null);
  const replacementNonce = useRef(0);
  const liveDraft = useDeferredValue(draft ?? '');
  const [note, setNote] = useState<string | null>(null);

  const directoryIndex = useMemo(() => workspaceDirectoryIndex(scope.client, scope.workspacePath), [scope.client, scope.workspacePath]);
  const fileRead = useAsyncResource<{
    entries: { path: string; sizeBytes: number; updatedAt: string }[];
    partial: boolean;
  }>(
    !active || scope.workspacePath === null ? null : `latex-files:${scope.workspacePath}`,
    async () => {
      if (directoryIndex === null) throw new Error('工作目录尚未绑定。');
      const root = await directoryIndex.read('');
      if (!root.ok) {
        return root;
      }
      const collected: { path: string; sizeBytes: number; updatedAt: string }[] = [];
      let partial = root.data.truncated;
      for (const entry of root.data.entries) {
        if (entry.type === 'file' && isEditable(entry.name)) {
          collected.push({ path: entry.relativePath, sizeBytes: entry.size, updatedAt: entry.updatedAt });
        }
      }
      // One extra level covers the usual `chapters/` / `sections/` / `refs/` layout without
      // duplicating the sidebar's lazy tree.
      for (const entry of root.data.entries) {
        if (entry.type !== 'directory') {
          continue;
        }
        const nested = await directoryIndex.read(entry.relativePath);
        if (!nested.ok) {
          partial = true;
          continue;
        }
        partial ||= nested.data.truncated;
        for (const child of nested.data.entries) {
          if (child.type === 'file' && isEditable(child.name)) {
            collected.push({ path: child.relativePath, sizeBytes: child.size, updatedAt: child.updatedAt });
          }
        }
      }
      return { ok: true, data: {entries: collected, partial} };
    },
    { label: '扫描文稿文件' }
  );

  // Retained editors keep their draft and preview while hidden. Only directory
  // metadata sleeps; selecting the view again restores the key and rereads the
  // shared index, which the sidebar may have invalidated in the meantime.
  useEffect(() => {
    if (!active) return;
    return directoryIndex?.subscribe(fileRead.reload);
  }, [active, directoryIndex, fileRead.reload]);
  const refreshFiles = useCallback(() => directoryIndex?.invalidate(), [directoryIndex]);
  const files = {...fileRead, reload: refreshFiles};

  const preview = useAsyncResource<FilePreviewResult>(
    selectedPath === null || scope.workspacePath === null ? null : JSON.stringify(['latex-preview', scope.workspacePath, selectedPath]),
    () => previewFile(scope.client, selectedPath ?? ''),
    { label: '读取文稿文件' }
  );

  const save = useAsyncAction(
    (input: { path: string; content: string }) =>
      writeTextFile(scope.client, { relativePath: input.path, content: input.content, source: 'renderer/latex' }),
    { label: '保存文稿文件' }
  );
  const [recovery, setRecovery] = useState<string | null>(null);

  const previewData = preview.data;
  const isText = previewData !== null && previewData.kind === 'text';
  const isTruncated = isText && previewData.truncated;
  const canEdit = canWrite && preview.status === 'ready' && isText && !isTruncated;
  const entries = files.data?.entries ?? [];
  const visibleEntries = entries.filter(file => file.path.toLocaleLowerCase().includes(fileQuery.toLocaleLowerCase()));
  const markdownPreview = selectedPath?.toLowerCase().endsWith('.md') ?? false;
  const mathPreview = selectedPath?.toLowerCase().endsWith('.tex') ?? false;

  /** Latch the loaded text into `draft` once per path, so typing does not fight the reload. */
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedPath === null || previewData === null || !isText) {
      return;
    }
    if (loadedPathRef.current === selectedPath) {
      return;
    }
    loadedPathRef.current = selectedPath;
    setDraft(previewData.content);
    setBaseline(previewData.content);
    // 不清 note/recovery：保存后会立刻 `preview.reload()`，而重读会让本效应再跑一次 —— 那会把
    // 「已保存 N 字节」与 recovery point 在不到一次 IPC 往返内抹掉（评审 P2）。清空只发生在换文件时。
  }, [isText, previewData, selectedPath]);

  const selectFile = useCallback((path: string | null) => {
    loadedPathRef.current = null;
    setDraft(null);
    setBaseline(null);
    save.reset();
    setNote(null);
    setRecovery(null);
    setSelectedPath(path);
    setSelectedFormula('');
    setFocusLine(null);
    setSourceSelection(null);
    setInlineProposal(null);
    setReplacement(null);
  }, [save.reset]);

  const inlineSelection = sourceSelection === null || selectedPath === null ? null : {
    filePath: selectedPath,
    selectionText: sourceSelection.text,
    lineRange: sourceSelection.lineRange,
    source: 'workspace-file' as const
  } satisfies InlineSelectionContext;

  const applyInlineReplacement = useCallback((selection: InlineSelectionContext, nextText: string): boolean => {
    if (!canEdit || selectedPath === null || sourceSelection === null || selection.filePath !== selectedPath) return false;
    const current = (draft ?? previewData?.content ?? '').slice(sourceSelection.from, sourceSelection.to);
    if (current !== selection.selectionText) {
      setNote('选区已变化，请重新选择后再应用。');
      return false;
    }
    replacementNonce.current += 1;
    setReplacement({ from: sourceSelection.from, to: sourceSelection.to, text: nextText, nonce: replacementNonce.current });
    setSourceSelection(null);
    return true;
  }, [canEdit, draft, previewData?.content, selectedPath, sourceSelection]);

  useEffect(() => {
    const onProposal = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<InlineReplacementProposal> & { filePath?: string; selectionText?: string }>).detail;
      if (selectedPath === null || sourceSelection === null || detail.filePath !== selectedPath || detail.selectionText !== sourceSelection.text || typeof detail.replacement !== 'string') return;
      setInlineProposal({ original: sourceSelection.text, replacement: detail.replacement, requestId: detail.requestId });
    };
    window.addEventListener('roc:inline-selection-proposal', onProposal);
    return () => window.removeEventListener('roc:inline-selection-proposal', onProposal);
  }, [selectedPath, sourceSelection]);

  const handleInlineAction = (action: InlineCommandAction, selection: InlineSelectionContext): void => {
    window.dispatchEvent(new CustomEvent('roc:inline-selection-command', { detail: { action, context: selection } }));
    setNote(action === 'polish' ? '润色请求已发送，结果需确认后应用。' : action === 'send-to-assistant' ? '已将选区发送到助手草稿。' : '已发送选区请求。');
  };

  useEffect(() => {
    if (selectedPath !== null || entries.length === 0) return;
    const initial = scope.openFile != null && isEditable(scope.openFile) ? scope.openFile :
      entries.find(file => file.path === 'main.tex')?.path ?? entries[0]?.path;
    if (initial !== undefined) selectFile(initial);
  }, [entries, scope.openFile, selectFile, selectedPath]);

  const dirty = draft !== null && baseline !== null && draft !== baseline;
  dirtyRef.current = dirty;

  const requestLeave = (proceed: () => void): void => {
    if (savingRef.current) return;
    if (compilingRef.current) { setNote('编译进行中，请等待完成或先取消编译。'); return; }
    if (dirtyRef.current) setPendingLeave((current) => current ?? { proceed });
    else proceed();
  };
  const onSelect = (path: string | null): void => {
    if (path !== selectedPath) requestLeave(() => selectFile(path));
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!canEdit || selectedPath === null || draft === null || savingRef.current) return false;
    savingRef.current = true;
    const content = draft;
    try {
      const saved = await save.run({ path: selectedPath, content });
      if (!saved.ok) return false;
      setBaseline(content);
      dirtyRef.current = false;
      setNote(`已保存 ${saved.data.bytesWritten} 字节。`);
      setRecovery('写入前已保留备份。');
      directoryIndex?.invalidate(selectedPath);
      return true;
    } finally {
      savingRef.current = false;
    }
  };

  useEffect(() => {
    const guard = (event: Event): void => {
      const request = event as CustomEvent<NavigationRequest>;
      if (request.detail.next.projectId === scope.projectId && request.detail.next.view === 'writing') return;
      if (!dirtyRef.current && !savingRef.current && !compilingRef.current) return;
      if (savingRef.current || compilingRef.current) {
        event.preventDefault();
        if (compilingRef.current) setNote('编译进行中，请等待完成或先取消编译。');
        return;
      }
      setPendingLeave({ proceed: request.detail.defer() });
    };
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current && !savingRef.current && !compilingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
      if (!savingRef.current && !compilingRef.current) setPendingLeave((current) => current ?? { kind: 'unload', proceed: () => setNote('修改已处理，请重试关闭或刷新窗口。') });
    };
    window.addEventListener(BEFORE_NAVIGATE, guard);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, guard);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [scope.projectId]);

  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' && !event.isComposing) {
        event.preventDefault();
        if (dirtyRef.current) void saveDraft();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  if (scope.workspacePath === null) {
    return (
      <div className="flex h-full flex-col justify-center" data-testid="production-latex">
        <EmptyState
          icon={Code2}
          title="未绑定工作目录"
          action={{ label: '重试绑定', onClick: scope.rebindWorkspace }}
          testId="production-latex-no-workspace"
        />
      </div>
    );
  }


  const fileState = files.status === 'error' ? (
    <ErrorBar error={{level: 'page', message: files.error ?? '扫描文件失败'}} />
  ) : files.status === 'loading' && files.data === null ? (
    <EmptyState compact tone="loading" title="正在读取文稿列表…" />
  ) : files.data?.partial ? (
    <p role="status" className="text-xs">部分文稿未列出</p>
  ) : entries.length === 0 ? (
    <EmptyState compact title="没有可编辑的文稿文件" testId="production-latex-empty" />
  ) : null;

  return (
    <>
    <ModalShell
      open={pendingLeave !== null}
      title="保存文稿修改？"
      testId="latex-unsaved"
      closeOnBackdrop={false}
      beforeClose={() => !savingRef.current}
      onClose={() => setPendingLeave(null)}
      widthClassName="w-[520px]"
      footer={<>
        <button type="button" disabled={save.pending} onClick={() => setPendingLeave(null)} className="rounded-control border-[0.5px] border-line px-3 py-1">取消</button>
        <button type="button" disabled={save.pending} onClick={() => {
          const action = pendingLeave;
          setPendingLeave(null);
          dirtyRef.current = false;
          setDraft(baseline);
          action?.proceed();
        }} className="rounded-control border-[0.5px] border-line px-3 py-1">放弃修改</button>
        <button type="button" disabled={save.pending || !canEdit} onClick={() => {
          const action = pendingLeave;
          void saveDraft().then((saved) => {
            if (!saved) return;
            setPendingLeave(null);
            action?.proceed();
          });
        }} className={primaryButtonClass}>{save.pending ? '正在保存…' : pendingLeave?.kind === 'unload' ? '保存' : '保存并继续'}</button>
      </>}
    >
      <p className="text-ink">{selectedPath} 有未保存的修改。放弃后无法恢复这些修改。{pendingLeave?.kind === 'unload' ? '处理后请重试关闭或刷新窗口。' : ''}</p>
      {save.error === null ? null : <p role="alert" className="text-[var(--st-bad)]">{save.error}</p>}
    </ModalShell>
    <div className="authoring-panel" data-testid="production-latex" data-files-open={filesOpen}>
      <header className="authoring-toolbar">
        <button type="button" className="authoring-toggle-files" aria-label={filesOpen?'收起文稿列表':'展开文稿列表'} aria-pressed={filesOpen} onClick={()=>setFilesOpen(value=>!value)}><PanelLeft size={15} aria-hidden="true"/></button>
        <h1>文稿</h1><span className="text-muted">{entries.length} 个文件</span>
        <button type="button" className="authoring-refresh" onClick={files.reload} disabled={files.status==='loading'}>重新扫描</button>
      </header>
      <WorkspaceCompilePanel client={scope.client} projectId={scope.projectId} writable={canWrite}
        files={entries} beforeCompile={() => dirtyRef.current ? saveDraft() : Promise.resolve(true)}
        onBusyChange={busy => { compilingRef.current = busy; setCompiling(busy); if (busy) setPdfPreview(null); }} onPreview={path => { setPdfPreview(path); setPreviewOpen(false); }}
        onDiagnostic={(path, line) => requestLeave(() => {
          if (path !== selectedPath) selectFile(path);
          setFocusLine({ line: line ?? 1, nonce: Date.now() });
        })}>
      <div className="authoring-layout">

      <label className="authoring-file-picker">
        <span className="shrink-0 text-muted text-[length:var(--font-meta-size)]">文稿</span>
        <select
          aria-label="选择文稿文件"
          value={selectedPath ?? ""}
          disabled={compiling || save.pending}
          onChange={(event) => onSelect(event.target.value === "" ? null : event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-control border-[0.5px] border-line bg-surface px-2 text-ink text-[length:var(--font-meta-size)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
        >
          <option value="">选择文稿文件</option>
          {entries.map((file) => (
            <option key={file.path} value={file.path}>{file.path}</option>
          ))}
        </select>
      </label>
      <nav
        aria-label="文稿文件"
        className="authoring-files"
        data-testid="production-latex-files"
      >
        <span className="text-subtle text-[length:var(--font-meta-size)]">
          文稿文件{files.data === null ? '' : `（${entries.length.toLocaleString('zh-CN')}）`}
        </span>
        <input aria-label="筛选文稿" placeholder="筛选文件名" value={fileQuery} onChange={event=>setFileQuery(event.target.value)} className="authoring-file-search"/>
        {fileState}
        {entries.length > 0 && visibleEntries.length === 0 ? <p className="p-3 text-muted">没有匹配的文稿</p> : null}
        {entries.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {visibleEntries.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  data-testid={`production-latex-file-${file.path}`}
                  data-selected={file.path === selectedPath ? 'true' : 'false'}
                  aria-current={file.path === selectedPath ? 'true' : undefined}
                  onClick={() => onSelect(file.path)}
                  disabled={compiling || save.pending}
                  className={[
                    'flex w-full min-w-0 flex-col items-start rounded-control px-2 py-1 text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                    file.path === selectedPath
                      ? 'bg-[var(--overlay-active)] text-ink'
                      : 'text-muted hover:bg-[var(--overlay-hover)] hover:text-ink'
                  ].join(' ')}
                >
                  <span className="w-full truncate font-mono text-[length:var(--font-meta-size)]" title={`${file.path}\n${formatBytes(file.sizeBytes)}\n${formatBeijingDateTime(file.updatedAt)}`}>
                    {fileName(file.path)}
                  </span>
                  {file.path.includes('/')?<span className="authoring-file-parent">{file.path.slice(0,file.path.lastIndexOf('/'))}</span>:null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="authoring-file-state">{fileState}</div>
        {selectedPath === null && entries.length > 0 ? (
          <EmptyState
            icon={FileText}
            title="选择一个文稿文件"
            testId="production-latex-no-file"
          />
        ) : selectedPath === null ? null : (
          <section className="flex min-h-0 flex-1 flex-col" data-testid="production-latex-editor">
            <header className="authoring-editor-toolbar">
              <h2 className="min-w-0 flex-1 truncate text-[length:var(--font-ui-size)] font-medium" title={selectedPath}>{fileName(selectedPath)}</h2>
              {isText ? <span role="status" data-testid="latex-dirty-indicator" className="text-muted text-[length:var(--font-meta-size)]">{dirty ? '未保存' : canWrite && !isTruncated ? '已保存' : '只读'}</span> : null}
              {isText&&(markdownPreview||mathPreview)?<button type="button" aria-pressed={previewOpen} onClick={()=>setPreviewOpen(value=>!value)} data-testid="latex-toggle-preview">{markdownPreview?'实时预览':'公式预览'}</button>:null}
              <button type="button" disabled={save.pending || compiling} data-testid="production-latex-reload"
                onClick={() => requestLeave(() => {
                  loadedPathRef.current = null;
                  setDraft(baseline);
                  dirtyRef.current = false;
                  preview.reload();
                })}
                className="rounded-control px-2 py-1 text-muted hover:bg-[var(--overlay-hover)] disabled:opacity-50">
                重新读取
              </button>
              <button type="button" data-testid="production-latex-save" disabled={!canEdit || save.pending || compiling || !dirty}
                onClick={() => void saveDraft()} className="authoring-secondary" title="保存 (⌘S)">
                {save.pending ? <Loader2 size={14} aria-hidden="true" className="mr-1 inline animate-spin motion-reduce:animate-none" /> :
                  <Save size={14} aria-hidden="true" className="mr-1 inline" />}{save.pending ? '保存中…' : '保存'}
              </button>
            </header>
            {preview.status === 'loading' ? <InlineHint text="正在读取文件…" /> : null}
            {preview.status === 'error' ? (
              <ErrorBar error={{ level: 'page', message: preview.error ?? '读取文件失败', retry: preview.reload }} />
            ) : null}
            {previewData !== null && previewData.kind !== 'text' ? (
              <InlineHint
                text="此文件无法编辑，请在文件视图中预览。"
                testId="production-latex-not-text"
              />
            ) : null}
            {isTruncated ? (
              <p className="text-[var(--st-warn)] text-[length:var(--font-meta-size)]" data-testid="production-latex-truncated" role="note">
                文件过大，编辑器只读。
              </p>
            ) : null}
            {isText ? (
              <>
                <div className="authoring-editor-layout" data-preview-open={pdfPreview !== null || previewOpen&&(markdownPreview||mathPreview)}>
                  <div className="authoring-source"><SourceEditor key={selectedPath} value={draft ?? previewData.content} readOnly={!canEdit || save.pending || compiling} focusLine={focusLine}
                    replacement={replacement} onSelectionChange={selection => {
                      setSourceSelection(selection);
                      setInlineProposal(null);
                      setSelectedFormula(selection?.text ?? '');
                    }} onChange={(value) => { setDraft(value); setNote(null); setRecovery(null); }} /></div>
                  {pdfPreview !== null ? <section className="authoring-live-preview" aria-label="编译 PDF 预览">
                    <LazyBoundary fallback={<p role="status">正在打开 PDF…</p>}><FilePreview client={scope.client} projectId={scope.projectId}
                      workspacePath={scope.workspacePath} relativePath={pdfPreview} writable={canWrite} onClose={() => setPdfPreview(null)} /></LazyBoundary>
                  </section> : previewOpen&&(markdownPreview||mathPreview)?<section className="authoring-live-preview" aria-label={markdownPreview?'Markdown 实时预览':'所选公式预览'}>
                    <header>{markdownPreview?'实时预览':'所选公式预览'}</header>
                    <div className="authoring-preview-content"><LazyBoundary fallback={<p role="status">正在加载预览…</p>}>
                      {markdownPreview?<ScientificMarkdown text={liveDraft}/>:selectedFormula.trim()?<ReadingFormula text={selectedFormula.trim().replace(/^\\[[(]|\\[)\]]$/g,'')}/>:<p className="text-muted">选中源码中的公式以预览</p>}
                    </LazyBoundary></div>
                  </section>:null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t-[0.5px] border-line px-3 py-1.5">
                  <span className="text-subtle text-[length:var(--font-meta-size)]" role="status" data-testid="production-latex-state">
                    {canEdit ? (dirty ? '有未保存的修改' : '与磁盘一致') : '只读'}　{formatBytes(entries.find(file => file.path === selectedPath)?.sizeBytes ?? previewData.sizeBytes)}
                  </span>
                  {canWrite ? null : (
                    <span className="text-[var(--st-warn)] text-[length:var(--font-meta-size)]" data-testid="production-latex-readonly">
                      项目已归档：文件只读。
                    </span>
                  )}
                </div>
                {note === null ? null : (
                  <p role="status" className="shrink-0 px-3 text-muted text-[length:var(--font-meta-size)]" data-testid="production-latex-save-note">
                    {note}
                  </p>
                )}
                {recovery === null ? null : (
                  <p className="shrink-0 px-3 text-subtle text-[length:var(--font-meta-size)]" data-testid="production-latex-recovery">
                    {recovery}
                  </p>
                )}
                {save.error === null ? null : <InlineHint text={save.error} testId="production-latex-save-error" />}
              </>
            ) : null}
          </section>
        )}

      </div>
      </div>
      </WorkspaceCompilePanel>
    </div>
    <InlineCommandBar
      selection={inlineSelection}
      anchor={sourceSelection?.anchor ?? null}
      onAction={handleInlineAction}
      onDismiss={() => { setSourceSelection(null); setInlineProposal(null); }}
      onApplyReplacement={applyInlineReplacement}
      proposal={inlineProposal}
      onAcceptProposal={() => {
        if (inlineSelection === null || inlineProposal === null) return;
        applyInlineReplacement(inlineSelection, inlineProposal.replacement);
        setInlineProposal(null);
      }}
      onRejectProposal={() => setInlineProposal(null)}
    />
    </>
  );
}

function isEditable(name: string): boolean {
  const lower = name.toLowerCase();
  return EDITABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
