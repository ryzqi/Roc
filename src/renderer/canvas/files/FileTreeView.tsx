import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import type { FileEntry } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { ErrorBar } from '../../shell/ErrorBar';
import { EmptyState } from '../../shell/EmptyState';
import { pathRejectionMessage, type PathRejection } from '../../workspace/paths';
import {
  ancestorDirectoriesOf,
  clampRowIndex,
  findParentRowIndex,
  findTypeAheadRowIndex,
  useFileTree,
  type FileTreeRow
} from '../../workspace/use-file-tree';

/**
 * File tree for the sidebar's 文件 tab (P3/T3.2).
 *
 * `files.listTree` is one directory per call, so this is a lazy tree: expanding a
 * directory fetches it once. Expansion is persisted per project.
 *
 * **Windowing.** Beyond `VIRTUALISE_THRESHOLD` rows the list renders only the
 * visible slice (plus overscan) with spacer elements preserving scroll height.
 * Rows are a fixed 24px so the arithmetic is exact; the plan asks for
 * virtualisation past 200 rows and large repositories hit that immediately. The
 * focused row is always inside the slice, otherwise roving focus would point at
 * an element that is not rendered.
 *
 * **Keyboard model** (AGENTS.md "every important action must be keyboard
 * accessible"). This is the ARIA tree pattern with a roving `tabIndex`:
 * exactly one row is tabbable, ↑/↓ move, → expands or steps into a directory, ←
 * collapses or steps out to the parent, Home/End jump, and typing jumps to the
 * next row whose name starts with the typed prefix. Enter/Space are left to the
 * row button's native activation, so a keystroke cannot fire the action twice.
 *
 * Interaction rules: rows are 24px inside a 36-40px target
 * band, selection uses `--accent-soft`, hover uses `--overlay-hover`, there is no
 * `cursor: pointer`, and a directory row's disclosure is a real button.
 */

const ROW_HEIGHT = 24;
const OVERSCAN = 8;
const VIRTUALISE_THRESHOLD = 200;
/** Typing this long after the previous character starts a new search prefix. */
const TYPE_AHEAD_RESET_MS = 700;

export type FileTreeViewProps = {
  client: RocClient;
  /** Cache key: changes when the bound workspace changes. */
  workspacePathKey: string | null;
  projectId: string | null;
  /** Workspace-relative path of the file currently open in the preview. */
  selectedPath: string | null;
  onOpenFile: (relativePath: string) => void;
  /**
   * A path the sidebar wants revealed (expanded + focused) — used after opening a
   * search result, so the tree continues where the search left off.
   */
  revealPath?: string | null;
  /**
   * A path that is not inside the workspace, refused before any request is made (R10).
   *
   * The tree is where selection lives now, so it is also where an impossible selection is
   * reported; the canvas `files` view used to own both.
   */
  rejectedPath?: { relativePath: string; reason: PathRejection } | null;
};

const KIND_ICON = { file: FileText, directory: Folder } as const;

const CODE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.r',
  '.jl',
  '.ipynb',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.sh',
  '.css',
  '.html',
  '.sql',
  '.c',
  '.h',
  '.cpp',
  '.rs',
  '.go'
] as const;

/**
 * Per-row icon hue (`getFileIcon`):
 * folders and LaTeX sources share amber, source code is blue, the `.bib` family is
 * the literature hue, and everything else stays grey. The hues are tokens, so the
 * light theme drops to a legible stop instead of the dark theme's 400s.
 *
 * Directory rows use the same amber in both disclosure states; the glyph is what
 * carries "open" (see `RowIcon`).
 */
function iconClassFor(row: FileTreeRow): string {
  if (row.entry.type === 'directory') {
    return 'text-[var(--icon-file)]';
  }
  const name = row.entry.name.toLowerCase();
  if (name.endsWith('.tex') || name.endsWith('.cls') || name.endsWith('.sty') || name.endsWith('.ltx')) {
    return 'text-[var(--icon-latex)]';
  }
  if (name.endsWith('.bib')) {
    return 'text-[var(--icon-literature)]';
  }
  if (CODE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'text-[var(--icon-code)]';
  }
  return 'text-subtle';
}

function RowIcon({ row, busy }: { row: FileTreeRow; busy: boolean }): React.JSX.Element {
  if (busy) {
    return <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-muted" />;
  }
  if (row.entry.type === 'directory') {
    return row.expanded ? (
      <FolderOpen size={12} aria-hidden="true" className={`shrink-0 ${iconClassFor(row)}`} />
    ) : (
      <Folder size={12} aria-hidden="true" className={`shrink-0 ${iconClassFor(row)}`} />
    );
  }
  const Icon = KIND_ICON.file;
  return <Icon size={12} aria-hidden="true" className={`shrink-0 ${iconClassFor(row)}`} />;
}

