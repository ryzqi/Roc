import { useRef } from 'react';
import { ArrowLeft, BookOpen, FolderTree, MessagesSquare, Moon, Sliders, Sun, SunMoon } from 'lucide-react';
import type { SidebarTab } from '../app/ui-state';
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
 * P1 renders empty states only. P3 fills 文件, P5 fills 文献, P4 fills 会话.
 */

export type LeftSidebarProps = {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  projectName: string;
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

const TAB_HINTS: Record<SidebarTab, { title: string; description: string; phase: string }> = {
  files: {
    title: '文件',
    description: '绑定项目工作目录后，这里显示真实的文件树。',
    phase: 'P3 实现'
  },
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

export function LeftSidebar({
  activeTab,
  onTabChange,
  projectName,
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
        <EmptyState
          compact
          icon={TABS.find((tab) => tab.id === activeTab)?.icon}
          title={TAB_HINTS[activeTab].title}
          description={TAB_HINTS[activeTab].description}
          testId={`sidebar-empty-${activeTab}`}
        />
        <p className="px-3 pb-3 text-subtle text-[var(--font-micro-size)]">{TAB_HINTS[activeTab].phase}</p>
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
