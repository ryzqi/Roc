import type { RocClient } from '../shared/roc-client';
import { WindowActivity } from '../shared/view-activity';
import { useWindowState } from '../shell/use-window-state';
import { AppShellContent } from './AppShellContent';

/** Native-window activity gate plus the renderer shell composition. */
export function AppShell({ client }: { client: RocClient }): React.JSX.Element {
  const windowState = useWindowState(client);
  return (
    <WindowActivity active={!windowState.hidden}>
      <AppShellContent client={client} windowState={windowState} />
    </WindowActivity>
  );
}
