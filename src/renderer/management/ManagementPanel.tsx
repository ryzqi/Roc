import { useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { ModalShell } from '../shell/ModalShell';
import { useManagement } from './management-scope';
import { MANAGEMENT_TABS, ManagementSectionBody, ManagementTabStrip, managementSummary } from './management-shell-parts';
import { useManagementStores, type ManagementTabId } from './use-management-stores';

/**
 * Management drawer (P1 shell, P9 content).
 *
 * Same component is opened from two places (assistant-adjacent 管理 button and the canvas service
 * entry), rendered as a right-hand drawer so neither entry has to know the other's placement. The
 * tab set is fixed at four — memory / skills / MCP / background tasks — and deliberately excludes
 * guardrails (they are settings, §7) and telemetry/eval (no backend entity; metrics live in the run
 * diagnostics view).
 *
 * **The width changed in P9** from 560px to `min(720px, 92vw)`: the four tabs carry a markdown
 * editor with an outline, a file browser with a preview, an MCP form and a task form, and a 560px
 * column forced the editors into a scroll of their own (the draft and its outline could not be seen
 * together). The tab strip, the per-tab summary and the section bodies come from
 * `management-shell-parts` so the canvas views cannot drift from the drawer.
 */

export type ManagementPanelProps = {
  open: boolean;
  onClose: () => void;
  /** Controlled: the assistant-adjacent button and the canvas service entry open different tabs,
   *  so the owner holds the selection. */
  activeTab: ManagementTabId;
  onTabChange: (tab: ManagementTabId) => void;
};

export function ManagementPanel({
  open,
  onClose,
  activeTab,
  onTabChange
}: ManagementPanelProps): React.JSX.Element {
  const scope = useManagement();
  const stores = useManagementStores(scope);
  const tab = MANAGEMENT_TABS.some((entry) => entry.id === activeTab) ? activeTab : 'memory';
  const [discardOpen, setDiscardOpen] = useState(false);

  /**
   * Unsaved memory drafts are never dropped silently.
   *
   * The drawer keeps its stores while closed (the mount latch is what makes reopening instant), so
   * a draft *would* survive; but the same panels are also mounted as canvas views, and two editors
   * holding the same slot is how one save silently overwrites the other. So leaving with edits asks
   * first — and discarding on the way out is what keeps "one draft at a time" true.
   */
  const beforeClose = (): boolean => {
    if (stores.memory.dirtyCount === 0) {
      return true;
    }
    setDiscardOpen(true);
    return false;
  };

  return (
    <>
    <ModalShell
      open={open}
      title="管理"
      kind="drawer"
      onClose={onClose}
      beforeClose={beforeClose}
      widthClassName="w-[min(720px,92vw)]"
      testId="management-panel"
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        <ManagementTabStrip
          activeTab={tab}
          onTabChange={onTabChange}
          summaries={stores.summaries}
          idPrefix="mgmt-drawer"
          testIdPrefix="mgmt"
        />

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-muted text-[var(--font-meta-size)]" data-testid="mgmt-summary">
            {managementSummary(tab, stores.summaries)}
          </p>
          <button
            type="button"
            data-testid="mgmt-open-in-canvas"
            onClick={() => scope.openManagementView(tab)}
            title={
              tab === 'tasks'
                ? '任务在画布上的家是任务看板（P6）'
                : '在画布里打开同一组面板（和这里的抽屉共用组件）'
            }
            className="h-[var(--control-height-compact)] shrink-0 rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {tab === 'tasks' ? '打开任务看板' : '在画布中打开'}
          </button>
        </div>

        <ManagementSectionBody tab={tab} scope={scope} stores={stores} idPrefix="mgmt-drawer" testIdPrefix="mgmt" />
      </div>
    </ModalShell>

    <ConfirmDialog
      open={discardOpen}
      title="放弃未保存的记忆改动？"
      message={`有 ${stores.memory.dirtyCount} 份记忆文件尚未保存。`}
      detail="放弃后这些改动不会写入后端。同一组面板在画布视图里也能编辑，两个编辑器各持一份草稿会互相覆盖。"
      confirmLabel="放弃修改"
      cancelLabel="继续编辑"
      tone="destructive"
      testId="mgmt-discard"
      onCancel={() => setDiscardOpen(false)}
      onConfirm={() => {
        setDiscardOpen(false);
        stores.memory.discardAll();
        onClose();
      }}
    />
    </>
  );
}
