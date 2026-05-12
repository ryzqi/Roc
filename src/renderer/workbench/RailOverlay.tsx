import type { ViewId, WorkbenchTool } from '../app/types';
import { WORKBENCH_TOOLS } from '../app/view-routing';
import { PreviewIcon } from '../components/PreviewIcon';

export function RailOverlay({
  activeTool,
  activeView,
  workbenchVisible,
  onOpenToolView
}: {
  activeTool: WorkbenchTool;
  activeView: ViewId;
  workbenchVisible: boolean;
  onOpenToolView: (tool: WorkbenchTool) => void;
}): React.JSX.Element {
  return (
    <aside className={activeView === 'chat' ? 'rail-overlay rail-overlay--chat' : 'rail-overlay'}>
      <div className={activeView === 'chat' ? 'rail rail--chat' : 'rail'}>
        {WORKBENCH_TOOLS.map((tool) => {
          return (
            <button
              aria-label={tool.label}
              aria-pressed={activeView === 'chat' && workbenchVisible && activeTool === tool.id}
              className="rail-button"
              data-tool-button={tool.id}
              key={tool.id}
              type="button"
              onClick={() => onOpenToolView(tool.id)}
            >
              <PreviewIcon name={tool.icon} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
