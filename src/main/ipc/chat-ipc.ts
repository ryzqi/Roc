import { ipcChannels } from '../../shared/ipc';
import type { DeepAgentRuntimeService } from '../services/deep-agent-runtime-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export function registerChatIpc(timedHandle: TimedHandle, deepAgentRuntimeService: DeepAgentRuntimeService): void {
  timedHandle(ipcChannels.chatStartRun, (_event, request) => wrapIpc(() => deepAgentRuntimeService.startRun(request)));
  timedHandle(ipcChannels.chatCancelRun, (_event, runId: string) =>
    wrapIpc(() => deepAgentRuntimeService.cancelRun(runId))
  );
  timedHandle(ipcChannels.chatResumeRun, (_event, request) => wrapIpc(() => deepAgentRuntimeService.resumeRun(request)));
}
