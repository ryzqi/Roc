import {z} from 'zod';
import {researchContentHash} from './research-files';
import {scientificKnowledgeCandidatesSchema} from '../../../shared/schemas/research-scientific-extraction';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const scientificBatchReceiptSchema = z.object({
  jobId: z.string().min(1), inputHash: hash, batchId: z.string().min(1),
  stage: z.enum(['entities', 'facts', 'relations', 'deep']), modelRevision: hash,
  dependencyHash: hash, outputHash: hash, validationStatus: z.literal('source_validated'),
  reusedFromJobId: z.string().min(1).optional(),
  // Batch deltas only. Original objects and prior candidates are reconstructed and revalidated on replay.
  output: scientificKnowledgeCandidatesSchema
}).strict();
export const scientificBatchReceiptsSchema = z.object({
  version: z.literal('roc-scientific-batch-receipts/1'),
  receipts: z.array(scientificBatchReceiptSchema).max(2048)
}).strict();
export type ScientificBatchReceipt = z.infer<typeof scientificBatchReceiptSchema>;
export type ScientificBatchCheckpoint = {
  read: () => ScientificBatchReceipt[];
  write: (receipt: ScientificBatchReceipt) => void;
};

/** Field order can change during schema parsing; content identity must not. */
export function scientificBatchHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)])) : item;
  return researchContentHash(JSON.stringify(canonical(value)));
}
