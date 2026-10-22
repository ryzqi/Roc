import { useRef } from 'react';
import { BookOpen, FolderGit2, FolderTree, Loader2, MessagesSquare, Moon, RotateCcw, Sliders, Sun, SunMoon } from 'lucide-react';
import type { SidebarTab } from '../app/ui-state';
import { SessionListView } from '../assistant/SessionListView';
import { FileSidebarPanel } from '../canvas/files/FileSidebarPanel';
import { LibraryList } from '../literature/LibraryList';
import { useLiterature } from '../literature/literature-scope';
import type { RocClient } from '../shared/roc-client';
import type { BoundWorkspace } from '../workspace/use-bound-workspace';
import { EmptyState } from './EmptyState';

/**
 * Left rail: project context for the three highest-frequency lookups.
 *
 * The tab set is fixed at three (files / literature / sessions) and every tab is
 * a subordinate view of the *current project* — this is not global app
 * navigation. The tab set is a product decision, not a local one.
 *
 * Interaction rules: rows are 36-40px with `--r-card` radius, hover uses a
 * subtle fill, the selected tab is a raised surface, and nothing gets
 * `cursor: pointer`.
 *
 * ## Four bands
 *
 *   1. **project banner** — folder glyph + slug + 「切换课题」, on `--surface/90`.
 *      It answers "which project am I in" and "how do I leave" in one strip, which
 *      is the question a three-column workbench has to answer above the fold.
 *   2. **segmented tabs** — a recessed track (`bg-bg/90`, 1px border) holding
 *      three equal buttons, the selected one raised (`--surface-card-hover` +
 *      `--shadow-card`). The tab strip is a *control*, so its selected state is an
 *      inset track and a raised chip rather than an accent wash the way a list
 *      row would be.
 *   3. **panel** — unchanged, each tab's own body.
 *   4. **bottom bar** — the theme control as one full-width button, plus the
 *      management entry the chrome also offers.
 *
 * Colours use the token layer only; the four icon hues come from `--icon-*`, so
 * category colour never becomes a literal hex.
 *
 * The theme control is labelled by its **action** (「深色」 while the app is
 * light), matching the "name controls by user action" rule. The current state lives in the `title`, so the label never has to be
 * read as an ambiguous toggle.
 *
 * P1 rendered empty states only; P3 fills 文件 (real tree + name search + new
 * file), P5 fills 文献, P4 fills 会话.
 */

export type LeftSidebarProps = {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  client: RocClient;
  projectId: string | null;
  projectName: string;
  /** Backend binding state for the project's configured directory (T3.1). */
  binding: BoundWorkspace;
  /** A file the shell asked the 文件 tab to reveal **and preview** (see `SidebarFilesTab`). */
  previewRequest?: { relativePath: string; nonce: number } | null;
  /**
   * Clears the request once the 文件 tab has adopted it.
   *
   * A request that is only *remembered* by its consumer is re-delivered when that consumer
   * remounts — and this panel is deliberately remounted on a workspace change (see
   * `FileSidebarPanel`'s adopt effect for the failure that caused).
   */
  onPreviewRequestConsumed?: () => void;
  /** Archived projects are read-only: no file creation, no writes. */
  writable: boolean;
  /** Workspace-relative path of the file open in the canvas, if any. */
  openFile: string | null;
  onOpenFile: (relativePath: string) => void;
  /** Selected assistant conversation (owned by the shell). */
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onStartNewThread: () => void;
  onThreadDeleted: (threadId: string) => void;
  onSelectWorkspace: () => void;
  workspacePending: boolean;
  /** Directory-picker or project-update failure, with the backend's own message. */
  workspaceError: string | null;
  onBackToPortal: () => void;
  /**
   * Brings the canvas to the literature hub (P5). `null` item id means "just show
   * the hub" — used by the tab's own 导入 button, which must land where the dialog
   * lives.
   */
  onOpenLiterature: (libraryItemId: string | null) => void;
  themeOverride: 'system' | 'light' | 'dark';
  onCycleTheme: () => void;
  onOpenManagement: () => void;
};

