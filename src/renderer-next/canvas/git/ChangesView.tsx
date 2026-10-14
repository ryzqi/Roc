import { useWorkspaceScope } from '../../app/workspace-scope';
import { GitPanel } from './GitPanel';

/**
 * The canvas `changes` view (P3/T3.5).
 *
 * Same `GitPanel` as the top-bar drawer, in its wide two-pane layout. The view
 * exists because the legacy shell routed ⌘-menu "Git" here (`routeForNavigate`
 * maps `page=git` to `view=changes`), and because a change list plus a diff needs
 * more room than a 520px drawer can give.
 */
export function ChangesView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  return (
    <div className="flex h-full min-h-0 flex-col p-3" data-testid="changes-view">
      <GitPanel
        client={scope.client}
        workspacePath={scope.workspacePath}
        writable={scope.writable}
        layout="canvas"
      />
    </div>
  );
}
