import { Bot, GitBranch, PanelLeft, PanelLeftClose, Search, Settings, Sliders } from 'lucide-react';

/**
 * The one global toolbar (MASTER v2 §6.1).
 *
 * The window uses `titleBarStyle: 'hiddenInset'` with
 * `trafficLightPosition: { x: 16, y: 19 }` (src/main/window-shell.ts), so the
 * traffic lights are **system controls**. We must not draw our own; the left
 * edge is padded to 74px so the header plus its own 12px padding leaves the
 * required 86px clear.
 *
 * The whole bar is a drag region, and every interactive child opts out with
 * `no-drag` — otherwise buttons become unclickable on macOS.
 */

export type WindowChromeProps = {
  /** null renders the portal breadcrumb. */
  projectName: string | null;
  onBackToPortal: () => void;
  onOpenSearch: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  onOpenGit: () => void;
  onOpenManagement: () => void;
  onOpenSettings: () => void;
  /** Current git branch, when a project workspace is bound (P3). */
  branchLabel?: string | null;
  /** Background-run hint from `lifecycle.getTraySummary` (P9). */
  backgroundRunLabel?: string | null;
};

const ICON_BUTTON =
  'no-drag flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]';

const LABELED_BUTTON =
  'no-drag flex h-7 items-center gap-1.5 rounded-control border border-line px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]';

export function WindowChrome({
  projectName,
  onBackToPortal,
  onOpenSearch,
  sidebarCollapsed,
  onToggleSidebar,
  assistantOpen,
  onToggleAssistant,
  onOpenGit,
  onOpenManagement,
  onOpenSettings,
  branchLabel = null,
  backgroundRunLabel = null
}: WindowChromeProps): React.JSX.Element {
  const inProject = projectName !== null;

  return (
    <header
      className="drag-region flex h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-bg px-3"
      data-testid="titlebar"
    >
      {/* 74px + the header's 12px padding = the 86px the traffic lights need. */}
      <div className="flex shrink-0 items-center gap-1 pr-1 pl-[74px]">
        {!inProject ? null : (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? '展开左栏' : '收起左栏'}
            aria-pressed={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开左栏（⌘B）' : '收起左栏（⌘B）'}
            data-testid="titlebar-toggle-sidebar"
            className={ICON_BUTTON}
          >
            {sidebarCollapsed ? <PanelLeft size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
          </button>
        )}
      </div>

      <nav aria-label="面包屑" className="flex min-w-0 shrink items-center gap-1.5 text-[var(--font-meta-size)]">
        {inProject ? (
          <>
            <button
              type="button"
              onClick={onBackToPortal}
              className="no-drag truncate rounded-control px-1 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
              title="返回所有项目"
              data-testid="titlebar-back-to-portal"
            >
              所有项目
            </button>
            <span aria-hidden="true" className="text-subtle">
              /
            </span>
            <span
              className="max-w-[200px] truncate font-mono text-ink"
              title={projectName}
              data-testid="titlebar-project-name"
            >
              {projectName}
            </span>
            {branchLabel === null ? null : (
              <>
                <span aria-hidden="true" className="text-subtle">
                  /
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[var(--st-ok)]" data-testid="titlebar-branch">
                  <GitBranch size={11} aria-hidden="true" />
                  <span className="font-mono text-[var(--font-micro-size)]">{branchLabel}</span>
                </span>
              </>
            )}
          </>
        ) : (
          <span className="px-1 text-ink" data-testid="titlebar-portal-title">
            研究项目
          </span>
        )}
      </nav>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={onOpenSearch}
          data-testid="titlebar-search"
          className="no-drag flex h-7 w-40 min-w-0 items-center justify-between gap-2 truncate rounded-control border border-line bg-surface px-2.5 text-muted hover:bg-[var(--surface-card-hover)] hover:text-ink active:bg-[var(--overlay-active)] sm:w-56"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <Search size={12} aria-hidden="true" className="shrink-0 text-subtle" />
            <span className="truncate text-[var(--font-meta-size)]">搜索项目、文献、文件…</span>
          </span>
          <kbd className="hidden shrink-0 rounded-[var(--r-control)] border border-line bg-bg-soft px-1.5 py-0.5 font-mono text-subtle text-[var(--font-micro-size)] sm:inline">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {backgroundRunLabel === null ? null : (
          <span className="hidden items-center gap-1.5 px-1 text-muted text-[var(--font-micro-size)] md:flex" data-testid="titlebar-background-runs">
            {backgroundRunLabel}
          </span>
        )}

        <button
          type="button"
          onClick={onToggleAssistant}
          aria-pressed={assistantOpen}
          aria-label={assistantOpen ? '收起助手' : '打开助手'}
          title={assistantOpen ? '收起助手（⌘J）' : '打开助手（⌘J）'}
          data-testid="titlebar-toggle-assistant"
          className={
            assistantOpen
              ? 'no-drag flex h-7 items-center gap-1.5 rounded-control border border-line bg-accent-soft px-2 text-ink active:bg-[var(--accent-soft-strong)]'
              : LABELED_BUTTON
          }
        >
          <Bot size={13} aria-hidden="true" />
          <span className="hidden text-[var(--font-meta-size)] md:inline">助手</span>
        </button>

        <button
          type="button"
          onClick={onOpenManagement}
          aria-label="打开管理面板"
          title="管理（记忆 / 技能 / MCP / 任务）"
          data-testid="titlebar-management"
          className={LABELED_BUTTON}
        >
          <Sliders size={13} aria-hidden="true" />
          <span className="hidden text-[var(--font-meta-size)] md:inline">管理</span>
        </button>

        <button
          type="button"
          onClick={onOpenGit}
          aria-label="打开 Git 面板"
          title="Git"
          data-testid="titlebar-git"
          className={LABELED_BUTTON}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span className="hidden text-[var(--font-meta-size)] md:inline">Git</span>
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="打开设置"
          title="设置（⌘,）"
          data-testid="titlebar-settings"
          className={ICON_BUTTON}
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
