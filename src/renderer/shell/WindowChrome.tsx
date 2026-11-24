import { useId, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Columns2, FolderOpen, GitBranch, PanelLeft, PanelLeftClose, PencilLine, Search, Sliders, Telescope, X } from 'lucide-react';
import type { LayoutPreset } from '../app/routes';
import './chrome.css';

export type ProjectOption = { id: string; title: string };

export type WindowChromeProps = {
  projectName: string | null;
  projectId: string | null;
  projects: readonly ProjectOption[];
  onOpenProject: (projectId: string) => void;
  onBackToPortal: () => void;
  onOpenSearch: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  assistantRunning: boolean;
  onOpenGit: () => void;
  onOpenManagement: () => void;
  branchLabel?: string | null;
  gitChangeCount?: number | null;
  layoutPreset: LayoutPreset;
  onChangePreset: (preset: LayoutPreset) => void;
};

const presets = [
  { id: 'research', label: '探索布局', icon: Telescope },
  { id: 'writing', label: '专注布局', icon: PencilLine },
  { id: 'review', label: '运行布局', icon: Columns2 }
] as const;

export function WindowChrome({
  projectName, projectId, projects, onOpenProject, onBackToPortal, onOpenSearch, sidebarCollapsed, onToggleSidebar,
  assistantOpen, onToggleAssistant, assistantRunning, onOpenGit, onOpenManagement, branchLabel = null, gitChangeCount = null, layoutPreset, onChangePreset
}: WindowChromeProps): React.JSX.Element {
  const inProject = projectId !== null;
  const menuId = useId();
  const projectMenu = useRef<HTMLDivElement>(null);
  const projectSearch = useRef<HTMLInputElement>(null);
  const layoutMenuId = useId();
  const layoutMenu = useRef<HTMLDivElement>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const searchableProjects = projects.length > 12;
  const normalizedQuery = searchableProjects ? projectQuery.trim().toLocaleLowerCase() : '';
  const visibleProjects = projects.filter(project => project.title.toLocaleLowerCase().includes(normalizedQuery));
  const branch = branchLabel ?? 'Git';
  const gitLabel = gitChangeCount === null ? branch : `${branch}，${gitChangeCount.toLocaleString('zh-CN')} 项变更`;

  return (
    <header className="titlebar drag-region grid h-[38px] shrink-0 grid-cols-[minmax(0,1fr)_min(320px,35vi)_minmax(0,1fr)] items-center gap-2 border-b-[0.5px] border-line-default bg-surface-rail px-3 text-[length:var(--font-meta-size)]"
      data-testid="titlebar">
      {/* Native hiddenInset traffic lights reserve 74px plus the toolbar's 12px padding. */}
      <div className="flex min-w-0 items-center gap-1 ps-[74px]">
        <button type="button" onClick={onToggleSidebar} disabled={!inProject}
          aria-label={sidebarCollapsed ? '展开上下文抽屉' : '收起上下文抽屉'} aria-pressed={!sidebarCollapsed && inProject}
          aria-keyshortcuts="Meta+B" title={sidebarCollapsed ? '展开上下文抽屉（⌘B）' : '收起上下文抽屉（⌘B）'}
          data-testid="titlebar-toggle-sidebar" className={`no-drag chrome-control shrink-0 ${inProject ? '' : 'hidden'}`}>
          {sidebarCollapsed ? <PanelLeft size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
        </button>
        {inProject ? <>
          <button type="button" popoverTarget={menuId} aria-label="切换项目" title={projectName ?? '切换项目'}
            className="no-drag chrome-control min-w-7 border-[0.5px] border-line" data-testid="titlebar-projects">
            <FolderOpen size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 truncate font-medium text-ink" data-testid="titlebar-project-name">{projectName ?? '研究项目'}</span>
            <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
          </button>
          <div popover="auto" ref={projectMenu} id={menuId} className="no-drag titlebar-project-menu" role="group" aria-label="研究项目"
            onToggle={event => {
              if ((event.nativeEvent as ToggleEvent).newState === 'closed') setProjectQuery('');
              else projectSearch.current?.focus();
            }}>
            <button type="button" className="chrome-control w-full justify-start" onClick={() => {
              projectMenu.current?.hidePopover();
              onBackToPortal();
            }} data-testid="titlebar-project-portal">
              <FolderOpen size={14} aria-hidden="true" />所有项目
            </button>
            <div className="mt-1 border-t-[0.5px] border-line pt-1">
              {searchableProjects ? (
                <label className="mb-1 flex min-h-8 items-center gap-2 rounded-control border-[0.5px] border-line-default bg-surface-raised px-2">
                  <Search size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
                  <input ref={projectSearch} type="search" aria-label="搜索项目" placeholder="搜索项目" value={projectQuery}
                    onChange={event => setProjectQuery(event.target.value)} data-testid="titlebar-project-search"
                    className="min-w-0 flex-1 bg-transparent py-1 text-ink-primary" />
                  {projectQuery.length > 0 ? <button type="button" aria-label="清空项目搜索" className="chrome-control shrink-0"
                    onClick={() => { setProjectQuery(''); projectSearch.current?.focus(); }}>
                    <X size={14} aria-hidden="true" />
                  </button> : null}
                </label>
              ) : null}
              {visibleProjects.length === 0 ? <p role="status" className="px-2 py-3 text-ink-muted" data-testid="titlebar-project-empty">没有匹配的项目</p> : null}
              {visibleProjects.map(project => (
                <button key={project.id} type="button" title={project.title} className="chrome-control w-full justify-between"
                  data-testid={`titlebar-project-${project.id}`}
                  aria-current={project.id === projectId ? 'page' : undefined} onClick={() => {
                    projectMenu.current?.hidePopover();
                    if (project.id !== projectId) onOpenProject(project.id);
                  }}>
                  <span className="min-w-0 truncate">{project.title}</span>
                  {project.id === projectId ? <Check size={14} aria-hidden="true" className="shrink-0" /> : null}
                </button>
              ))}
            </div>
          </div>
        </> : <span className="truncate text-ink" data-testid="titlebar-portal-title">研究项目</span>}
      </div>

      <button type="button" onClick={onOpenSearch} aria-label="搜索文献、文件或命令" title="搜索（⌘K）" aria-keyshortcuts="Meta+K" data-testid="titlebar-search"
        className="no-drag chrome-control min-w-0 justify-between border-[0.5px] border-line-default bg-surface-raised px-3">
        <span className="flex min-w-0 items-center gap-2">
          <Search size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate">搜索文献、文件或命令…</span>
        </span>
        <kbd dir="ltr" aria-hidden="true" className="shrink-0 font-mono">⌘K</kbd>
      </button>

      {inProject ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <button type="button" onClick={onOpenGit} title={gitLabel} aria-label={`打开 Git 面板，${gitLabel}`}
            className="no-drag chrome-control min-w-0 border-[0.5px] border-line" data-testid="titlebar-git">
            <GitBranch size={14} aria-hidden="true" className="shrink-0 text-[var(--icon-git)]" />
            <span dir="ltr" className="hidden truncate font-mono min-[920px]:block" data-testid="titlebar-branch">{branch}</span>
            {gitChangeCount !== null && gitChangeCount > 0 ? <span dir="ltr" aria-hidden="true" className="tabular-nums">{gitChangeCount.toLocaleString('zh-CN')}</span> : null}
          </button>
          <button type="button" popoverTarget={layoutMenuId} aria-label="工作布局" title="工作布局"
            className="no-drag chrome-control shrink-0" data-testid="titlebar-layout">
            <Columns2 size={14} aria-hidden="true" />
            <span className="titlebar-action-label">布局</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <div popover="auto" ref={layoutMenu} id={layoutMenuId} role="group" aria-label="工作布局"
            className="no-drag titlebar-layout-menu">
            {presets.map(({ id, label, icon: Icon }, index) => (
              <button key={id} type="button" onClick={() => {
                layoutMenu.current?.hidePopover();
                onChangePreset(id);
              }} className="chrome-control w-full justify-start"
                aria-label={label} aria-pressed={layoutPreset === id} aria-keyshortcuts={`Meta+${index + 1}`}
                title={`${label}（⌘${index + 1}）`} data-testid={`layout-preset-${id}`}>
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
                <kbd dir="ltr" aria-hidden="true" className="ms-auto font-mono">⌘{index + 1}</kbd>
              </button>
            ))}
          </div>
          <button type="button" onClick={onOpenManagement} aria-label="管理" title="管理"
            className="no-drag chrome-control shrink-0" data-testid="titlebar-management">
            <Sliders size={14} aria-hidden="true" />
            <span className="titlebar-action-label">管理</span>
          </button>
          <button type="button" onClick={onToggleAssistant} aria-pressed={assistantOpen} aria-keyshortcuts="Meta+L"
            aria-label={`${assistantOpen ? '收起助手' : '打开助手'}${assistantRunning ? '，正在运行' : ''}`}
            title={assistantOpen ? '收起助手（⌘L）' : '打开助手（⌘L）'} data-testid="titlebar-toggle-assistant"
            className="no-drag chrome-control relative shrink-0">
            <Bot size={16} aria-hidden="true" className="text-[var(--icon-agent)]" />
            {assistantRunning ? <span aria-hidden="true" className="absolute end-1 top-1 size-1.5 rounded-full bg-accent motion-safe:animate-pulse" /> : null}
          </button>
        </div>
      ) : null}
    </header>
  );
}
