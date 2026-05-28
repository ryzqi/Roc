import { ipcChannels } from '../../shared/ipc';
import { renderFrozenSnapshot } from '../services/memory/snapshot';
import type { SessionArchiveService } from '../services/memory/session-archive';
import type { MemoryService } from '../services/memory-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export function registerMemoryIpc(
  timedHandle: TimedHandle,
  memoryService: MemoryService,
  sessionArchiveService: SessionArchiveService
): void {
  timedHandle(ipcChannels.memoryStatus, () => wrapIpc(() => memoryService.status()));
  timedHandle(ipcChannels.memoryReadFile, (_event, input) => wrapIpc(() => memoryService.readFile(input)));
  timedHandle(ipcChannels.memoryWriteFile, (_event, request) => wrapIpc(() => memoryService.writeFile(request)));
  timedHandle(ipcChannels.memorySnapshotPreview, () =>
    wrapIpc(() => ({
      text: renderFrozenSnapshot(memoryService.buildSnapshotForCurrentWorkspace())
    }))
  );
  timedHandle(ipcChannels.sessionMessagesList, (_event, input: { threadId: string; limit?: number }) =>
    wrapIpc(() => sessionArchiveService.list(input.threadId, input.limit === undefined ? 200 : input.limit))
  );
  timedHandle(ipcChannels.sessionMessagesSearch, (_event, request) =>
    wrapIpc(() => sessionArchiveService.search(request))
  );
}
