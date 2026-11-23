import { useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { ModalShell } from '../shell/ModalShell';
import { useManagement } from './management-scope';
import { MANAGEMENT_LOADING_SUMMARIES, MANAGEMENT_TABS, ManagementSectionBody, ManagementTabStrip, managementSummary } from './management-shell-parts';
import type { ManagementTabId } from './use-management-stores';
import { useManagementStores } from './management-stores-provider';
import { discardManagementDrafts, managementDraftState } from './management-draft-state';
import { requestManagementEditorChange } from './management-interactions';

/**
 * Shared management drawer, opened from the persistent titlebar action or a command.
 * The shell owns the active tab; all entry points reuse the same stores and draft guards.
 * Section bodies are shared with the task canvas. The wider drawer keeps editors readable.
 */

export type ManagementPanelProps = {
  open: boolean;
  onClose: () => void;
  /** Controlled so the titlebar and commands can select the appropriate section. */
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
  const summaries = useManagementStores((stores) => stores.summaries);
  const stores = useManagementStores((stores) => stores);
  const drafts = managementDraftState(stores);
  const visibleSummaries = {...(summaries ?? MANAGEMENT_LOADING_SUMMARIES), tasks: scope.taskCenter.summary};
  const tab = MANAGEMENT_TABS.some((entry) => entry.id === activeTab) ? activeTab : 'memory';
  const [discardOpen, setDiscardOpen] = useState(false);

  /**
   * Unsaved management drafts are never dropped silently.
   *
   * The drawer and canvas share one scope-owned draft store. Leaving the drawer with
   * edits still asks first, and discarding clears the same draft both surfaces display.
   */
  const beforeClose = (): boolean => {
    requestManagementEditorChange(() => {
      const current = managementDraftState(stores);
      if (current.busy) return;
      if (current.sections.length === 0) onClose();
      else setDiscardOpen(true);
    });
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
      closeDisabled={drafts.busy}
      closeOnBackdrop={false}
      bodyPadding="none"
      widthClassName="w-[min(720px,92vw)]"
      testId="management-panel"
    >
      <div className="management-surface management-drawer">
        <ManagementTabStrip
          activeTab={tab}
          onTabChange={onTabChange}
          summaries={visibleSummaries}
          idPrefix="mgmt-drawer"
          testIdPrefix="mgmt"
        />

        {tab === 'skills' || tab === 'mcp' ? <p className="shrink-0 text-muted text-[length:var(--font-meta-size)]" data-testid="mgmt-summary">
          {managementSummary(tab, visibleSummaries)}
        </p> : null}

        <ManagementSectionBody tab={tab} scope={scope} idPrefix="mgmt-drawer" testIdPrefix="mgmt" />
      </div>
    </ModalShell>

    <ConfirmDialog
      open={open && discardOpen}
      title="放弃未保存的管理改动？"
      message={`${drafts.sections.join('、')} 尚未保存。`}
      detail="放弃后需要重新填写。"
      confirmLabel="放弃修改"
      cancelLabel="继续编辑"
      tone="destructive"
      confirmDisabled={drafts.busy}
      testId="mgmt-discard"
      onCancel={() => setDiscardOpen(false)}
      onConfirm={() => {
        if (managementDraftState(stores).busy) return;
        setDiscardOpen(false);
        discardManagementDrafts(stores);
        onClose();
      }}
    />
    </>
  );
}
