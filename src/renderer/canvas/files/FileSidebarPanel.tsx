import { useState } from 'react';
import { FilePlus2, Loader2, Search, X } from 'lucide-react';
import type { RocClient } from '../../shared/roc-client';
import { joinRelative, parentRelative, checkRelativePath, pathRejectionMessage } from '../../workspace/paths';
import { useFileNameSearch } from '../../workspace/use-file-search';
import { writeTextFile } from '../../workspace/workspace-store';
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
};

export function FileSidebarPanel({
  client,
  workspacePathKey,
  projectId,
  writable,
  openFile,
  onOpenFile
}: FileSidebarPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingPending, setCreatingPending] = useState(false);
  /** Set when a search result is opened, so the tree can reveal it (T3.4). */
  const [revealPath, setRevealPath] = useState<string | null>(null);

  const search = useFileNameSearch(client, workspacePathKey, query);
  const searching = query.trim().length > 0;

  const openFromSearch = (relativePath: string): void => {
    // Clear the query first so the tree is what the reveal lands in.
    setQuery('');
    setRevealPath(relativePath);
    onOpenFile(relativePath);
  };

  const targetDirectory = openFile === null ? '' : parentRelative(openFile);

  const submitNewFile = async (): Promise<void> => {
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
    setCreatingPending(true);
    setCreateError(null);
    const result = await writeTextFile(client, {
      relativePath,
      content: '',
      source: NEW_FILE_WRITE_SOURCE
    });
    setCreatingPending(false);
    if (!result.ok) {
      setCreateError(result.error.message);
      return;
    }
    setCreating(false);
    setDraftName('');
    onOpenFile(relativePath);
  };

  const createForm = writable && creating ? (
    <form
      className="flex shrink-0 flex-col gap-1 border-b border-line-soft px-2 pb-2"
      data-testid="file-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submitNewFile();
      }}
    >
      <div className="flex items-center gap-1">
        <input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          autoFocus
          placeholder="新文件名，例如 notes.md"
          aria-label="新文件名"
          data-testid="file-create-name"
          className="h-[var(--control-height-compact)] min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-ink placeholder:text-subtle"
        />
        <button
          type="submit"
          disabled={creatingPending || draftName.trim().length === 0}
          data-testid="file-create-submit"
          className="h-[var(--control-height-compact)] shrink-0 rounded-control bg-[var(--fill-strong)] px-2 text-[var(--fill-strong-text)] disabled:opacity-40"
        >
          {creatingPending ? '创建中…' : '创建'}
        </button>
        <button
          type="button"
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
      <p className="text-subtle text-[var(--font-micro-size)]">
        创建于 {targetDirectory.length === 0 ? '工作目录根' : `${targetDirectory}/`}
      </p>
      {createError === null ? null : (
        <p role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="file-create-error">
          {createError}
        </p>
      )}
    </form>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-sidebar-panel">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div className="flex h-[var(--control-height-compact)] min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line bg-surface px-2">
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
            onOpenFile={onOpenFile}
            revealPath={revealPath}
          />
        ) : search.status === 'loading' ? (
          <p className="flex items-center gap-2 px-3 py-3 text-muted" role="status" data-testid="file-search-loading">
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            正在搜索文件名…
          </p>
        ) : search.status === 'error' ? (
          <p role="alert" className="px-3 py-3 text-[var(--st-bad)] text-[var(--font-meta-size)]" data-testid="file-search-error">
            {search.error ?? '搜索失败'}
          </p>
        ) : search.data === null || search.data.matches.length === 0 ? (
          <p className="px-3 py-3 text-muted text-[var(--font-meta-size)]" data-testid="file-search-empty">
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
                  <span className="w-full truncate text-[var(--font-meta-size)]">{match.name}</span>
                  <span className="w-full truncate text-subtle text-[var(--font-micro-size)]">
                    {match.relativePath}
                  </span>
                </button>
              </li>
            ))}
            {search.data.truncated ? (
              <li className="px-2 py-1 text-subtle text-[var(--font-micro-size)]">
                结果已截断，请使用更具体的关键词。
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
