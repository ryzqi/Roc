import type { z } from 'zod';

import {
  terminalSessionCloseRequestSchema,
  terminalSessionCreateRequestSchema,
  terminalSessionExitEventSchema,
  terminalSessionInputRequestSchema,
  terminalSessionOutputEventSchema,
  terminalSessionResizeRequestSchema,
  terminalSessionSnapshotSchema
} from '../schemas/ipc-workspace';

export type TerminalSessionSnapshot = z.infer<typeof terminalSessionSnapshotSchema>;
export type TerminalSessionId = TerminalSessionSnapshot['id'];
export type TerminalSessionStatus = TerminalSessionSnapshot['status'];
export type TerminalSessionCreateRequest = z.infer<typeof terminalSessionCreateRequestSchema>;
export type TerminalSessionInputRequest = z.infer<typeof terminalSessionInputRequestSchema>;
export type TerminalSessionResizeRequest = z.infer<typeof terminalSessionResizeRequestSchema>;
export type TerminalSessionCloseRequest = z.infer<typeof terminalSessionCloseRequestSchema>;
export type TerminalSessionOutputEvent = z.infer<typeof terminalSessionOutputEventSchema>;
export type TerminalSessionExitEvent = z.infer<typeof terminalSessionExitEventSchema>;
