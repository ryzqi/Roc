import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { AppService } from '../services/app-service';
import type { AppWindowControls } from './register-ipc';
import type { TimedHandle } from './ipc-common';

export function registerAppIpc(timedHandle: TimedHandle, appService: AppService, controls: AppWindowControls): void {
  timedHandle(ipcChannels.appGetStatus, () => wrapIpc(() => appService.getStatus()));
  timedHandle(ipcChannels.appOpenSettings, () =>
    wrapIpc(() => {
      controls.openMainPage('settings');
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.appOpenMainPage, (_event, page: string) =>
    wrapIpc(() => {
      controls.openMainPage(page);
      return { opened: true as const, page };
    })
  );
  timedHandle(ipcChannels.appOpenQuickEntry, () =>
    wrapIpc(async () => {
      await controls.openQuickEntry();
      return { opened: true as const };
    })
  );
  timedHandle(ipcChannels.appOpenTrayEntry, () =>
    wrapIpc(async () => {
      await controls.openTrayEntry();
      return { opened: true as const };
    })
  );
}
