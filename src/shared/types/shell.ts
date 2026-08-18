import type { z } from 'zod';

import {
  shellConfirmationRequestSchema,
  shellConfirmationResultSchema
} from '../schemas/ipc-workspace';

export type ShellConfirmationRequest = z.infer<typeof shellConfirmationRequestSchema>;
export type ShellConfirmationResult = z.infer<typeof shellConfirmationResultSchema>;
