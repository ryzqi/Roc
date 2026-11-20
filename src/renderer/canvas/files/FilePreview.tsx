import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../../shell/LazyBoundary';
import { Copy, FileWarning, Loader2, Save, X } from 'lucide-react';
import type { RocClient } from '../../shared/roc-client';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { ErrorBar } from '../../shell/ErrorBar';
import { EmptyState } from '../../shell/EmptyState';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { formPrimaryButtonClass, formSecondaryButtonClass } from '../../shared/form-ui';
import { useCopyFeedback } from '../../shared/hooks/use-copy-feedback';
import { formatBytes } from '../../shared/format';
import { isEditablePreviewKind, previewKindFor } from '../../workspace/paths';
import { previewFile, previewPdf, writeTextFile } from '../../workspace/workspace-store';
import '../tools-workspace.css';

/**
 * File preview (P3/T3.3).
 *
 * Dispatch is by extension, but the backend's `kind` wins for text/binary so an
 * unknown extension cannot be misrendered as source code.
 *
 * PDFs do **not** come through `files.preview`: the backend returns a
 * custom-protocol `resourceUrl` from `files.previewPdf`, and that URL is used
 * directly. Blob URLs are forbidden because the file is on disk and the renderer
 * has no filesystem access (R9) — `URL.createObjectURL` must not appear here.
 *
 * Writing goes through `files.writeText`, which requires a `source`; it records a
 * recovery point on the backend, so the value names this surface. When the
 * project is archived, editing is disabled rather than failing later — that is
 * the write-side half of the read-only gate (see `isProjectWritable`).
 *
 * ## Image contract (verified against the real backend, P3 gate run)
 *
 * For `kind: 'image'` the backend returns `content` already **as a complete
 * `data:<mediaType>;base64,…` URL** (`FileService.preview` builds it). Prepending
 * the prefix again produced `data:image/png;base64,data:image/png;base64,…`, which
 * the browser rejects with `ERR_INVALID_URL` and renders as nothing. So the value
 * is used as-is when it is already a data URL, and only built from raw base64 when
 * it is not; an oversized image comes back as `kind: 'binary'` with a `mediaType`
 * and never reaches this branch.
 */

export type FilePreviewProps = {
  client: RocClient;
  projectId: string | null;
  relativePath: string;
  /**
   * Bound workspace, used as part of the resource key.
   *
   * The same relative path exists in every workspace, so without this the preview
   * of `README.md` in project A would stay on screen after switching to project B
   * — a leak that today is masked only by `useBoundWorkspace` clearing the bound
   * path while rebinding. Correctness must not depend on that transient state.
   */
  workspacePath: string | null;
  /** Archived projects are read-only: no editing, no saving. */
  writable: boolean;
  /** Reports unsaved state so the shell can warn before closing. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The owner blocks every close path while a write is in flight. */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Renders a close control at the end of the header row.
   *
   * The PDF branch renders an `<iframe>`, and once the iframe has focus key events
   * cannot reach the parent overlay. A visible close button is the affordance
   * that does not depend on where focus happens to be.
   */
  onClose?: () => void;
};

const WRITE_SOURCE = 'renderer:file-preview';
const ScientificMarkdown = retryableLazy(() => import('../../literature/ScientificMarkdown'));
const NotebookPreview = retryableLazy(() => import('./NotebookPreview'));

export function FilePreview(props: FilePreviewProps): React.JSX.Element {
  if (previewKindFor(props.relativePath) === 'notebook') {
    return (
      <LazyBoundary resetKey={JSON.stringify([props.workspacePath, props.relativePath])}
        fallback={<p role="status" className="p-3 text-muted">读取 Notebook 中…</p>}>
        <NotebookPreview client={props.client} projectId={props.projectId} workspacePath={props.workspacePath}
          relativePath={props.relativePath} writable={props.writable} onClose={props.onClose} />
      </LazyBoundary>
    );
  }
  return <OrdinaryFilePreview key={JSON.stringify([props.projectId, props.workspacePath, props.relativePath])} {...props} />;
}

