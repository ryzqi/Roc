import { ipcChannels } from '../../shared/ipc';
import type { LifecycleService } from '../services/lifecycle-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';
import type { AppWindowControls } from './register-ipc';

export function registerLifecycleIpc(
  timedHandle: TimedHandle,
  lifecycleService: LifecycleService,
  controls: Pick<AppWindowControls, 'broadcastTaskUpdated'>
): void {
  timedHandle(ipcChannels.lifecycleGetTraySummary, () => wrapIpc(() => lifecycleService.getTraySummary()));
  timedHandle(ipcChannels.lifecyclePauseBackground, () =>
    wrapIpc(() => {
      const summary = lifecycleService.pauseBackgroundExecution();
      controls.broadcastTaskUpdated();
      return summary;
    })
  );
  timedHandle(ipcChannels.lifecycleResumeBackground, () =>
    wrapIpc(() => {
      const summary = lifecycleService.resumeBackgroundExecution();
      controls.broadcastTaskUpdated();
      return summary;
    })
  );
}