const TABS: Array<{ id: SidebarTab; label: string; icon: typeof FolderTree; iconClass: string }> = [
  { id: 'files', label: '文件', icon: FolderTree, iconClass: 'text-[var(--icon-file)]' },
  { id: 'literature', label: '文献', icon: BookOpen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'sessions', label: '会话', icon: MessagesSquare, iconClass: 'text-muted' }
];

/**
 * The 文献 tab (P5/T5.1).
 *
 * Reads the **shared** literature store — the same instance the canvas hub uses —
 * so a row selected here is the row the reader shows, and an import performed in
 * the hub is visible here without a refresh convention. The import button asks the
 * store to open the dialog and hands navigation to the shell, because the dialog
 * renders in the hub (a 256px column has no room for a five-tab form).
 */
function SidebarLiteratureTab({
  onOpenLiterature
}: {
  onOpenLiterature: (libraryItemId: string | null) => void;
}): React.JSX.Element {
  const literature = useLiterature();
  return (
    <LibraryList
      compact
      onOpenItem={(id) => onOpenLiterature(id)}
      onRequestImport={() => {
        literature.requestImport();
        onOpenLiterature(null);
      }}
    />
  );
}

/**
 * The theme control, labelled by what pressing it *does*.
 *
 * `system` is not "follow the system, and also the system is light" — it is its own
 * state, so it keeps its own label and icon. The other two name their destination.
 */
function themeAction(override: 'system' | 'light' | 'dark'): {
  icon: React.JSX.Element;
  label: string;
  iconClass: string;
} {
  if (override === 'light') {
    return {
      icon: <Moon size={12} aria-hidden="true" />,
      label: '深色',
      iconClass: 'text-[var(--icon-theme-moon)]'
    };
  }
  if (override === 'dark') {
    return {
      icon: <Sun size={12} aria-hidden="true" />,
      label: '浅色',
      iconClass: 'text-[var(--icon-theme-sun)]'
    };
  }
  return {
    icon: <SunMoon size={12} aria-hidden="true" />,
    label: '跟随系统',
    iconClass: 'text-muted'
  };
}

function themeState(override: 'system' | 'light' | 'dark'): string {
  if (override === 'light') {
    return '浅色';
  }
  if (override === 'dark') {
    return '深色';
  }
  return '跟随系统';
}

/**
 * The 文件 tab.
 *
 * The three states are genuinely different and must not be collapsed:
 *
 *   - **no configured directory** → offer the picker (P2's T2.5 action)
 *   - **binding** → say so; rendering the tree now would look like an empty
 *     directory, and rendering "未选择工作区" would contradict the project
 *   - **bind failed** → name the failure and offer both retry and a new picker
 *
 * Only the last state mounts `FileSidebarPanel`, and it is keyed on the *bound*
 * path, so switching projects remounts the tree, the search and the new-file form
 * with fresh state (gate 6).
 */
