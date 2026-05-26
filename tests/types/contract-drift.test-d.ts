import { expectTypeOf } from 'vitest';
import type { z } from 'zod';
import type { BackgroundTaskPreviewRequest } from '../../src/shared/types';
import { proposeInputSchema } from '../../src/main/services/deep-agent/background-task-tools';

type Inferred = z.infer<typeof proposeInputSchema>;

expectTypeOf<Inferred['trigger']>().toEqualTypeOf<BackgroundTaskPreviewRequest['trigger']>();
expectTypeOf<Inferred['workspacePath']>().toEqualTypeOf<BackgroundTaskPreviewRequest['workspacePath']>();
expectTypeOf<Inferred['goal']>().toEqualTypeOf<BackgroundTaskPreviewRequest['goal']>();
