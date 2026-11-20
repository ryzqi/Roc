import { useEffect, useId, useState, type ReactNode } from 'react';
import type {AppViewId} from '../app/routes';
import { Brain, Clock, Cpu, Sparkles, type LucideIcon } from 'lucide-react';
import type { ManagementScope } from './management-scope';
import { BackgroundTasksSection } from './sections/BackgroundTasksSection';
import { ResearchTasksSection } from './sections/ResearchTasksSection';
import { PythonEnvironmentSection } from './sections/PythonEnvironmentSection';
import { McpSection } from './sections/McpSection';
import { MemorySection } from './sections/MemorySection';
import { SkillsSection } from './sections/SkillsSection';
import type { ManagementTabId } from './use-management-stores';
import { useManagementStores } from './management-stores-provider';
import { requestManagementEditorChange } from './management-interactions';
import {TaskCenterOverview} from './TaskCenterOverview';
import type {TaskCenterRow} from './use-task-center';
import './management-layout.css';

/**
 * The parts both management shells share (P9/T9.5).
 *
 * The drawer and the canvas views must not drift: the tab set, the order, the per-tab summary and
 * the body switch live here, and each shell only decides **how it is framed** (a 720px drawer vs a
 * full-width canvas view). That is the "两种入口共用同一组件" the phase asked for, without either
 * shell owning a second copy of the section wiring.
 *
 * The tab strip is a recessed track holding four flat chips,
 * with a **hue per section** (记忆/技能 紫、MCP 天蓝、任务 匣黄)
 * carried by the icon only while the tab is selected. The tab set is
 * `'memory' | 'skills' | 'mcp' | 'tasks'`, in that order.
 */

export const MANAGEMENT_TABS: ReadonlyArray<{
  id: ManagementTabId;
  label: string;
  icon: LucideIcon;
  /** Applied only to the selected chip. */
  iconClass: string;
}> = [
  { id: 'memory', label: '记忆', icon: Brain, iconClass: 'text-[var(--icon-memory)]' },
  { id: 'skills', label: '技能', icon: Sparkles, iconClass: 'text-[var(--icon-skill)]' },
  { id: 'mcp', label: 'MCP', icon: Cpu, iconClass: 'text-[var(--icon-mcp)]' },
  { id: 'tasks', label: '任务', icon: Clock, iconClass: 'text-[var(--icon-task)]' }
];

export const MANAGEMENT_LOADING_SUMMARIES: Record<ManagementTabId, string> = {
  memory: '正在加载…',
  skills: '正在加载…',
  mcp: '正在加载…',
  tasks: '正在加载…'
};

