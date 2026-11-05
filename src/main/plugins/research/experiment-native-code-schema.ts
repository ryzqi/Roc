import { z } from 'zod';
import { researchContentHash } from './research-files';

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
export const nativeCodeReceiptSchema = z.strictObject({
  code: nativeCodeSnapshotSchema,
  metadataIdentity: z.strictObject({
    inspectionContractVersion: z.literal(4), executable: digest, code: digest,
    metadata: z.array(z.strictObject({ path: absolutePath, sha256: digest })).max(10000), bridge: digest.nullable()
  })
});
export const nativeCodeReportSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string().min(1), projectId: z.string().min(1),
  inputHash: digest, environmentHash: digest, native: nativeCodeReceiptSchema
});
export type NativeCodeSnapshot = z.infer<typeof nativeCodeSnapshotSchema>;
export type NativeCodeEntry = NativeCodeSnapshot['entries'][number];
export type NativeCodeReceipt = z.infer<typeof nativeCodeReceiptSchema>;

export function assertNativeCodeReceipt(value: unknown, metadataHash: string): NativeCodeReceipt {
  const receipt = nativeCodeReceiptSchema.parse(value);
  const { hash, ...body } = receipt.code;
  if (researchContentHash(JSON.stringify(body)) !== hash || receipt.metadataIdentity.code !== hash
    || researchContentHash(JSON.stringify(receipt.metadataIdentity)) !== metadataHash) {
    throw new Error('research_experiment_native_code_report_changed');
  }
  return receipt;
}
