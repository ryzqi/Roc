import { Suspense, lazy } from 'react';
import type { WindowStateSnapshot } from '../../shared/types';
import type { LazyLoadState, ViewId, WorkbenchTool, WorkspaceData } from '../app/types';
import { WORKBENCH_TOOLS } from '../app/view-routing';
import { PreviewIcon } from '../components/PreviewIcon';
import type { LoadedState } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';

const FilesWorkbench = lazy(() => import('./FilesWorkbench').then((module) => ({ default: module.FilesWorkbench })));
const GitWorkbench = lazy(() => import('./GitWorkbench').then((module) => ({ default: module.GitWorkbench })));
const TerminalWorkbench = lazy(() => import('./TerminalWorkbench').then((module) => ({ default: module.TerminalWorkbench })));

export function WorkbenchPanel({
  activeTool,
  activeView: _activeView,
  client,
  onClose,
  onToolChange,
  onWidthChange,
  state,
  updateWorkspaceData,
  workspaceLoadState,
  width,
  windowState
}: {
  activeTool: WorkbenchTool;
  activeView: ViewId;
  client?: RocClient;
  onClose: () => void;
  onToolChange: (tool: WorkbenchTool) => void;
  onWidthChange: (width: number) => void;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
  workspaceLoadState: LazyLoadState;
  width: number;
  windowState: WindowStateSnapshot;
}): React.JSX.Element {
  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
      onWidthChange(nextWidth);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  return (
    <aside className="workbench" data-testid="workbench-panel">
      <div
        aria-label="调节右侧工作台宽度"
        className="workbench-resize-handle"
        data-testid="workbench-resize-handle"
        role="separator"
        tabIndex={0}
        onPointerDown={startResize}
      />
      <div className="workbench-bar">
        <div className="workbench-tabs">
          {WORKBENCH_TOOLS.map((tool) => {
            return (
              <button
                aria-pressed={activeTool === tool.id}
                className={activeTool === tool.id ? 'workbench-tab active' : 'workbench-tab'}
                data-tool-button={tool.id}
                key={tool.id}
                type="button"
                onClick={() => onToolChange(tool.id)}
              >
                <PreviewIcon name={tool.icon} />
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
        <button aria-label="关闭右侧工作台" className="workbench-close" type="button" onClick={onClose}>
          <span className="titlebar-glyph" aria-hidden="true">×</span>
        </button>
      </div>
      <div className="workbench-panel">
        <Suspense fallback={<section className="tool-panel workbench-surface" data-testid="workbench-tool-loading" />}>
          {activeTool === 'git' ? (
            <GitWorkbench client={client} loadState={workspaceLoadState} state={state} updateWorkspaceData={updateWorkspaceData} />
          ) : activeTool === 'terminal' ? (
            <TerminalWorkbench client={client} state={state} updateWorkspaceData={updateWorkspaceData} windowState={windowState} />
          ) : (
            <FilesWorkbench client={client} loadState={workspaceLoadState} state={state} updateWorkspaceData={updateWorkspaceData} />
          )}
        </Suspense>
      </div>
    </aside>
  );
}
