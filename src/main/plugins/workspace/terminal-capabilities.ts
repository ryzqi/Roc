import type {
  TerminalSessionCloseRequest,
  TerminalSessionCreateRequest,
  TerminalSessionInputRequest,
  TerminalSessionResizeRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { TerminalSessionService } from '../../services/terminal-session-service';

const pluginId = '@roc/plugin-workspace';
export const terminalSessionOutputEventType = 'terminal.session.output';
export const terminalSessionExitEventType = 'terminal.session.exit';

export function registerTerminalCapabilities(
  context: RocPluginContext,
  descriptors: readonly CapabilityDescriptor[],
  terminalService: TerminalSessionService
): void {
  context.capabilities.register(pluginId, descriptors[0], async (input) =>
    terminalService.createSession(input as TerminalSessionCreateRequest)
  );
  context.capabilities.register(pluginId, descriptors[1], async (input) =>
    terminalService.writeInput(input as TerminalSessionInputRequest)
  );
  context.capabilities.register(pluginId, descriptors[2], async (input) =>
    terminalService.resize(input as TerminalSessionResizeRequest)
  );
  context.capabilities.register(pluginId, descriptors[3], async (input) =>
    terminalService.closeSession(input as TerminalSessionCloseRequest)
  );
}
