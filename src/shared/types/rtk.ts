import type { z } from 'zod';

import {
  rtkStatusSchema,
  shellExecutionRequestSchema,
  shellExecutionResultSchema
} from '../schemas/ipc-workspace';

export type RtkStatus = z.infer<typeof rtkStatusSchema>;
export type RtkBypassReason = NonNullable<RtkStatus['bypassReason']>;
export type ShellExecutionRequest = z.infer<typeof shellExecutionRequestSchema>;
export type ShellCommandSource = ShellExecutionRequest['source'];
export type ShellExecutionResult = z.infer<typeof shellExecutionResultSchema>;
