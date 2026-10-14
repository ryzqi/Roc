import { useRef } from 'react';
import { ArrowLeft, BookOpen, FolderTree, Loader2, MessagesSquare, Moon, RotateCcw, Sliders, Sun, SunMoon } from 'lucide-react';
import type { SidebarTab } from '../app/ui-state';
import { FileSidebarPanel } from '../canvas/files/FileSidebarPanel';
import type { RocClient } from '../shared/roc-client';
import type { BoundWorkspace } from '../workspace/use-bound-workspace';
import { EmptyState } from './EmptyState';

/**
 * Left rail: project context for the three highest-frequency lookups.
 *
 * The tab set is fixed at three (files / literature / sessions) and every tab is
 * a subordinate view of the *current project* — this is not global app
 * navigation (MASTER v2 §1.5). New tabs require a MASTER amendment.
 *
 * Interaction rules: rows are 36-40px with `--r-card` radius, hover uses a
 * subtle fill, the selected tab uses `--accent-soft`, and nothing gets
 * `cursor: pointer` (MASTER v2 §6.2).
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
  /** Archived projects are read-only: no file creation, no writes. */
  writable: boolean;
  /** Workspace-relative path of the file open in the canvas, if any. */
  openFile: string | null;
  onOpenFile: (relativePath: string) => void;
  onSelectWorkspace: () => void;
  workspacePending: boolean;
  /** Directory-picker or project-update failure, with the backend's own message. */
  workspaceError: string | null;
  onBackToPortal: () => void;
  themeOverride: 'system' | 'light' | 'dark';
  onCycleTheme: () => void;
  onOpenManagement: () => void;
};

const TABS: Array<{ id: SidebarTab; label: string; icon: typeof FolderTree }> = [
  { id: 'files', label: '文件', icon: FolderTree },
  { id: 'literature', label: '文献', icon: BookOpen },
  { id: 'sessions', label: '会话', icon: MessagesSquare }
];

/** Hints for the two tabs P4/P5 have not filled yet. */
const PLACEHOLDER_HINTS: Record<'literature' | 'sessions', { title: string; description: string; phase: string }> = {
  literature: {
    title: '尚无文献',
    description: '导入 PDF 或 BibTeX 后，文献会出现在这里。',
    phase: 'P5 实现'
  },
  sessions: {
    title: '暂无会话',
    description: '在助手面板发送第一条指令时会自动建立会话。',
    phase: 'P4 实现'
  }
};

function themeIcon(override: 'system' | 'light' | 'dark'): React.JSX.Element {
  if (override === 'light') {
    return <Sun size={13} aria-hidden="true" />;
  }
  if (override === 'dark') {
    return <Moon size={13} aria-hidden="true" />;
  }
  return <SunMoon size={13} aria-hidden="true" />;
}

function themeLabel(override: 'system' | 'light' | 'dark'): string {
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
  workspaceError
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
}): React.JSX.Element {
  if (binding.desiredPath === null) {
    return (
      <>
        <EmptyState
          compact
          icon={FolderTree}
          title="未选择工作区"
          description="打开文件与代码前必须先绑定工作目录。"
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
          description={binding.error ?? workspaceError ?? '后端拒绝了该目录。'}
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
  writable,
  openFile,
  onOpenFile,
  onSelectWorkspace,
  workspacePending,
  workspaceError,
  onBackToPortal,
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-soft" data-testid="sidebar">
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        <button
          type="button"
          onClick={onBackToPortal}
          aria-label="返回项目列表"
          title="返回项目列表"
          className="rounded-control p-1.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ink text-[var(--font-meta-size)]"
          title={projectName}
          data-testid="sidebar-project-name"
        >
          {projectName}
        </span>
      </div>

      <div role="tablist" aria-label="项目上下文" className="flex shrink-0 items-center gap-0.5 px-2 py-1.5">
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
                  ? 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-control bg-accent-soft text-ink active:bg-[var(--accent-soft-strong)]'
                  : 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
              }
            >
              <Icon size={13} aria-hidden="true" />
              <span className="text-[var(--font-meta-size)]">{tab.label}</span>
            </button>
          );
        })}
      </div>

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
          />
        ) : (
          <>
            <EmptyState
              compact
              icon={TABS.find((tab) => tab.id === activeTab)?.icon}
              title={PLACEHOLDER_HINTS[activeTab].title}
              description={PLACEHOLDER_HINTS[activeTab].description}
              testId={`sidebar-empty-${activeTab}`}
            />
            <p className="px-3 pb-3 text-subtle text-[var(--font-micro-size)]">{PLACEHOLDER_HINTS[activeTab].phase}</p>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-2">
        <button
          type="button"
          onClick={onCycleTheme}
          title={`主题：${themeLabel(themeOverride)}（⌘D 切换）`}
          aria-label={`主题：${themeLabel(themeOverride)}，点击切换`}
          data-testid="sidebar-theme-toggle"
          className="flex h-[var(--control-height-compact)] flex-1 items-center gap-1.5 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          {themeIcon(themeOverride)}
          <span className="truncate text-[var(--font-meta-size)]">{themeLabel(themeOverride)}</span>
        </button>
        <button
          type="button"
          onClick={onOpenManagement}
          title="管理（记忆 / 技能 / MCP / 任务）"
          aria-label="打开管理面板"
          data-testid="sidebar-management"
          className="flex h-[var(--control-height-compact)] items-center gap-1.5 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <Sliders size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