function OrdinaryFilePreview({
  client,
  relativePath,
  workspacePath,
  writable,
  onDirtyChange,
  onSavingChange,
  onClose
}: FilePreviewProps): React.JSX.Element {
  const kind = previewKindFor(relativePath);
  const isPdf = kind === 'pdf';
  const [renderMarkdown, setRenderMarkdown] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const isMarkdown = /\.md(?:own)?$/i.test(relativePath);
  const resourceKey = workspacePath === null ? null : JSON.stringify([workspacePath, relativePath]);

  // PDFs take a different call; using the wrong resource here would be invisible
  // in a typecheck, so the branch is explicit.
  const pdfResource = useAsyncResource(isPdf ? resourceKey : null, () => previewPdf(client, relativePath), {
    label: '读取 PDF 预览'
  });
  const textResource = useAsyncResource(isPdf ? null : resourceKey, () => previewFile(client, relativePath), {
    label: '读取文件预览'
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const saveAction = useAsyncAction(
    (content: string) => writeTextFile(client, { relativePath, content, source: WRITE_SOURCE }),
    { label: '保存文件' }
  );
  const saving = saveAction.pending;
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const reportingRef = useRef({ onDirtyChange, onSavingChange });
  reportingRef.current = { onDirtyChange, onSavingChange };
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const copy = useCopyFeedback();

  const resource = isPdf ? pdfResource : textResource;
  const loaded = textResource.data;
  const editable = !isPdf && writable && loaded !== null && !loaded.truncated &&
    isEditablePreviewKind(kind) && loaded.kind !== 'binary';
  const content = savedContent ?? loaded?.content ?? '';
  const dirty = draft !== null && draft !== content;
  const discard = (): void => {
    setConfirmDiscard(false);
    setDraft(null);
    saveAction.reset();
  };

  // The keyed instance owns one workspace/file, including any pending completion.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reportingRef.current.onDirtyChange?.(false);
      reportingRef.current.onSavingChange?.(false);
    };
  }, []);

  useEffect(() => {
    if (savedContent !== null && loaded?.content === savedContent) setSavedContent(null);
  }, [loaded, savedContent]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    if (savingRef.current || draft === null || !dirty || !editable) {
      return;
    }
    savingRef.current = true;
    onSavingChange?.(true);
    const result = await saveAction.run(draft);
    savingRef.current = false;
    if (!mountedRef.current) return;
    onSavingChange?.(false);
    if (!result.ok) {
      return;
    }
    setSavedContent(draft);
    setSavedAt(result.data.recoveryPoint.createdAt);
    textResource.reload();
  }, [draft, dirty, editable, onSavingChange, saveAction, textResource]);

  const body = useMemo(() => {
    if (resource.status === 'error' && resource.data === null) return null;
    if (resource.status === 'loading' && resource.data === null) {
      return (
        <p className="flex items-center gap-2 p-4 text-muted" role="status" data-testid="file-preview-loading">
          <Loader2 size={13} aria-hidden="true" className="animate-spin" />
          正在读取文件…
        </p>
      );
    }

    if (isPdf) {
      const pdf = pdfResource.data;
      if (pdf === null) {
        return <EmptyState title="无法预览 PDF" description="文件可能已被移动或无法读取。" testId="file-preview-pdf-empty" />;
      }
      return (
        <iframe
          title={`PDF 预览 ${relativePath}`}
          src={pdf.resourceUrl}
          data-testid="file-preview-pdf"
          className="h-full w-full border-0 bg-surface"
        />
      );
    }

    if (loaded === null) {
      return <EmptyState title="无法预览文件" description="文件可能已被移动或无法读取。" testId="file-preview-empty" />;
    }

    if (loaded.kind === 'image') {
      if (imageFailed) {
        return (
          <EmptyState
            tone="error"
            icon={FileWarning}
            title="无法显示图片"
            action={{ label: '重新读取图片', onClick: () => { setImageFailed(false); textResource.reload(); } }}
            testId="file-preview-image-failed"
          />
        );
      }
      // The backend already hands out a full data URL; building one again would
      // double the prefix (see the contract note above).
      const source = loaded.content.startsWith('data:')
        ? loaded.content
        : `data:${loaded.mediaType ?? 'image/png'};base64,${loaded.content}`;
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          <img
            src={source}
            alt={relativePath}
            data-testid="file-preview-image"
            onError={() => setImageFailed(true)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }

    if (loaded.kind === 'binary') {
      return (
        <EmptyState
          icon={FileWarning}
          title="二进制文件"
          testId="file-preview-binary"
        />
      );
    }

    if (isMarkdown && renderMarkdown && loaded.kind === 'text') {
      return <div className="tools-markdown-preview"><LazyBoundary fallback={<p role="status">正在渲染…</p>}><ScientificMarkdown text={draft ?? content}/></LazyBoundary></div>;
    }

    if (editable && draft !== null) {
      return (
        <textarea
          dir="ltr"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          wrap={wrapLines?'soft':'off'}
          aria-label={`编辑 ${relativePath}`}
          data-testid="file-preview-editor"
          className="h-full w-full resize-none bg-code-surface p-3 font-mono text-[length:var(--font-code-size)] text-[var(--code-text)]"
        />
      );
    }

    return (
      <pre
        dir="ltr"
        tabIndex={0}
        aria-label={`文件内容 ${relativePath}`}
        data-testid="file-preview-text"
        style={{whiteSpace:wrapLines?'pre-wrap':'pre',overflowWrap:wrapLines?'anywhere':'normal'}}
        className="h-full overflow-auto bg-code-surface p-3 font-mono text-[length:var(--font-code-size)] text-[var(--code-text)]"
      >
        {content}
      </pre>
    );
  }, [resource, isPdf, pdfResource.data, loaded, content, editable, draft, saving, imageFailed, relativePath, textResource.reload, isMarkdown, renderMarkdown, wrapLines]);

  return (
    <div className="tools-file-preview flex h-full min-h-0 flex-col" data-testid="file-preview" data-kind={kind}>
      <div className="tools-file-toolbar">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--font-meta-size)]" title={relativePath} data-testid="file-preview-path">
          {relativePath}
        </span>
        {!isPdf && loaded !== null ? (
          <span dir="ltr" className="tabular-nums text-subtle text-[length:var(--font-meta-size)]">{formatBytes(loaded.sizeBytes)}</span>
        ) : null}
        {loaded?.truncated === true ? (
          <span className="text-[var(--st-warn)] text-[length:var(--font-micro-size)]" data-testid="file-preview-truncated">
            已截断
          </span>
        ) : null}
        {dirty ? (
          <span className="text-[var(--st-warn)] text-[length:var(--font-micro-size)]" data-testid="file-preview-dirty">
            未保存
          </span>
        ) : savedAt === null ? null : (
          <span className="text-[var(--st-ok)] text-[length:var(--font-micro-size)]" data-testid="file-preview-saved">
            已保存
          </span>
        )}
        {onClose === undefined ? null : (
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={`关闭 ${relativePath} 的预览`}
            data-testid="file-preview-close"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}

        {loaded?.kind==='text'?<div className="tools-file-view-controls">
          {isMarkdown?<button type="button" aria-pressed={renderMarkdown} onClick={()=>setRenderMarkdown(value=>!value)} data-testid="file-preview-render">{renderMarkdown?'查看源码':'阅读视图'}</button>:null}
          {!renderMarkdown?<button type="button" aria-pressed={wrapLines} onClick={()=>setWrapLines(value=>!value)} data-testid="file-preview-wrap">自动换行</button>:null}
        </div>:null}
        <button
          type="button"
          onClick={() => copy.copy(draft ?? content)}
          disabled={loaded === null || loaded.kind === 'binary' || loaded.kind === 'image'}
          data-testid="file-preview-copy"
          className={formSecondaryButtonClass}
        >
          <Copy size={11} aria-hidden="true" />
          <span className="text-[length:var(--font-micro-size)]">{copy.copied ? '已复制' : '复制'}</span>
        </button>

        {!editable ? null : draft === null ? (
          <button
            type="button"
            onClick={() => {setRenderMarkdown(false);setDraft(content);}}
            data-testid="file-preview-edit"
            className={formSecondaryButtonClass}
          >
            <span className="text-[length:var(--font-micro-size)]">编辑</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                if (savingRef.current) return;
                if (dirty) setConfirmDiscard(true);
                else discard();
              }}
              disabled={saving}
              data-testid="file-preview-discard"
              className={formSecondaryButtonClass}
            >
              <span className="text-[length:var(--font-micro-size)]">放弃</span>
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              data-testid="file-preview-save"
              aria-busy={saving}
              className={formPrimaryButtonClass}
            >
              {saving ? <Loader2 size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Save size={12} aria-hidden="true" />}
              <span className="text-[length:var(--font-micro-size)]">{saving ? '保存中…' : '保存'}</span>
            </button>
          </>
        )}
      </div>

      {!writable ? (
        <p role="note" className="shrink-0 border-b-[0.5px] border-line bg-bg-soft px-3 py-1 text-[var(--st-warn)] text-[length:var(--font-micro-size)]" data-testid="file-preview-readonly">
          项目已归档，仅可阅读。
        </p>
      ) : null}

      {loaded?.truncated && isEditablePreviewKind(kind) ? (
        <p role="note" className="shrink-0 border-b-[0.5px] border-line bg-bg-soft px-3 py-1 text-muted text-[length:var(--font-micro-size)]" data-testid="file-preview-truncated-readonly">
          预览仅包含文件的部分内容，无法编辑。
        </p>
      ) : null}

      {saveAction.error === null ? null : (
        <div className="shrink-0 p-2">
          <ErrorBar error={{ level: 'page', message: saveAction.error }} onDismiss={saveAction.reset} />
        </div>
      )}

      {copy.error === null ? null : (
        <p role="alert" className="shrink-0 px-3 py-1 text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
          {copy.error}
        </p>
      )}

      {resource.status === 'error' ? (
        <div className="shrink-0 p-2">
          <ErrorBar
            error={{ level: 'page', message: resource.error ?? '读取文件失败', retry: resource.reload }}
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1">{body}</div>
      <ConfirmDialog
        open={confirmDiscard}
        title="放弃文件修改？"
        message={`“${relativePath}”的未保存修改将丢失，无法恢复。`}
        confirmLabel="放弃修改"
        tone="destructive"
        onConfirm={discard}
        onCancel={() => setConfirmDiscard(false)}
        testId="file-preview-discard-confirmation"
      />
    </div>
  );
}
