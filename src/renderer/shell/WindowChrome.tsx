import { ArrowLeft, Bot, GitBranch, PanelLeft, PanelLeftClose, Search, Settings, Sliders } from 'lucide-react';

/**
 * The one global toolbar.
 *
 * The window uses `titleBarStyle: 'hiddenInset'` with
 * `trafficLightPosition: { x: 16, y: 19 }` (src/main/window-shell.ts), so the
 * traffic lights are **system controls**. We must not draw our own; the left
 * edge is padded to 74px so the header plus its own 12px padding leaves the
 * required 86px clear.
 *
 * The whole bar is a drag region, and every interactive child opts out with
 * `no-drag` — otherwise buttons become unclickable on macOS.
 *
 * ## Two things this toolbar does not do
 *
 *   1. **Draw its own traffic lights.** The window has the real system controls at
 *      `trafficLightPosition`; painted round buttons would show six lights and put a
 *      fake close control on a real window.
 *   2. **Hide labels behind macOS-only `sm:` / `md:` breakpoints.** 管理 / Git follow
 *      the shell's own 1100px breakpoint, not an arbitrary viewport width, so a label
 *      never disappears just because the window is narrow.
 *
 * The rest of the bar: the layered material bar, the boxed 项目列表 button next to the
 * breadcrumb, `~/<project>` in medium weight, the branch as bare mono text, the
 * centered 搜索… field, and the category icon hues (`--icon-*`) that identify
 * 管理 / Git at a glance.
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

/** Every chrome button uses the 8px control radius. */
const ICON_BUTTON =
  'no-drag flex h-7 w-7 items-center justify-center rounded-control text-muted transition-colors duration-[var(--duration-fast)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]';

const LABELED_BUTTON =
  'no-drag flex h-7 items-center gap-1.5 rounded-control border border-line px-2 text-muted transition-colors duration-[var(--duration-fast)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]';

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
      className="drag-region flex h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-bg/95 px-3 backdrop-blur-md"
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
            {sidebarCollapsed ? <PanelLeft size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          </button>
        )}
      </div>

      <div className="flex min-w-0 shrink items-center gap-2.5">
        {!inProject ? null : (
          <button
            type="button"
            onClick={onBackToPortal}
            title="返回项目列表"
            data-testid="titlebar-projects"
            className="no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-2 text-ink text-[var(--font-meta-size)] transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)]"
          >
            <ArrowLeft size={13} aria-hidden="true" className="text-muted" />
            <span>项目列表</span>
          </button>
        )}

        <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-muted text-[var(--font-meta-size)]">
          {inProject ? (
            <>
              <button
                type="button"
                onClick={onBackToPortal}
                className="no-drag truncate rounded-control px-1 transition-colors duration-[var(--duration-fast)] hover:text-ink active:bg-[var(--overlay-active)]"
                title="点击返回课题门户"
                data-testid="titlebar-back-to-portal"
              >
                所有项目
              </button>
              <span aria-hidden="true" className="text-subtle">
                /
              </span>
              <span
                className="max-w-[120px] truncate font-medium tracking-tight text-ink sm:max-w-[200px]"
                title={projectName}
                data-testid="titlebar-project-name"
              >
                ~/{projectName}
              </span>
              {branchLabel === null ? null : (
                <>
                  <span aria-hidden="true" className="text-subtle">
                    /
                  </span>
                  {/* Bare mono text: the branch is context, not a
                      control. `--icon-git` keeps the hue and flips with the theme. */}
                  <span
                    className="shrink-0 font-mono text-[var(--font-micro-size)]"
                    data-testid="titlebar-branch"
                  >
                    <GitBranch size={11} aria-hidden="true" className="mr-1 inline text-[var(--icon-git)]" />
                    {branchLabel}
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
      </div>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={onOpenSearch}
          data-testid="titlebar-search"
          className="no-drag flex h-7 w-32 min-w-0 items-center justify-between gap-2 truncate rounded-control border border-line bg-surface px-3 text-muted transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:bg-[var(--surface-card-hover)] hover:text-ink active:bg-[var(--overlay-active)] sm:w-48 md:w-56"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <Search size={12} aria-hidden="true" className="shrink-0 text-subtle" />
            <span className="truncate text-[var(--font-meta-size)]">搜索…</span>
          </span>
          <kbd className="hidden shrink-0 rounded-[var(--r-control)] border border-line bg-bg-soft px-1.5 py-0.5 font-mono text-muted text-[var(--font-micro-size)] sm:inline">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {backgroundRunLabel === null ? null : (
          <span
            className="hidden items-center gap-1.5 px-1 text-muted text-[var(--font-micro-size)] md:flex"
            data-testid="titlebar-background-runs"
          >
            {backgroundRunLabel}
          </span>
        )}

        {/* Active state inverts to a solid fill — and through the palette flip it
            stays legible in light theme, where `--fill-strong` is the dark stop. */}
        <button
          type="button"
          onClick={onToggleAssistant}
          aria-pressed={assistantOpen}
          aria-label={assistantOpen ? '收起助手' : '打开助手'}
          title={assistantOpen ? '收起助手（⌘J）' : '打开助手（⌘J）'}
          data-testid="titlebar-toggle-assistant"
          className={
            assistantOpen
              ? 'no-drag flex h-7 items-center gap-1.5 rounded-control border border-line-strong bg-[var(--fill-strong)] px-2.5 font-medium text-[var(--fill-strong-text)] transition-colors duration-[var(--duration-fast)] active:opacity-90'
              : `${LABELED_BUTTON} px-2.5`
          }
        >
          <Bot size={13} aria-hidden="true" />
          <span>助手</span>
        </button>

        <button
          type="button"
          onClick={onOpenManagement}
          aria-label="打开管理面板"
          title="管理（记忆 / 技能 / MCP / 任务）"
          data-testid="titlebar-management"
          className={`${LABELED_BUTTON} px-2.5`}
        >
          <Sliders size={13} aria-hidden="true" className="text-[var(--icon-manage)]" />
          <span>管理</span>
        </button>

        <button
          type="button"
          onClick={onOpenGit}
          aria-label="打开 Git 面板"
          title="Git"
          data-testid="titlebar-git"
          className={`${LABELED_BUTTON} px-2.5`}
        >
          <GitBranch size={13} aria-hidden="true" className="text-[var(--icon-git)]" />
          <span>Git</span>
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="打开设置"
          title="设置（⌘,）"
          data-testid="titlebar-settings"
          className={`${ICON_BUTTON} border border-line`}
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
