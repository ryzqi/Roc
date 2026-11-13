import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePlus2, Loader2, Search, X } from 'lucide-react';
import type { RocClient } from '../../shared/roc-client';
import { useAsyncAction } from '../../app/use-async-resource';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { ModalShell } from '../../shell/ModalShell';
import { BEFORE_NAVIGATE, type NavigationRequest } from '../../app/navigation-guard';
import { joinRelative, parentRelative, checkRelativePath, pathRejectionMessage } from '../../workspace/paths';
import { useFileNameSearch } from '../../workspace/use-file-search';
import { writeTextFile } from '../../workspace/workspace-store';
import { FilePreview } from './FilePreview';
import { FileTreeView } from './FileTreeView';

/**
 * The sidebar's 文件 tab (P3/T3.2, T3.4).
 *
 * Three states in one panel, because they are three views of the same thing and
 * the user switches between them constantly:
 *
 *   1. **Tree** — the default; a lazily loaded real directory tree.
 *   2. **Name search** — `files.searchByName` while a query is typed. This is the
 *      sidebar's search entry point; the ⌘K palette is the one that searches file
 *      *contents* as well (T3.4 draws that line explicitly).
 *   3. **New file** — an inline form, because creating a file is the one write
 *      action the file tree needs and a modal for one text field would be worse.
 *
 * The new-file path is assembled from the open file's directory (or the workspace
 * root) and validated with the same `checkRelativePath` the data layer uses, so a
 * typed `../` is refused here with the same specific message the backend would
 * give — R10 wants the failure early, not different.
 *
 * ## Clicking a row opens the preview modal, not a canvas page
 *
 * The model (`FileTreeView` → `onPreviewFile` → `FilePreviewModal`): the tree is the file
 * *list*, and the file itself is a modal over whatever canvas view is open. It replaced the
 * canvas `files` view, which meant clicking a file navigated the
 * whole canvas away — so a researcher reading a paper lost it by looking at a `notes.md`.
 *
 * Selection still travels through the URL (`onOpenFile` → `?file=`), because that is what
 * the tree reads to reveal and highlight the row, and because a reload must land on the
 * same file. The modal is opened here, next to the click, instead of being
 * derived from the route: which overlay is on screen is view state, not navigation.
 *
 * A create form is hidden entirely for an archived project rather than disabled
 * after the fact: `files.writeText` must not be reachable when the project is
 * read-only.
 */

const NEW_FILE_WRITE_SOURCE = 'renderer:file-tree-new';

export type FileSidebarPanelProps = {
  client: RocClient;
  workspacePathKey: string | null;
  projectId: string | null;
  /** Archived projects are read-only. */
  writable: boolean;
  openFile: string | null;
  onOpenFile: (relativePath: string) => void;
  /** A file another surface asked to preview; see `LeftSidebar`'s `SidebarFilesTab`. */
  previewRequest?: { relativePath: string; nonce: number } | null;
  /** Called once the request has been adopted, so the shell can clear it. See the adopt effect. */
  onPreviewRequestConsumed?: () => void;
};

