import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { AgentService } from '../services/agent-service';
import type { TimedHandle } from './ipc-common';

export function registerAgentIpc(timedHandle: TimedHandle, agentService: AgentService): void {
  timedHandle(ipcChannels.agentGetStatus, () => wrapIpc(() => agentService.getStatus()));
  timedHandle(ipcChannels.agentGetConfigPreview, () => wrapIpc(() => agentService.getDeepAgentConfigPreview()));
  timedHandle(ipcChannels.agentGetCapabilityPreview, (_event, request) =>
    wrapIpc(() => agentService.getCapabilityPreview(request))
  );
}
