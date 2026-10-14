import { ModalShell } from '../shell/ModalShell';
import { EmptyState } from '../shell/EmptyState';

/**
 * Management panel shell (P1). Tabs are filled in P9.
 *
 * Same component is opened from two places (assistant-adjacent 管理 button and
 * the canvas service entry), rendered here as a right-hand drawer so neither
 * entry has to know the other's placement.
 *
 * The tab set is fixed at four — memory / skills / MCP / background tasks — and
 * deliberately excludes guardrails (they are settings, §7) and telemetry/eval
 * (no backend entity; metrics live in the run diagnostics view). Each tab opens
 * with a one-line summary so the drawer is useful before it is scrolled.
 */

export type ManagementTabId = 'memory' | 'skills' | 'mcp' | 'tasks';

const TABS: Array<{ id: ManagementTabId; label: string; phase: string }> = [
  { id: 'memory', label: '记忆', phase: 'P9 实现' },
  { id: 'skills', label: '技能', phase: 'P9 实现' },
  { id: 'mcp', label: 'MCP', phase: 'P9 实现' },
  { id: 'tasks', label: '任务', phase: 'P9 实现' }
];

/** Summary line per tab. P9 replaces each with a real projection. */
const SUMMARIES: Record<ManagementTabId, string> = {
  memory: '记忆真身是 markdown 文件（USER.md / AGENTS.md / MEMORY.md）',
  skills: '技能启停会立即影响助手的候选列表',
  mcp: '已启用服务与工具数来自 mcp.listServers',
  tasks: '后台定时任务与任务看板共用同一数据层'
};

export type ManagementPanelProps = {
  open: boolean;
  onClose: () => void;
  /** Controlled: the assistant-adjacent button and the canvas service entry
   *  open different tabs, so the owner holds the selection. */
  activeTab: ManagementTabId;
  onTabChange: (tab: ManagementTabId) => void;
};

export function ManagementPanel({
  open,
  onClose,
  activeTab,
  onTabChange
}: ManagementPanelProps): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    onTabChange(TABS[(index + delta + TABS.length) % TABS.length]!.id);
  };

  return (
    <ModalShell
      open={open}
      title="管理"
      kind="drawer"
      onClose={onClose}
      widthClassName="w-[560px]"
      testId="management-panel"
    >
      <div className="flex h-full flex-col gap-3">
        <div role="tablist" aria-label="管理分组" onKeyDown={onKeyDown} className="flex shrink-0 items-center gap-0.5">
          {TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                data-testid={`mgmt-tab-${tab.id}`}
                className={
                  selected
                    ? 'h-[var(--control-height-compact)] flex-1 rounded-control bg-accent-soft text-ink active:bg-[var(--accent-soft-strong)]'
                    : 'h-[var(--control-height-compact)] flex-1 rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                }
              >
                <span className="text-[var(--font-meta-size)]">{tab.label}</span>
              </button>
            );
          })}
        </div>

        <p className="shrink-0 text-muted text-[var(--font-meta-size)]" data-testid="mgmt-summary">
          {SUMMARIES[activeTab]}
        </p>

        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto" data-testid={`mgmt-panel-${activeTab}`}>
          <EmptyState
            title={TABS.find((tab) => tab.id === activeTab)?.label ?? ''}
            description="该分组尚未接入后端资源。"
            testId={`mgmt-placeholder-${activeTab}`}
          />
          <p className="px-6 text-center text-subtle text-[var(--font-micro-size)]">
            {TABS.find((tab) => tab.id === activeTab)?.phase}
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
