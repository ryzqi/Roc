import {z} from 'zod';
export const researchStorageRequestSchema = z.strictObject({projectId: z.string().min(1).max(256)});
export const researchStorageTypeSchema = z.enum(['source', 'ocr', 'index', 'experiment', 'figure', 'export', 'model', 'other']);
export const researchStorageRetentionSchema = z.enum(['cache', 'approved_artifact', 'traceable_source', 'retained_record', 'unclassified']);
const bytes = z.number().int().nonnegative();
export const researchStorageUsageSchema = z.strictObject({
  contractVersion: z.literal(1), projectId: z.string(), observedAt: z.iso.datetime(),
  roots: z.array(z.strictObject({kind: z.enum(['library', 'index', 'experiment', 'export', 'model', 'resource']),
    state: z.enum(['scanned', 'missing', 'unconfigured'])})),
  groups: z.array(z.strictObject({type: researchStorageTypeSchema, retention: researchStorageRetentionSchema,
    scope: z.enum(['project', 'shared', 'unattributed']), files: bytes, bytes, allocatedBytes: bytes})),
  logicalIndex: z.strictObject({chunks: bytes, contentBytes: bytes, embeddingBytes: bytes}),
  accounting: z.literal('unique_inode_per_group; shared_project_references_are_not_additive; stat_blocks_not_exclusive_APFS_usage'),
  deletion: z.literal('none')
});
export type ResearchStorageUsage = z.infer<typeof researchStorageUsageSchema>;
