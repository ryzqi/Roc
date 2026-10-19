import type { ReactNode } from 'react';
import { Brain, Clock, Cpu, Sparkles, type LucideIcon } from 'lucide-react';
import type { ManagementScope } from './management-scope';
import { BackgroundTasksSection } from './sections/BackgroundTasksSection';
import { McpSection } from './sections/McpSection';
import { MemorySection } from './sections/MemorySection';
import { SkillsSection } from './sections/SkillsSection';
import type { ManagementStores, ManagementTabId } from './use-management-stores';

/**
 * The parts both management shells share (P9/T9.5).
 *
 * The drawer and the canvas views must not drift: the tab set, the order, the per-tab summary and
 * the body switch live here, and each shell only decides **how it is framed** (a 720px drawer vs a
 * full-width canvas view). That is the "两种入口共用同一组件" the phase asked for, without either
 * shell owning a second copy of the section wiring.
 *
 * The tab strip is the reference's: a recessed track (`bg-bg`, 1px border, 2px inner pad) holding
 * four equal chips, the selected one raised against it, and a **hue per section** (参考里
 * 记忆/技能 紫、MCP 天蓝、任务 匣黄) that is carried by the icon only while the tab is selected.
 * The tab set itself already matched — `ManagementTab` in the reference is
 * `'memory' | 'skills' | 'mcp' | 'tasks'`, the same four in the same order.
 */

export const MANAGEMENT_TABS: ReadonlyArray<{
  id: ManagementTabId;
  label: string;
  icon: LucideIcon;
  /** Applied only to the selected chip, as in the reference. */
  iconClass: string;
}> = [
  { id: 'memory', label: '记忆', icon: Brain, iconClass: 'text-[var(--icon-memory)]' },
  { id: 'skills', label: '技能', icon: Sparkles, iconClass: 'text-[var(--icon-skill)]' },
  { id: 'mcp', label: 'MCP', icon: Cpu, iconClass: 'text-[var(--icon-mcp)]' },
  { id: 'tasks', label: '任务', icon: Clock, iconClass: 'text-[var(--icon-task)]' }
];

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
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = MANAGEMENT_TABS.findIndex((tab) => tab.id === activeTab);
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? MANAGEMENT_TABS[0] : MANAGEMENT_TABS[MANAGEMENT_TABS.length - 1];
      if (target !== undefined) {
        onTabChange(target.id);
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
      onTabChange(next.id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="管理分组"
      onKeyDown={onKeyDown}
      data-testid="mgmt-tabs"
      className="flex shrink-0 items-center gap-1 rounded-card border border-line bg-bg p-0.5"
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
            onClick={() => onTabChange(tab.id)}
            data-testid={`${testIdPrefix}-tab-${tab.id}`}
            className={
              selected
                ? 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-control border border-line-strong bg-[var(--surface-card-hover)] font-semibold text-ink shadow-[var(--shadow-card)]'
                : 'flex h-[var(--control-height-compact)] flex-1 items-center justify-center gap-1.5 rounded-control border border-transparent text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
            }
          >
            <Icon size={12} aria-hidden="true" className={selected ? tab.iconClass : 'text-subtle'} />
            <span className="text-[var(--font-meta-size)]">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function managementSummary(tab: ManagementTabId, summaries: Record<ManagementTabId, string>): string {
  return summaries[tab];
}

/** The body switch. One place decides which store a section gets. */
export function ManagementSectionBody({
  tab,
  scope,
  stores,
  idPrefix,
  testIdPrefix
}: {
  tab: ManagementTabId;
  scope: ManagementScope;
  stores: ManagementStores;
  idPrefix: string;
  testIdPrefix: string;
}): ReactNode {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tab}`}
      aria-labelledby={`${idPrefix}-tab-${tab}`}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid={`${testIdPrefix}-panel-${tab}`}
    >
      {tab === 'memory' ? <MemorySection scope={scope} store={stores.memory} /> : null}
      {tab === 'skills' ? <SkillsSection store={stores.skills} /> : null}
      {tab === 'mcp' ? <McpSection scope={scope} store={stores.mcp} /> : null}
      {tab === 'tasks' ? <BackgroundTasksSection store={stores.tasks} /> : null}
    </div>
  );
}
