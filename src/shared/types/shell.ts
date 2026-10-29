import type { z } from 'zod';

import type {
  shellConfirmationRequestSchema,
  shellConfirmationResultSchema
} from '../schemas/ipc-workspace';

export type ShellConfirmationRequest = z.infer<typeof shellConfirmationRequestSchema>;
export type ShellConfirmationResult = z.infer<typeof shellConfirmationResultSchema>;
