import type { z } from 'zod';

import type {
  terminalSessionAttachmentSchema,
  terminalSessionAttachRequestSchema,
  terminalSessionDetachRequestSchema,
  terminalSessionCloseRequestSchema,
  terminalSessionCreateRequestSchema,
  terminalSessionExitEventSchema,
  terminalSessionInputRequestSchema,
  terminalSessionOutputEventSchema,
  terminalSessionResizeRequestSchema,
  terminalSessionSnapshotSchema
} from '../schemas/ipc-workspace';

export type TerminalSessionSnapshot = z.infer<typeof terminalSessionSnapshotSchema>;
export type TerminalSessionAttachment = z.infer<typeof terminalSessionAttachmentSchema>;
export type TerminalSessionAttachRequest = z.infer<typeof terminalSessionAttachRequestSchema>;
export type TerminalSessionDetachRequest = z.infer<typeof terminalSessionDetachRequestSchema>;
export type TerminalSessionCreateRequest = z.infer<typeof terminalSessionCreateRequestSchema>;
export type TerminalSessionInputRequest = z.infer<typeof terminalSessionInputRequestSchema>;
export type TerminalSessionResizeRequest = z.infer<typeof terminalSessionResizeRequestSchema>;
export type TerminalSessionCloseRequest = z.infer<typeof terminalSessionCloseRequestSchema>;
export type TerminalSessionOutputEvent = z.infer<typeof terminalSessionOutputEventSchema>;
export type TerminalSessionExitEvent = z.infer<typeof terminalSessionExitEventSchema>;
