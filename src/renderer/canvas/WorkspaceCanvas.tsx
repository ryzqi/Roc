import { useId } from 'react';
import { workspaceModes } from '../shell/AppNavigation';
import type { AppViewId, AppRoute, AppViewTarget } from '../app/routes';
import { SelectionIndicator } from '../shared/SelectionIndicator';

const subviews = {
  overview: [['overview', '总览'], ['discover', '发现']],
  library: [['library', '文献库'], ['knowledge', '知识库']]
} as const;

type WorkspaceCanvasProps = {
  activeTab: AppViewId;
  subview: AppRoute['subview'];
  onTabChange: (tab: AppViewTarget) => void;
  selectionBar?: React.ReactNode;
  children: React.ReactNode;
};

export function WorkspaceCanvas({ activeTab, subview, onTabChange, selectionBar = null, children }: WorkspaceCanvasProps): React.JSX.Element {
  const selectionId = useId();
  const sections = activeTab === 'overview' || activeTab === 'library' ? subviews[activeTab] : null;
  return <div className="workspace-canvas-container flex h-full min-h-0 flex-col bg-surface-base text-ink-primary" data-testid="canvas">
    <header className="flex min-h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-line-default px-4 py-1">
      {sections === null ? <h1 className="font-medium [text-wrap:balance]">{workspaceModes.find(mode => mode.id === activeTab)?.label}</h1> :
        <nav aria-label="画布视图" className="flex items-center gap-1">
          {sections.map(([id, label]) => <button key={id} type="button" onClick={() => onTabChange(id)}
            aria-current={(subview ?? activeTab) === id ? 'page' : undefined} data-testid={`canvas-view-${id}`}
            className="relative min-h-8 rounded-control px-2 text-ink-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-[current=page]:bg-[var(--overlay-active)] aria-[current=page]:text-ink-primary">
            {(subview ?? activeTab) === id ? <SelectionIndicator layoutId={`${selectionId}-canvas`} testId="canvas-view-selection"
              className="inset-x-2 bottom-0 h-0.5 rounded-control bg-accent" /> : null}
            {label}
          </button>)}
        </nav>}
    </header>
    {selectionBar}
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>;
}