export function FileTreeView({
  client,
  workspacePathKey,
  projectId,
  selectedPath,
  onOpenFile,
  revealPath = null,
  rejectedPath = null
}: FileTreeViewProps): React.JSX.Element {
  const tree = useFileTree(client, { workspacePathKey, projectId });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);
  /** The roving-focus anchor: the one row that is tabbable. */
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const typeAhead = useRef({ prefix: '', at: 0 });

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

  /**
   * The focus anchor is clamped **at render time** (the F13 lesson): a collapse or
   * a reload can remove the focused row, and every row would then be
   * `tabIndex={-1}` — the whole tree unreachable by keyboard with no visible sign.
   */
  const activePath = useMemo(() => {
    if (focusedPath !== null && tree.rows.some((row) => row.entry.relativePath === focusedPath)) {
      return focusedPath;
    }
    return tree.rows[0]?.entry.relativePath ?? null;
  }, [focusedPath, tree.rows]);

  const activeIndex = tree.rows.findIndex((row) => row.entry.relativePath === activePath);

  const virtualise = tree.rows.length > VIRTUALISE_THRESHOLD;
  const windowStart = virtualise ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const windowEnd = virtualise
    ? Math.min(tree.rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
    : tree.rows.length;
  const startIndex = virtualise && activeIndex >= 0 ? Math.min(windowStart, activeIndex) : windowStart;
  const endIndex = virtualise && activeIndex >= 0 ? Math.max(windowEnd, activeIndex + 1) : windowEnd;
  const visible = tree.rows.slice(startIndex, endIndex);

  useEffect(() => {
    if (pendingFocusPath === null) {
      return;
    }
    const element = rowRefs.current.get(pendingFocusPath);
    if (element === undefined) {
      // The row can be missing for two very different reasons: its listing is
      // still in flight (wait — a reveal of a deep path needs it), or it is
      // genuinely gone (a collapse or a reload). Give up only in the second case.
      if (tree.loading.size === 0 && !tree.rows.some((row) => row.entry.relativePath === pendingFocusPath)) {
        setPendingFocusPath(null);
      }
      return;
    }
    element.scrollIntoView({ block: 'nearest' });
    element.focus();
    setPendingFocusPath(null);
  }, [pendingFocusPath, tree.loading, tree.rows]);

  const moveFocusTo = useCallback((index: number): void => {
    const row = tree.rows[index];
    if (row === undefined) {
      return;
    }
    setFocusedPath(row.entry.relativePath);
    setPendingFocusPath(row.entry.relativePath);
  }, [tree.rows]);

  /**
   * Reveal request from the sidebar's search results (T3.4): expand every ancestor,
   * then focus the row so the keyboard continues where the click left off.
   *
   * Add-only expansion: the ancestors of a search hit are usually *already*
   * expanded, and toggling them would collapse them (and persist the emptier set).
   * Loading is not triggered here — `useFileTree` fetches every expanded directory
   * that has no cached listing, which is the same path that restores a reopened
   * project's expansion. This effect is guarded by the last handled value because
   * `tree` changes identity on every listing; without the guard it would steal
   * focus on unrelated renders.
   */
  const handledReveal = useRef<string | null>(null);
  useEffect(() => {
    if (revealPath === null || handledReveal.current === revealPath) {
      return;
    }
    handledReveal.current = revealPath;
    tree.expandDirectories(ancestorDirectoriesOf(revealPath));
    setFocusedPath(revealPath);
    setPendingFocusPath(revealPath);
  }, [revealPath, tree]);

  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (tree.rows.length === 0) {
        return;
      }
      const index = Math.max(activeIndex, 0);
      const row = tree.rows[index];
      if (row === undefined) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocusTo(clampRowIndex(tree.rows.length, index + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocusTo(clampRowIndex(tree.rows.length, index - 1));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        moveFocusTo(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        moveFocusTo(tree.rows.length - 1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (row.entry.type !== 'directory') {
          return;
        }
        if (!row.expanded) {
          // Expand in place; loading is handled by the tree hook.
          tree.toggleDirectory(row.entry.relativePath);
          return;
        }
        moveFocusTo(clampRowIndex(tree.rows.length, index + 1));
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (row.entry.type === 'directory' && row.expanded) {
          tree.toggleDirectory(row.entry.relativePath);
          return;
        }
        const parent = findParentRowIndex(tree.rows, index);
        if (parent !== null) {
          moveFocusTo(parent);
        }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        // Deliberately not handled: the row is a real <button>, so the browser
        // activates it once. Handling it here as well would toggle twice.
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.length !== 1) {
        return;
      }

      const now = Date.now();
      const state = typeAhead.current;
      const prefix = now - state.at > TYPE_AHEAD_RESET_MS ? event.key : state.prefix + event.key;
      typeAhead.current = { prefix, at: now };
      event.preventDefault();
      const matched =
        findTypeAheadRowIndex(tree.rows, index + 1, prefix) ??
        (prefix.length > 1 ? findTypeAheadRowIndex(tree.rows, index + 1, event.key) : null);
      if (matched !== null) {
        moveFocusTo(matched);
      }
    },
    [activeIndex, moveFocusTo, tree]
  );

  if (workspacePathKey === null) {
    return <EmptyState compact title="未选择工作区" description="绑定工作目录后才会显示文件树。" testId="file-tree-no-workspace" />;
  }

  /**
   * A path that cannot be inside the workspace, refused before any request is made (R10).
   *
   * This used to be the canvas `files` view's job — it was the `?file=` host, and a rejected path
   * rendered `data-state="rejected"` there. The view is gone — files are revealed in the tree —
   * so the same `checkRelativePath` + `pathRejectionMessage` pair moved to the surface that
   * now owns selection. The backend refuses it too; failing locally is about the message, not about
   * being the only boundary.
   */
  if (rejectedPath !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="file-tree-rejected">
        <ErrorBar
          error={{
            level: 'blocked',
            message: pathRejectionMessage(rejectedPath.reason),
            code: 'renderer_path_rejected',
            actionLabel: `被拒绝的路径：${rejectedPath.relativePath}`
          }}
        />
        <p className="text-muted text-[var(--font-meta-size)]">文件路径必须位于工作目录之内。</p>
      </div>
    );
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
        onKeyDown={onTreeKeyDown}
        role="tree"
        aria-label="文件树"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {virtualise && startIndex > 0 ? (
          <div aria-hidden="true" style={{ height: startIndex * ROW_HEIGHT }} />
        ) : null}

        {visible.map((row) => (
          <TreeRow
            key={row.entry.relativePath}
            row={row}
            busy={tree.loading.has(row.entry.relativePath)}
            selected={row.entry.relativePath === selectedPath}
            tabbable={row.entry.relativePath === activePath}
            error={tree.errors.get(row.entry.relativePath)}
            registerRef={(relativePath, element) => {
              if (element === null) {
                rowRefs.current.delete(relativePath);
                return;
              }
              rowRefs.current.set(relativePath, element);
            }}
            onActivate={() => {
              if (row.entry.type === 'directory') {
                tree.toggleDirectory(row.entry.relativePath);
                return;
              }
              onOpenFile(row.entry.relativePath);
            }}
            onFocused={() => {
              // Keeps the roving anchor in sync when focus arrives from elsewhere
              // (a click, or Tab back into the tree).
              setFocusedPath(row.entry.relativePath);
            }}
          />
        ))}

        {virtualise && endIndex < tree.rows.length ? (
          <div aria-hidden="true" style={{ height: (tree.rows.length - endIndex) * ROW_HEIGHT }} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * One row. Extracted so the tree component above stays about tree behaviour
 * (windowing, focus, keys) rather than row chrome, and so the ref callback and the
 * directory `aria-expanded` wiring have a single home.
 */
function TreeRow({
  row,
  busy,
  selected,
  tabbable,
  error,
  registerRef,
  onActivate,
  onFocused
}: {
  row: FileTreeRow;
  busy: boolean;
  selected: boolean;
  tabbable: boolean;
  error: string | undefined;
  registerRef: (relativePath: string, element: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onFocused: () => void;
}): React.JSX.Element {
  const directory = row.entry.type === 'directory';
  return (
    <div>
      <button
        type="button"
        ref={(element) => registerRef(row.entry.relativePath, element)}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={directory ? row.expanded : undefined}
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        data-testid={`file-tree-row-${row.entry.relativePath}`}
        onClick={onActivate}
        onFocus={onFocused}
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
      {error === undefined ? null : (
        <p
          role="alert"
          className="px-3 py-0.5 text-[var(--st-bad)] text-[var(--font-micro-size)]"
          style={{ paddingLeft: 18 + row.depth * 12 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export type { FileEntry };
