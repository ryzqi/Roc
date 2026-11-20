import type { z } from 'zod';

import type {
  ipcResultSchema,
  rocErrorCategorySchema,
  rocErrorSchema,
  rocPathsSnapshotSchema
} from '../schemas/ipc-core';

export type RocErrorCategory = z.infer<typeof rocErrorCategorySchema>;
export type RocError = z.infer<typeof rocErrorSchema>;

type IpcResultSchema<T> = ReturnType<typeof ipcResultSchema<z.ZodType<T>>>;
export type IpcResult<T> = z.infer<IpcResultSchema<T>>;
export type RocPathsSnapshot = z.infer<typeof rocPathsSnapshotSchema>;
