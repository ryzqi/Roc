import { ipcChannels } from '../../shared/ipc';
import type { MemoryService } from '../services/memory-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export function registerMemoryIpc(timedHandle: TimedHandle, memoryService: MemoryService): void {
  timedHandle(ipcChannels.memoryStatus, () => wrapIpc(() => memoryService.status()));
  timedHandle(ipcChannels.memorySearch, (_event, request) => wrapIpc(() => memoryService.search(request)));
  timedHandle(ipcChannels.memoryGet, (_event, id: string) => wrapIpc(() => memoryService.get(id)));
  timedHandle(ipcChannels.memoryListCandidates, () => wrapIpc(() => memoryService.listCandidates()));
  timedHandle(ipcChannels.memoryListConflicts, () => wrapIpc(() => memoryService.listConflicts()));
  timedHandle(ipcChannels.memoryAcceptCandidate, (_event, id: string) =>
    wrapIpc(() => memoryService.acceptCandidate(id))
  );
  timedHandle(ipcChannels.memoryRejectCandidate, (_event, id: string) =>
    wrapIpc(() => memoryService.rejectCandidate(id))
  );
  timedHandle(ipcChannels.memoryWriteCandidate, (_event, entry) => wrapIpc(() => memoryService.writeCandidate(entry)));
  timedHandle(ipcChannels.memoryWriteSessionRecall, (_event, request) =>
    wrapIpc(() => memoryService.writeSessionRecall(request))
  );
  timedHandle(ipcChannels.memorySessionSearch, (_event, request) => wrapIpc(() => memoryService.sessionSearch(request)));
  timedHandle(ipcChannels.memoryDelete, (_event, id: string) => wrapIpc(() => memoryService.deleteMemory(id)));
  timedHandle(ipcChannels.memoryRestore, (_event, id: string) => wrapIpc(() => memoryService.restoreMemory(id)));
}