export function ManagementTabStrip({
  activeTab,
  onTabChange,
  summaries,
  idPrefix,
  testIdPrefix
}: {
  activeTab: ManagementTabId;
  onTabChange: (tab: ManagementTabId) => void;
  summaries: Record<ManagementTabId, string>;
  /** Distinguishes the drawer's and the view's DOM ids when both are mounted. */
  idPrefix: string;
  /**
   * Distinguishes their test ids too.
   *
   * The drawer floats over the canvas, so the same tab can be mounted twice (drawer + view). With
   * one shared test id a `count() === 1` gate assertion would fail, and a click would pick whichever
   * node came first — the P9 gate hit exactly that.
   */
  testIdPrefix: string;
}): React.JSX.Element {
  const selectTab = (tab: ManagementTabId, tablist?: HTMLDivElement): void => {
    if (tab === activeTab) return;
    requestManagementEditorChange(() => {
      onTabChange(tab);
      tablist?.querySelector<HTMLButtonElement>(`[id="${idPrefix}-tab-${tab}"]`)?.focus({preventScroll: true});
    });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = MANAGEMENT_TABS.findIndex((tab) => tab.id === activeTab);
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? MANAGEMENT_TABS[0] : MANAGEMENT_TABS[MANAGEMENT_TABS.length - 1];
      if (target !== undefined) {
        selectTab(target.id, event.currentTarget);
      }
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    const next = MANAGEMENT_TABS[(index + delta + MANAGEMENT_TABS.length) % MANAGEMENT_TABS.length];
    if (next !== undefined) {
      selectTab(next.id, event.currentTarget);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="管理分组"
      onKeyDown={onKeyDown}
      data-testid="mgmt-tabs"
      className="flex shrink-0 flex-wrap items-center gap-1 rounded-card bg-[var(--overlay-hover)] p-1"
    >
      {MANAGEMENT_TABS.map((tab) => {
        const selected = tab.id === activeTab;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            title={summaries[tab.id]}
            onClick={() => selectTab(tab.id)}
            data-testid={`${testIdPrefix}-tab-${tab.id}`}
            className={
              selected
                ? 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1 rounded-[calc(var(--r-card)-var(--space-1))] bg-surface px-2 font-[var(--font-weight-medium)] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'
                : 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1 rounded-[calc(var(--r-card)-var(--space-1))] px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'
            }
          >
            <Icon size={12} aria-hidden="true" className={selected ? tab.iconClass : 'text-subtle'} />
            <span className="text-[length:var(--font-meta-size)]">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function managementSummary(tab: ManagementTabId, summaries: Record<ManagementTabId, string>): string {
  return summaries[tab];
}

export function ManagementSectionBody({
  tab,
  scope,
  idPrefix,
  testIdPrefix,
  canvasView
}: {
  tab: ManagementTabId;
  scope: ManagementScope;
  idPrefix: string;
  testIdPrefix: string;
  canvasView?: AppViewId | undefined;
}): ReactNode {
  let section: ReactNode;
  switch (tab) {
    case 'memory':
      section = <MemorySectionContent scope={scope} />;
      break;
    case 'skills':
      section = <SkillsSectionContent />;
      break;
    case 'mcp':
      section = <McpSectionContent scope={scope} />;
      break;
    case 'tasks':
      section = <TasksSectionContent scope={scope} canvasView={canvasView} />;
      break;
  }

  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tab}`}
      aria-labelledby={`${idPrefix}-tab-${tab}`}
      tabIndex={-1}
      className="management-body ui-scroll-region flex-1 p-1"
      data-testid={`${testIdPrefix}-panel-${tab}`}
    >
      {section}
    </div>
  );
}

function MemorySectionContent({ scope }: { scope: ManagementScope }): ReactNode {
  const store = useManagementStores((stores) => stores.memory);
  return store === null ? <ManagementSectionLoading /> : <MemorySection scope={scope} store={store} />;
}

function SkillsSectionContent(): ReactNode {
  const store = useManagementStores((stores) => stores.skills);
  return store === null ? <ManagementSectionLoading /> : <SkillsSection store={store} />;
}

function McpSectionContent({ scope }: { scope: ManagementScope }): ReactNode {
  const store = useManagementStores((stores) => stores.mcp);
  return store === null ? <ManagementSectionLoading /> : <McpSection scope={scope} store={store} />;
}

type TaskCategory = 'overview' | 'background' | 'research' | 'python';

function TasksSectionContent({ scope, canvasView }: { scope: ManagementScope; canvasView: AppViewId | undefined }): ReactNode {
  const store = useManagementStores((stores) => stores.tasks);
  const id = useId();
  const [category, setCategory] = useState<TaskCategory>(() => scope.researchTaskId ? 'research' : 'overview');
  const available: { id: TaskCategory; label: string }[] = scope.projectId === null
    ? [{id: 'overview', label: '总览'}, { id: 'background', label: '后台配置' }]
    : [{id: 'overview', label: '总览'}, { id: 'background', label: '后台配置' }, { id: 'research', label: '科研详情' }, { id: 'python', label: '高级' }];
  const active = scope.projectId === null && (category === 'research' || category === 'python') ? 'overview' : category;
  useEffect(() => {
    setCategory(scope.researchTaskId !== null ? 'research' : 'overview');
  }, [scope.researchTaskId, scope.taskCenterRequestId]);
  const selectCategory = (next: TaskCategory, tablist?: HTMLDivElement): void => {
    if (store?.isBusy()) return;
    requestManagementEditorChange(() => {
      setCategory(next);
      tablist?.querySelector<HTMLButtonElement>(`[data-category="${next}"]`)?.focus();
    });
  };
  const openTask = (row: TaskCenterRow): void => {
    if (store?.isBusy()) return;
    requestManagementEditorChange(() => {
      if (row.source === 'research') {
        scope.onSelectResearchTask(row.id);
        setCategory('research');
      } else if (row.source === 'background') {
        store?.select(row.id);
        setCategory('background');
      } else if (row.libraryItemId !== null) scope.onOpenLiteratureTask(row.libraryItemId);
    });
  };
  return (
    <div className="management-tasks">
      <div className="management-task-categories" role="tablist" aria-label="任务分类" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = available.findIndex(entry => entry.id === active);
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length;
        const next = available[nextIndex];
        if (next) selectCategory(next.id, event.currentTarget);
      }}>
        {available.map(entry => <button key={entry.id} type="button" role="tab" id={`${id}-${entry.id}-tab`}
          aria-selected={active === entry.id} aria-controls={`${id}-${entry.id}-panel`} tabIndex={active === entry.id ? 0 : -1}
          title={entry.id === 'python' ? 'Python 环境' : undefined}
          data-category={entry.id} data-testid={`mgmt-task-category-${entry.id}`} disabled={store?.busy}
          onClick={() => selectCategory(entry.id)}>{entry.label}</button>)}
      </div>
      {/* Keep editors mounted so hidden drafts, pending operations and their navigation guards survive category changes. */}
      <div role="tabpanel" id={`${id}-overview-panel`} aria-labelledby={`${id}-overview-tab`} hidden={active !== 'overview'}>
        <TaskCenterOverview center={scope.taskCenter} onOpen={openTask} disabled={store === null || store.busy}/>
      </div>
      <div role="tabpanel" id={`${id}-background-panel`} aria-labelledby={`${id}-background-tab`} hidden={active !== 'background'}>
        {store === null ? <ManagementSectionLoading /> : <BackgroundTasksSection store={store} />}
      </div>
      {scope.projectId === null ? null : <div key={scope.projectId}>
        <div role="tabpanel" id={`${id}-research-panel`} aria-labelledby={`${id}-research-tab`} hidden={active !== 'research'}>
          <ResearchTasksSection client={scope.client} projectId={scope.projectId} canvasView={canvasView}
            selectedTaskId={scope.researchTaskId} onSelectTask={scope.onSelectResearchTask} onOpenArtifact={scope.onOpenArtifact} />
        </div>
        <div role="tabpanel" id={`${id}-python-panel`} aria-labelledby={`${id}-python-tab`} hidden={active !== 'python'}>
          <PythonEnvironmentSection client={scope.client} projectId={scope.projectId} />
        </div>
      </div>}
    </div>
  );
}

function ManagementSectionLoading(): React.JSX.Element {
  return (
    <p role="status" className="p-3 text-muted">
      正在加载管理数据…
    </p>
  );
}
