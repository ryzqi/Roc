import { ipcChannels } from '../../shared/ipc';
import type { MemoryService } from '../services/memory-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export function registerMemoryIpc(timedHandle: TimedHandle, memoryService: MemoryService): void {
  timedHandle(ipcChannels.memoryStatus, () => wrapIpc(() => memoryService.status()));
}
