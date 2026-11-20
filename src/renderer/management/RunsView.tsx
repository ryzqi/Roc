import { useManagement } from './management-scope';
import { TasksSectionContent } from './management-shell-parts';

export function RunsView(): React.JSX.Element {
  const scope = useManagement();
  return (
    <section className="management-body px-4 py-3" aria-label="会话与任务" data-testid="canvas-runs">
      <TasksSectionContent scope={scope} canvasView="runs" testIdPrefix="canvas" />
    </section>
  );
}