function SidebarFilesTab({
  client,
  projectId,
  binding,
  writable,
  openFile,
  onOpenFile,
  onSelectWorkspace,
  workspacePending,
  workspaceError,
  previewRequest,
  onPreviewRequestConsumed
}: {
  client: RocClient;
  projectId: string | null;
  binding: BoundWorkspace;
  writable: boolean;
  openFile: string | null;
  onOpenFile: (relativePath: string) => void;
  onSelectWorkspace: () => void;
  workspacePending: boolean;
  workspaceError: string | null;
  /**
   * A file another surface asked to preview (the RAG hit's 「打开来源文件」).
   *
   * The preview overlay is view state and lives in `FileSidebarPanel`, which is also where
   * the tree is — so a nonce is the only thing that has to travel. The nonce is compared
   * against the last one seen, so asking for the *same* file twice still opens it, and a
   * re-render never re-opens a preview the user just closed.
   *
   * `onPreviewRequestConsumed` is what makes the request one-shot: the panel is keyed on the bound
   * path, so a project switch remounts it and a merely-remembered request would be re-delivered.
   */
  previewRequest: { relativePath: string; nonce: number } | null;
  onPreviewRequestConsumed?: () => void;
}): React.JSX.Element {
  if (binding.desiredPath === null) {
    return (
      <>
        <EmptyState
          compact
          icon={FolderTree}
          title="未选择工作区"
          action={{ label: '选择目录', onClick: onSelectWorkspace, disabled: workspacePending }}
          testId="sidebar-files-no-workspace"
        />
        {workspaceError === null ? null : (
          <p
            role="alert"
            className="px-3 pb-2 text-[var(--st-bad)] text-[var(--font-micro-size)]"
            data-testid="sidebar-files-workspace-error"
          >
            {workspaceError}
          </p>
        )}
      </>
    );
  }

  if (binding.status === 'binding') {
    return (
      <p className="flex items-center gap-2 px-3 py-4 text-muted" role="status" data-testid="sidebar-files-binding">
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        正在绑定工作目录…
      </p>
    );
  }

  if (binding.status === 'error' || binding.path === null) {
    return (
      <>
        <EmptyState
          compact
          icon={FolderTree}
          title="工作目录无法绑定"
          action={{ label: '重试', onClick: binding.rebind }}
          testId="sidebar-files-bind-error"
        />
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={onSelectWorkspace}
            disabled={workspacePending}
            data-testid="sidebar-files-reselect"
            className="h-[var(--control-height-compact)] rounded-control border border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
          >
            <span className="flex items-center gap-1 text-[var(--font-meta-size)]">
              <RotateCcw size={11} aria-hidden="true" />
              选择其它目录
            </span>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <FileSidebarPanel
        key={binding.path}
        client={client}
        workspacePathKey={binding.path}
        projectId={projectId}
        writable={writable}
        openFile={openFile}
        onOpenFile={onOpenFile}
        previewRequest={previewRequest}
        onPreviewRequestConsumed={onPreviewRequestConsumed}
      />
      {workspaceError === null ? null : (
        <p
          role="alert"
          className="px-3 pb-2 text-[var(--st-bad)] text-[var(--font-micro-size)]"
          data-testid="sidebar-files-workspace-error"
        >
          {workspaceError}
        </p>
      )}
    </>
  );
}

export function LeftSidebar({
  activeTab,
  onTabChange,
  client,
  projectId,
  projectName,
  binding,
  previewRequest = null,
  onPreviewRequestConsumed,
  writable,
  openFile,
  onOpenFile,
  activeThreadId,
  onSelectThread,
  onStartNewThread,
  onThreadDeleted,
  onSelectWorkspace,
  workspacePending,
  workspaceError,
  onBackToPortal,
  onOpenLiterature,
  themeOverride,
  onCycleTheme,
  onOpenManagement
}: LeftSidebarProps): React.JSX.Element {
  const tabRefs = useRef(new Map<SidebarTab, HTMLButtonElement>());

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const lastIndex = TABS.length - 1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? lastIndex
          : event.key === 'ArrowLeft'
            ? (index + lastIndex) % TABS.length
            : (index + 1) % TABS.length;
    const nextTab = TABS[nextIndex]!.id;
    onTabChange(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  };

  const theme = themeAction(themeOverride);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-text" data-testid="sidebar">
      {/* Band 1 — current project, and the way out of it. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface/90 px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-text">
          <FolderGit2 size={12} aria-hidden="true" className="shrink-0 text-muted" />
          <span
            className="truncate font-medium text-[var(--font-micro-size)]"
            title={projectName}
            data-testid="sidebar-project-name"
          >
            {projectName}
          </span>
        </span>
        <button
          type="button"
          onClick={onBackToPortal}
          title="返回研究项目门户"
          className="shrink-0 rounded-control px-1 py-0.5 text-muted text-[var(--font-micro-size)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--overlay-hover)] hover:text-ink"
        >
          切换课题
        </button>
      </div>

      {/* Band 2 — the segmented tab track. */}
      <div className="shrink-0 border-b border-line bg-surface/60 p-2">
        <div
          role="tablist"
          aria-label="项目上下文"
          className="flex items-center gap-1 rounded-control border border-line bg-bg/90 p-0.5"
        >
          {TABS.map((tab, index) => {
            const selected = tab.id === activeTab;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                ref={(element) => {
                  if (element === null) {
                    tabRefs.current.delete(tab.id);
                    return;
                  }
                  tabRefs.current.set(tab.id, element);
                }}
                role="tab"
                id={`sidebar-tab-${tab.id}`}
                aria-selected={selected}
                // Only the rendered panel can be pointed at; the inactive panels
                // do not exist, so an unconditional `aria-controls` would be a
                // dangling reference for two of the three tabs.
                aria-controls={selected ? `sidebar-panel-${tab.id}` : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                data-testid={`sidebar-tab-${tab.id}`}
                className={
                  selected
                    ? 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-chip bg-[var(--surface-card-hover)] font-semibold text-ink shadow-[var(--shadow-card)] transition-colors duration-[var(--duration-fast)]'
                    : 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-chip text-muted transition-colors duration-[var(--duration-fast)] hover:text-ink active:bg-[var(--overlay-active)]'
                }
              >
                <Icon size={12} aria-hidden="true" className={tab.iconClass} />
                <span className="text-[var(--font-meta-size)]">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Band 3 — the selected tab's body. */}
      <div
        role="tabpanel"
        id={`sidebar-panel-${activeTab}`}
        aria-labelledby={`sidebar-tab-${activeTab}`}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid={`sidebar-panel-${activeTab}`}
      >
        {activeTab === 'files' ? (
          <SidebarFilesTab
            client={client}
            projectId={projectId}
            binding={binding}
            writable={writable}
            openFile={openFile}
            onOpenFile={onOpenFile}
            onSelectWorkspace={onSelectWorkspace}
            workspacePending={workspacePending}
            workspaceError={workspaceError}
            previewRequest={previewRequest}
            onPreviewRequestConsumed={onPreviewRequestConsumed}
          />
        ) : activeTab === 'sessions' ? (
          <SessionListView
            client={client}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            onStartNewThread={onStartNewThread}
            onThreadDeleted={onThreadDeleted}
          />
        ) : (
          <SidebarLiteratureTab onOpenLiterature={onOpenLiterature} />
        )}
      </div>

      {/* Band 4 — theme + management. */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line bg-surface/50 p-2">
        <button
          type="button"
          onClick={onCycleTheme}
          title={`切换为${theme.label}（⌘D）· 当前 ${themeState(themeOverride)}`}
          aria-label={`切换为${theme.label}，当前 ${themeState(themeOverride)}`}
          data-testid="sidebar-theme-toggle"
          className="flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-2 rounded-control border border-line bg-surface font-medium text-text text-[var(--font-meta-size)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-card-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <span className={theme.iconClass}>{theme.icon}</span>
          <span className="truncate">{theme.label}</span>
        </button>
        <button
          type="button"
          onClick={onOpenManagement}
          title="管理（记忆 / 技能 / MCP / 任务）"
          aria-label="打开管理面板"
          data-testid="sidebar-management"
          className="flex h-[var(--control-height-compact)] items-center gap-1.5 rounded-control border border-line bg-surface px-2 text-muted transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-card-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <Sliders size={13} aria-hidden="true" className="text-[var(--icon-manage)]" />
        </button>
      </div>
    </div>
  );
}
