import type { z } from 'zod';

import {
  ipcResultSchema,
  rocErrorCategorySchema,
  rocErrorSchema,
  rocPathsSnapshotSchema,
  rocRunModeSchema,
  serviceStatusSchema
} from '../schemas/ipc-core';

export type RocRunMode = z.infer<typeof rocRunModeSchema>;
export type RocErrorCategory = z.infer<typeof rocErrorCategorySchema>;
export type RocError = z.infer<typeof rocErrorSchema>;

type IpcResultSchema<T> = ReturnType<typeof ipcResultSchema<z.ZodType<T>>>;
export type IpcResult<T> = z.infer<IpcResultSchema<T>>;

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type RocPathsSnapshot = z.infer<typeof rocPathsSnapshotSchema>;
