import { z } from 'zod';

export const nativeCodeLimits = { maxFileBytes: 512 * 1024 ** 2, maxTotalBytes: 4 * 1024 ** 3, maxEntries: 100000, maxMetadataBytes: 64 * 1024 ** 2 } as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePath = z.string().min(1).max(4096).startsWith('/');
const entryFields = { root: absolutePath, path: z.string().max(4096), mode: z.number().int().min(0).max(0o7777) };
const entry = z.discriminatedUnion('type', [
  z.strictObject({ ...entryFields, type: z.literal('directory') }),
  z.strictObject({ ...entryFields, type: z.literal('symlink'), target: z.string().min(1).max(4096), resolved: absolutePath }),
  z.strictObject({ ...entryFields, type: z.literal('file'), size: z.number().int().min(0).max(nativeCodeLimits.maxFileBytes), sha256: digest })
]);
export const nativeCodeSnapshotSchema = z.strictObject({
  contractVersion: z.literal(1),
  limits: z.strictObject({
    maxFileBytes: z.literal(nativeCodeLimits.maxFileBytes), maxTotalBytes: z.literal(nativeCodeLimits.maxTotalBytes),
    maxEntries: z.literal(nativeCodeLimits.maxEntries), maxMetadataBytes: z.literal(nativeCodeLimits.maxMetadataBytes)
  }),
  roots: z.array(absolutePath).min(1).max(10002),
  entries: z.array(entry).min(1).max(nativeCodeLimits.maxEntries),
  hash: digest
});
export type NativeCodeSnapshot = z.infer<typeof nativeCodeSnapshotSchema>;
export type NativeCodeEntry = NativeCodeSnapshot['entries'][number];