export function FileSidebarPanel({
  client,
  workspacePathKey,
  projectId,
  writable,
  openFile,
  onOpenFile,
  previewRequest = null,
  onPreviewRequestConsumed
}: FileSidebarPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const createAction = useAsyncAction(
    (relativePath: string) => writeTextFile(client, { relativePath, content: '', source: NEW_FILE_WRITE_SOURCE }),
    { label: '创建文件' }
  );
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const workspaceRef = useRef(workspacePathKey);
  workspaceRef.current = workspacePathKey;
  /** Set when a search result is opened, so the tree can reveal it (T3.4). */
  const [revealPath, setRevealPath] = useState<string | null>(null);
  /** The file whose preview modal is open, over whatever canvas view is on screen. */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [confirmPreviewClose, setConfirmPreviewClose] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [previewSaving, setPreviewSaving] = useState(false);
  const previewTransitionRef = useRef<(() => void) | null>(null);
  const previewDirtyRef = useRef(false);
  const previewSavingRef = useRef(false);
  const reportPreviewDirty = useCallback((dirty: boolean) => {
    previewDirtyRef.current = dirty;
    setPreviewDirty(dirty);
  }, []);
  const reportPreviewSaving = useCallback((saving: boolean) => {
    previewSavingRef.current = saving;
    setPreviewSaving(saving);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const closePreview = (): void => {
    setPreviewPath(null);
    setConfirmPreviewClose(false);
    previewDirtyRef.current = false;
    previewTransitionRef.current = null;
  };
  const requestPreviewTransition = (proceed: () => void): void => {
    if (previewDirtyRef.current || previewSavingRef.current) {
      previewTransitionRef.current = proceed;
      setConfirmPreviewClose(true);
      return;
    }
    proceed();
  };
  const canClosePreview = (): boolean => {
    if (previewSavingRef.current) return false;
    if (previewDirtyRef.current) {
      previewTransitionRef.current = closePreview;
      setConfirmPreviewClose(true);
      return false;
    }
    return true;
  };
  const requestClosePreview = (): void => {
    if (canClosePreview()) closePreview();
  };

  const search = useFileNameSearch(client, workspacePathKey, query);
  const searching = query.trim().length > 0;

  const openFileForPreview = (relativePath: string): void => {
    if (relativePath === previewPath) return;
    requestPreviewTransition(() => {
      setPreviewPath(relativePath);
      onOpenFile(relativePath);
    });
  };

  useEffect(() => {
    const beforeNavigate = (event: Event): void => {
      const request = event as CustomEvent<NavigationRequest>;
      if (request.detail.next.projectId === projectId ||
          (!previewDirtyRef.current && !previewSavingRef.current)) return;
      if (previewSavingRef.current) {
        event.preventDefault();
        return;
      }
      const resume = request.detail.defer();
      requestPreviewTransition(() => {
        closePreview();
        resume();
      });
    };
    window.addEventListener(BEFORE_NAVIGATE, beforeNavigate);
    return () => window.removeEventListener(BEFORE_NAVIGATE, beforeNavigate);
  }, [projectId]);

  // A successful save can make a deferred transition safe without discarding.
  useEffect(() => {
    if (!confirmPreviewClose || previewDirty || previewSaving) return;
    const proceed = previewTransitionRef.current;
    previewTransitionRef.current = null;
    setConfirmPreviewClose(false);
    proceed?.();
  }, [confirmPreviewClose, previewDirty, previewSaving]);

  /**
   * Adopt a preview request from another surface.
   *
   * The nonce is compared against the last one seen, so asking for the *same* file twice still
   * opens it and a re-render never re-opens a preview the user just closed. The selection
   * travels with it, so the tree highlights the row and `?file=` stays the single source of
   * which file is current.
   *
   * ## Why the request must be *acknowledged*, not merely remembered
   *
   * "Which nonce did I last see" cannot live in this component alone, because this component is
   * deliberately remounted when the bound workspace changes (`LeftSidebar` keys it on
   * `binding.path`, which is what makes gate 6's project switch hand the tree fresh state). A ref
   * dies with the instance, so after a switch it read `0` while the shell still held
   * `{ nonce: 1 }` — and the request was **re-delivered**: it re-opened the previous project's
   * file, whose read fails in the new workspace, leaving a full-screen "无法预览 PDF" overlay that
   * covered the canvas and blocked every click (the P3 gate could not reach the terminal).
   *
   * The fix is the missing half of a convention this shell already uses: `assistantSeed` is paired
   * with `onComposerSeedConsumed`, and the request stops existing as soon as it is adopted. A
   * pending request therefore cannot outlive the workspace it was made in, which is also why the
   * callback is not in the dependency list — `previewRequest` is the trigger, as before.
   */
  const lastPreviewRequestRef = useRef(0);
  useEffect(() => {
    if (previewRequest === null || previewRequest.nonce === lastPreviewRequestRef.current) {
      return;
    }
    lastPreviewRequestRef.current = previewRequest.nonce;
    const relativePath = previewRequest.relativePath;
    if (relativePath !== previewPath) {
      requestPreviewTransition(() => {
        setQuery('');
        setRevealPath(relativePath);
        setPreviewPath(relativePath);
      });
    }
    onPreviewRequestConsumed?.();
  }, [previewRequest]);

  const openFromSearch = (relativePath: string): void => {
    // Clear the query first so the tree is what the reveal lands in.
    setQuery('');
    setRevealPath(relativePath);
    openFileForPreview(relativePath);
  };

  /**
   * The open file, validated locally before anything is requested (R10).
   *
   * This check used to live in the canvas `files` view. That view is gone — files are revealed
   * in this tree — so the tree/panel pair owns selection and the refusal that
   * goes with it.
   */
  const openPathCheck = openFile === null ? null : checkRelativePath(openFile);
  const rejectedPath =
    openFile !== null && openPathCheck !== null && !openPathCheck.ok
      ? { relativePath: openFile, reason: openPathCheck.reason }
      : null;

  const targetDirectory = openFile === null ? '' : parentRelative(openFile);

  const submitNewFile = async (): Promise<void> => {
    if (creatingRef.current || !writable || workspacePathKey === null) return;
    const name = draftName.trim();
    if (name.length === 0) {
      return;
    }
    if (name.includes('/')) {
      setCreateError('只填文件名即可，不需要包含目录分隔符。');
      return;
    }
    const relativePath = joinRelative(targetDirectory, name);
    const check = checkRelativePath(relativePath);
    if (!check.ok) {
      setCreateError(pathRejectionMessage(check.reason));
      return;
    }
    creatingRef.current = true;
    setCreateError(null);
    const workspace = workspacePathKey;
    const result = await createAction.run(relativePath);
    creatingRef.current = false;
    if (!mountedRef.current || workspaceRef.current !== workspace) return;
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    setCreating(false);
    setDraftName('');
    openFileForPreview(relativePath);
  };

  const createForm = writable && creating ? (
    <form
      className="flex shrink-0 flex-col gap-1 border-b-[0.5px] border-line-soft px-2 pb-2"
      data-testid="file-create-form"
      aria-busy={createAction.pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submitNewFile();
      }}
    >
      <div className="flex items-center gap-1">
        <input
          value={draftName}
          disabled={createAction.pending}
          onChange={(event) => setDraftName(event.target.value)}
          autoFocus
          placeholder="新文件名，例如 notes.md"
          aria-label="新文件名"
          data-testid="file-create-name"
          className="h-[var(--control-height-compact)] min-w-0 flex-1 rounded-control border-[0.5px] border-line bg-surface px-2 text-ink placeholder:text-subtle"
        />
        <button
          type="submit"
          disabled={createAction.pending || draftName.trim().length === 0}
          data-testid="file-create-submit"
          className="h-[var(--control-height-compact)] shrink-0 rounded-control bg-[var(--fill-strong)] px-2 text-[var(--fill-strong-text)] disabled:opacity-40"
        >
          {createAction.pending ? '创建中…' : '创建'}
        </button>
        <button
          type="button"
          disabled={createAction.pending}
          onClick={() => {
            setCreating(false);
            setDraftName('');
            setCreateError(null);
          }}
          aria-label="取消新建文件"
          data-testid="file-create-cancel"
          className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control text-muted hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <p className="text-subtle text-[length:var(--font-micro-size)]">
        创建于 {targetDirectory.length === 0 ? '工作目录根' : `${targetDirectory}/`}
      </p>
      {createError === null ? null : (
        <p role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]" data-testid="file-create-error">
          {createError}
        </p>
      )}
    </form>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-sidebar-panel">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div className="flex h-[var(--control-height-compact)] min-w-0 flex-1 items-center gap-1.5 rounded-control border-[0.5px] border-line bg-surface px-2">
          <Search size={12} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按文件名搜索"
            aria-label="按文件名搜索"
            data-testid="file-search-input"
            className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-subtle"
          />
          {searching ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              data-testid="file-search-clear"
              className="shrink-0 rounded-control p-0.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {writable && workspacePathKey !== null && !creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label="新建文件"
            title="新建文件"
            data-testid="file-create-open"
            className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control text-muted hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <FilePlus2 size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {createForm}

      <div className="min-h-0 flex-1">
        {!searching ? (
          <FileTreeView
            client={client}
            workspacePathKey={workspacePathKey}
            projectId={projectId}
            selectedPath={openFile}
            onOpenFile={openFileForPreview}
            revealPath={revealPath}
            rejectedPath={rejectedPath}
          />
        ) : search.status === 'loading' ? (
          <p className="flex items-center gap-2 px-3 py-3 text-muted" role="status" data-testid="file-search-loading">
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            正在搜索文件名…
          </p>
        ) : search.status === 'error' ? (
          <p role="alert" className="px-3 py-3 text-[var(--st-bad)] text-[length:var(--font-meta-size)]" data-testid="file-search-error">
            {search.error ?? '搜索失败'}
          </p>
        ) : search.data === null || search.data.matches.length === 0 ? (
          <p className="px-3 py-3 text-muted text-[length:var(--font-meta-size)]" data-testid="file-search-empty">
            没有匹配的文件名。
          </p>
        ) : (
          <ul className="min-h-0 overflow-y-auto py-1" data-testid="file-search-results">
            {search.data.matches.map((match) => (
              <li key={match.relativePath}>
                <button
                  type="button"
                  onClick={() => openFromSearch(match.relativePath)}
                  title={match.relativePath}
                  data-testid={`file-search-result-${match.relativePath}`}
                  className={
                    match.relativePath === openFile
                      ? 'flex w-full flex-col items-start bg-accent-soft px-2 py-1 text-left'
                      : 'flex w-full flex-col items-start px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }
                >
                  <span className="w-full truncate text-[length:var(--font-meta-size)]">{match.name}</span>
                  <span className="w-full truncate text-subtle text-[length:var(--font-micro-size)]">
                    {match.relativePath}
                  </span>
                </button>
              </li>
            ))}
            {search.data.truncated ? (
              <li className="px-2 py-1 text-subtle text-[length:var(--font-micro-size)]">
                结果已截断，请使用更具体的关键词。
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <ModalShell
        open={previewPath !== null}
        title={`预览 ${previewPath ?? '文件'}`}
        onClose={closePreview}
        beforeClose={canClosePreview}
        closeOnBackdrop={false}
        hideHeader
        bodyPadding="none"
        widthClassName="h-[min(86vh,760px)] w-[1100px]"
        testId="file-preview-modal"
      >
        {previewPath === null ? null : (
          <FilePreview
            key={JSON.stringify([workspacePathKey, previewPath])}
            client={client}
            projectId={projectId}
            relativePath={previewPath}
            workspacePath={workspacePathKey}
            writable={writable}
            onDirtyChange={reportPreviewDirty}
            onSavingChange={reportPreviewSaving}
            onClose={requestClosePreview}
          />
        )}
      </ModalShell>
      <ConfirmDialog
        open={confirmPreviewClose}
        title="离开文件预览"
        message={previewSaving
          ? `正在保存「${previewPath ?? '文件'}」，保存完成后再继续。`
          : `「${previewPath ?? '文件'}」有未保存的修改，继续后将丢弃这些修改。`}
        confirmLabel="放弃修改并继续"
        confirmDisabled={previewSaving}
        tone="destructive"
        onConfirm={() => {
          if (previewSavingRef.current) return;
          const proceed = previewTransitionRef.current;
          previewTransitionRef.current = null;
          setConfirmPreviewClose(false);
          proceed?.();
        }}
        onCancel={() => {
          previewTransitionRef.current = null;
          setConfirmPreviewClose(false);
          if (previewPath !== null) onOpenFile(previewPath);
        }}
        testId="file-preview-unsaved"
      />
    </div>
  );
}
