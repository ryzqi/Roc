import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, FileWarning, Loader2, Save } from 'lucide-react';
import type { RocClient } from '../../shared/roc-client';
import { useAsyncResource } from '../../app/use-async-resource';
import { ErrorBar } from '../../shell/ErrorBar';
import { EmptyState } from '../../shell/EmptyState';
import { useCopyFeedback } from '../../shared/hooks/use-copy-feedback';
import { formatBytes } from '../../shared/format';
import { isEditablePreviewKind, previewKindFor } from '../../workspace/paths';
import { previewFile, previewPdf, writeTextFile } from '../../workspace/workspace-store';

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
 * ## Assumption to verify in the P10 manual pass
 *
 * For `kind: 'image'` the schema is `{ content: string, mediaType?: string }`,
 * i.e. the bytes arrive as text. This renders them as a base64 data URL, which is
 * the only encoding a string payload can carry for an image. If the backend
 * instead returns something else, the `<img onError>` path below degrades to an
 * explicit message rather than showing a broken image.
 */

export type FilePreviewProps = {
  client: RocClient;
  relativePath: string;
  /** Archived projects are read-only: no editing, no saving. */
  writable: boolean;
  /** Reports unsaved state so the shell can warn before closing. */
  onDirtyChange?: (dirty: boolean) => void;
};

const WRITE_SOURCE = 'renderer-next:file-preview';

export function FilePreview({
  client,
  relativePath,
  writable,
  onDirtyChange
}: FilePreviewProps): React.JSX.Element {
  const kind = previewKindFor(relativePath);
  const isPdf = kind === 'pdf';

  // PDFs take a different call; using the wrong resource here would be invisible
  // in a typecheck, so the branch is explicit.
  const pdfResource = useAsyncResource(isPdf ? relativePath : null, () => previewPdf(client, relativePath), {
    label: '读取 PDF 预览'
  });
  const textResource = useAsyncResource(isPdf ? null : relativePath, () => previewFile(client, relativePath), {
    label: '读取文件预览'
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const copy = useCopyFeedback();

  const resource = isPdf ? pdfResource : textResource;
  const loaded = textResource.data;
  const editable = !isPdf && writable && isEditablePreviewKind(kind) && loaded?.kind !== 'binary';
  const dirty = draft !== null && draft !== loaded?.content;

  // A new file must not inherit the previous file's draft.
  useEffect(() => {
    setDraft(null);
    setSaveError(null);
    setSavedAt(null);
    setImageFailed(false);
  }, [relativePath]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    if (draft === null || !editable) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await writeTextFile(client, { relativePath, content: draft, source: WRITE_SOURCE });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error.message);
      return;
    }
    setSavedAt(result.data.recoveryPoint.createdAt);
    textResource.reload();
  }, [client, draft, editable, relativePath, textResource]);

  const body = useMemo(() => {
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
            icon={FileWarning}
            title="无法显示图片"
            description="该图片编码不受支持。可在系统默认应用中打开它。"
            testId="file-preview-image-failed"
          />
        );
      }
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          <img
            src={`data:${loaded.mediaType ?? 'image/png'};base64,${loaded.content}`}
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
          description={`${formatBytes(loaded.sizeBytes)} · 无法以文本方式预览。`}
          testId="file-preview-binary"
        />
      );
    }

    if (editable && draft !== null) {
      return (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          aria-label={`编辑 ${relativePath}`}
          data-testid="file-preview-editor"
          className="h-full w-full resize-none bg-code-surface p-3 font-mono text-[var(--font-code-size)] text-[var(--code-text)] outline-none"
        />
      );
    }

    return (
      <pre
        data-testid="file-preview-text"
        className="h-full overflow-auto bg-code-surface p-3 font-mono text-[var(--font-code-size)] text-[var(--code-text)]"
      >
        {loaded.content}
      </pre>
    );
  }, [resource, isPdf, pdfResource.data, loaded, editable, draft, imageFailed, relativePath]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-preview" data-kind={kind}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]" title={relativePath} data-testid="file-preview-path">
          {relativePath}
        </span>
        {!isPdf && loaded !== null ? (
          <span className="text-subtle text-[var(--font-micro-size)]">{formatBytes(loaded.sizeBytes)}</span>
        ) : null}
        {loaded?.truncated === true ? (
          <span className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="file-preview-truncated">
            已截断
          </span>
        ) : null}
        {dirty ? (
          <span className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="file-preview-dirty">
            未保存
          </span>
        ) : savedAt === null ? null : (
          <span className="text-[var(--st-ok)] text-[var(--font-micro-size)]" data-testid="file-preview-saved">
            已保存
          </span>
        )}

        <button
          type="button"
          onClick={() => copy.copy(loaded?.content ?? '')}
          disabled={loaded === null}
          data-testid="file-preview-copy"
          className="flex h-6 items-center gap-1 rounded-control border border-line px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
        >
          <Copy size={11} aria-hidden="true" />
          <span className="text-[var(--font-micro-size)]">{copy.copied ? '已复制' : '复制'}</span>
        </button>

        {!editable ? null : draft === null ? (
          <button
            type="button"
            onClick={() => setDraft(loaded?.content ?? '')}
            data-testid="file-preview-edit"
            className="h-6 rounded-control border border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
          >
            <span className="text-[var(--font-micro-size)]">编辑</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setDraft(null)}
              data-testid="file-preview-discard"
              className="h-6 rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              <span className="text-[var(--font-micro-size)]">放弃</span>
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              data-testid="file-preview-save"
              className="flex h-6 items-center gap-1 rounded-control bg-[var(--fill-strong)] px-2 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] disabled:opacity-40"
            >
              <Save size={11} aria-hidden="true" />
              <span className="text-[var(--font-micro-size)]">{saving ? '保存中…' : '保存'}</span>
            </button>
          </>
        )}
      </div>

      {!writable ? (
        <p role="note" className="shrink-0 border-b border-line bg-bg-soft px-3 py-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="file-preview-readonly">
          项目已归档，仅可阅读。
        </p>
      ) : null}

      {saveError === null ? null : (
        <div className="shrink-0 p-2">
          <ErrorBar error={{ level: 'page', message: saveError }} onDismiss={() => setSaveError(null)} />
        </div>
      )}

      {copy.error === null ? null : (
        <p role="alert" className="shrink-0 px-3 py-1 text-[var(--st-bad)] text-[var(--font-micro-size)]">
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
    </div>
  );
}
