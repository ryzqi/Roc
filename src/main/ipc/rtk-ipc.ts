import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { RtkService } from '../services/rtk-service';
import type { TimedHandle } from './ipc-common';

export function registerRtkIpc(timedHandle: TimedHandle, rtkService: RtkService): void {
  timedHandle(ipcChannels.rtkStatus, () => wrapIpc(() => rtkService.getStatus()));
}
