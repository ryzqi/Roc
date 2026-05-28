import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { TerminalSessionService } from '../services/terminal-session-service';
import type { TimedHandle } from './ipc-common';

export function registerTerminalIpc(timedHandle: TimedHandle, terminalSessionService: TerminalSessionService): void {
  timedHandle(ipcChannels.terminalCreateSession, (_event, request) =>
    wrapIpc(() => terminalSessionService.createSession(request))
  );
  timedHandle(ipcChannels.terminalWriteInput, (_event, request) =>
    wrapIpc(() => terminalSessionService.writeInput(request))
  );
  timedHandle(ipcChannels.terminalResize, (_event, request) => wrapIpc(() => terminalSessionService.resize(request)));
  timedHandle(ipcChannels.terminalCloseSession, (_event, request) =>
    wrapIpc(() => terminalSessionService.closeSession(request))
  );
}
