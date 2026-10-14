import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import type { FileEntry } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { ErrorBar } from '../../shell/ErrorBar';
import { EmptyState } from '../../shell/EmptyState';
import { useFileTree, type FileTreeRow } from '../../workspace/use-file-tree';

/**
 * File tree for the sidebar's 文件 tab (P3/T3.2).
 *
 * `files.listTree` is one directory per call, so this is a lazy tree: expanding a
 * directory fetches it once. Expansion is persisted per project.
 *
 * **Windowing.** Beyond `VIRTUALISE_THRESHOLD` rows the list renders only the
 * visible slice (plus overscan) with spacer elements preserving scroll height.
 * Rows are a fixed 24px so the arithmetic is exact; the plan asks for
 * virtualisation past 200 rows and large repositories hit that immediately.
 *
 * Interaction rules from MASTER v2 §6.4: rows are 24px inside a 36-40px target
 * band, selection uses `--accent-soft`, hover uses `--overlay-hover`, there is no
 * `cursor: pointer`, and a directory row's disclosure is a real button.
 */

const ROW_HEIGHT = 24;
const OVERSCAN = 8;
const VIRTUALISE_THRESHOLD = 200;

export type FileTreeViewProps = {
  client: RocClient;
  /** Cache key: changes when the bound workspace changes. */
  workspacePathKey: string | null;
  projectId: string | null;
  /** Workspace-relative path of the file currently open in the preview. */
  selectedPath: string | null;
  onOpenFile: (relativePath: string) => void;
};

const KIND_ICON = { file: FileText, directory: Folder } as const;

function RowIcon({ row, busy }: { row: FileTreeRow; busy: boolean }): React.JSX.Element {
  if (busy) {
    return <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-muted" />;
  }
  if (row.entry.type === 'directory') {
    return row.expanded ? (
      <FolderOpen size={12} aria-hidden="true" className="shrink-0 text-accent" />
    ) : (
      <Folder size={12} aria-hidden="true" className="shrink-0 text-subtle" />
    );
  }
  const Icon = KIND_ICON.file;
  return <Icon size={12} aria-hidden="true" className="shrink-0 text-subtle" />;
}

export function FileTreeView({
  client,
  workspacePathKey,
  projectId,
  selectedPath,
  onOpenFile
}: FileTreeViewProps): React.JSX.Element {
  const tree = useFileTree(client, { workspacePathKey, projectId });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [workspacePathKey]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  if (workspacePathKey === null) {
    return <EmptyState compact title="未选择工作区" description="绑定工作目录后才会显示文件树。" testId="file-tree-no-workspace" />;
  }

  if (tree.rootError !== null) {
    return (
      <div className="p-2">
        <ErrorBar
          error={{ level: 'page', message: tree.rootError, retry: tree.reload, actionLabel: '读取工作目录失败' }}
        />
      </div>
    );
  }

  if (tree.loadingRoot && tree.rows.length === 0) {
    return (
      <p className="flex items-center gap-2 px-3 py-4 text-muted" role="status" data-testid="file-tree-loading">
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        正在读取文件树…
      </p>
    );
  }

  if (tree.rows.length === 0) {
    return <EmptyState compact icon={Folder} title="目录为空" description="该工作目录下没有文件。" testId="file-tree-empty" />;
  }

  const virtualise = tree.rows.length > VIRTUALISE_THRESHOLD;
  const startIndex = virtualise ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const endIndex = virtualise
    ? Math.min(tree.rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
    : tree.rows.length;
  const visible = tree.rows.slice(startIndex, endIndex);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-tree">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-subtle text-[var(--font-micro-size)]">
          {tree.rows.length} 项
          {tree.truncatedRoot ? ' · 已截断' : ''}
        </span>
        <button
          type="button"
          onClick={tree.collapseAll}
          className="rounded-control px-1.5 py-0.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          data-testid="file-tree-collapse-all"
        >
          <span className="text-[var(--font-micro-size)]">折叠</span>
        </button>
        <button
          type="button"
          onClick={tree.reload}
          aria-label="刷新文件树"
          data-testid="file-tree-refresh"
          className="rounded-control p-1 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <RefreshCw size={11} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="tree"
        aria-label="文件树"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {virtualise && startIndex > 0 ? (
          <div aria-hidden="true" style={{ height: startIndex * ROW_HEIGHT }} />
        ) : null}

        {visible.map((row) => {
          const busy = tree.loading.has(row.entry.relativePath);
          const selected = row.entry.relativePath === selectedPath;
          const directory = row.entry.type === 'directory';
          const directoryError = tree.errors.get(row.entry.relativePath);
          return (
            <div key={row.entry.relativePath}>
              <button
                type="button"
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={directory ? row.expanded : undefined}
                aria-selected={selected}
                data-testid={`file-tree-row-${row.entry.relativePath}`}
                onClick={() => {
                  if (directory) {
                    tree.toggleDirectory(row.entry.relativePath);
                    return;
                  }
                  onOpenFile(row.entry.relativePath);
                }}
                className={
                  selected
                    ? 'flex h-[24px] w-full items-center gap-1 bg-accent-soft pr-2 text-left'
                    : 'flex h-[24px] w-full items-center gap-1 pr-2 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                }
                style={{ paddingLeft: 6 + row.depth * 12 }}
                title={row.entry.relativePath}
              >
                {directory ? (
                  row.expanded ? (
                    <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-subtle" />
                  ) : (
                    <ChevronRight size={11} aria-hidden="true" className="shrink-0 text-subtle" />
                  )
                ) : (
                  <span className="w-[11px] shrink-0" aria-hidden="true" />
                )}
                <RowIcon row={row} busy={busy} />
                <span className="min-w-0 flex-1 truncate text-[var(--font-meta-size)]">{row.entry.name}</span>
              </button>
              {directoryError === undefined ? null : (
                <p role="alert" className="px-3 py-0.5 text-[var(--st-bad)] text-[var(--font-micro-size)]" style={{ paddingLeft: 18 + row.depth * 12 }}>
                  {directoryError}
                </p>
              )}
            </div>
          );
        })}

        {virtualise && endIndex < tree.rows.length ? (
          <div aria-hidden="true" style={{ height: (tree.rows.length - endIndex) * ROW_HEIGHT }} />
        ) : null}
      </div>
    </div>
  );
}

export type { FileEntry };
