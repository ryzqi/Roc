import { surfaceFor, type CanvasTabId } from '../../shared/surfaces';

export type { CanvasTabId };

export type WorkspaceCanvasProps = {
  activeTab: CanvasTabId | null;
  onTabChange: (tab: CanvasTabId) => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
};

/** Navigation lives in the sidebar; this toolbar names the current canvas. */
export function WorkspaceCanvas({ activeTab, children, actions }: WorkspaceCanvasProps): React.JSX.Element {
  return <div className="workspace-canvas-container flex h-full min-h-0 flex-col" data-testid="canvas">
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-line px-4 py-1">
      <h1 className="font-medium text-[length:var(--font-ui-size)]" style={{textWrap: 'balance'}}>{activeTab === null ? '工作区' : surfaceFor(activeTab).label}</h1>
      {actions === undefined ? null : <div className="ms-auto flex items-center gap-1">{actions}</div>}
    </div>
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>;
}
