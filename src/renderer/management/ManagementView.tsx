import type { ViewProps } from '../app/view-registry';
import { useManagement } from './management-scope';
import { ManagementSectionBody, ManagementTabStrip, managementSummary } from './management-shell-parts';
import { useManagementStores, type ManagementTabId } from './use-management-stores';
import { useState } from 'react';

/**
 * Management as a canvas view (P9/T9.5).
 *
 * The route contract P1 froze maps `?view=memory|skills|mcp` onto three view ids (`app.openMainPage`
 * can ask for them), so those routes need a real surface — leaving them as P1's placeholder would
 * be the "dead face" the P6 review already punished once. This renders the **same** tab strip and
 * the same section bodies as the drawer, only framed for the canvas instead of a drawer, which is
 * what "画布服务「连接器 / 技能 / 项目记忆」" means in MASTER §5.
 *
 * The initial tab comes from the view id so a deep link lands on the right section; the user can
 * still switch tabs without the URL changing, because the tab is presentation state (the same call
 * the literature hub made for its sub-views — adding a query parameter would extend the frozen
 * route contract for a selector).
 */

export function ManagementView({ view }: ViewProps): React.JSX.Element {
  const scope = useManagement();
  const stores = useManagementStores(scope);
  const [tab, setTab] = useState<ManagementTabId>(() => viewForInitialTab(view));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-testid="management-view" data-view={view}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink text-[var(--font-h3-size)]">管理</span>
        <span className="text-subtle text-[var(--font-micro-size)]">
          与助手旁的管理抽屉是同一组面板（记忆 / 技能 / MCP / 任务）
        </span>
      </div>
      <div className="max-w-[520px]">
        <ManagementTabStrip
          activeTab={tab}
          onTabChange={setTab}
          summaries={stores.summaries}
          idPrefix="mgmt-view"
          testIdPrefix="mgmt-view"
        />
      </div>
      <p className="shrink-0 text-muted text-[var(--font-meta-size)]" data-testid="mgmt-view-summary">
        {managementSummary(tab, stores.summaries)}
      </p>
      <ManagementSectionBody tab={tab} scope={scope} stores={stores} idPrefix="mgmt-view" testIdPrefix="mgmt-view" />
    </div>
  );
}

function viewForInitialTab(view: ViewProps['view']): ManagementTabId {
  if (view === 'skills' || view === 'mcp') {
    return view;
  }
  return 'memory';
}
