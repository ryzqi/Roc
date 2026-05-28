import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { McpService } from '../services/mcp-service';
import type { TimedHandle } from './ipc-common';

export function registerMcpIpc(timedHandle: TimedHandle, mcpService: McpService): void {
  timedHandle(ipcChannels.mcpListServers, () => wrapIpc(() => mcpService.listServers()));
  timedHandle(ipcChannels.mcpEnsureExaPreset, () => wrapIpc(() => mcpService.ensureExaPreset()));
  timedHandle(ipcChannels.mcpUpsertServer, (_event, server) => wrapIpc(() => mcpService.upsertServer(server)));
  timedHandle(ipcChannels.mcpSetServerEnabled, (_event, request) =>
    wrapIpc(() => mcpService.setServerEnabled(request.id, request.enabled))
  );
  timedHandle(ipcChannels.mcpDeleteServer, (_event, id: string) =>
    wrapIpc(() => {
      mcpService.deleteServer(id);
      return { deleted: true as const };
    })
  );
  timedHandle(ipcChannels.mcpTestServer, (_event, id: string) => wrapIpc(() => mcpService.testServer(id)));
}
