import {z} from 'zod';
import {researchCitationKeySchema} from './research-library';

export const zoteroCitationKeyMappingSchema = z.object({
  candidates: z.array(z.object({
    origin: z.enum(['native', 'csl', 'extra']), value: z.string(), valid: z.boolean()
  }).strict()),
  sourceKey: researchCitationKeySchema.nullable(),
  localKey: researchCitationKeySchema.nullable(),
  selection: z.enum(['source', 'existing', 'generated']),
  issues: z.array(z.enum(['invalid_source_key', 'source_disagreement', 'key_collision', 'local_key_retained']))
}).strict();
export type ZoteroCitationKeyMapping = z.infer<typeof zoteroCitationKeyMappingSchema>;
