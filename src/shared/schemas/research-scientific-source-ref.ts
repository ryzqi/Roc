import {z} from 'zod';
import {paperIrIdentitySchema, paperIrArtifactSchema} from './research-paper-ir-v2';
import {researchSourceLocatorSchema} from './research-source-locator';

/** Original IR objects, independent of retrieval chunks and extracted entity names. */
export const scientificSourceObjectTypeSchema = z.enum([
  'block', 'section', 'table', 'table_cell', 'figure', 'equation', 'algorithm', 'algorithm_step', 'citation', 'reference'
]);

/** A projection of an existing index receipt, never a new source or publication identity. */
export const scientificSourceRefSchema = paperIrIdentitySchema.extend({
  paperIrHash: paperIrArtifactSchema.shape.sha256,
  generationId: z.string().min(1).max(2048),
  objectId: z.string().min(1).max(2048),
  objectType: scientificSourceObjectTypeSchema,
  locator: researchSourceLocatorSchema
}).strict().superRefine((value, context) => {
  for (const key of ['documentId', 'parseId', 'knowledgeDocumentId', 'sourceHash', 'parseHash', 'parserFingerprint'] as const) {
    if (value[key] !== value.locator[key]) context.addIssue({code: 'custom',
      path: ['locator', key], message: 'research_scientific_source_ref_identity_invalid'});
  }
  if (value.locator.objectId !== value.objectId) context.addIssue({code: 'custom',
    path: ['locator', 'objectId'], message: 'research_scientific_source_ref_object_invalid'});
});

export type ScientificSourceRef = z.infer<typeof scientificSourceRefSchema>;
export type ScientificSourceObjectType = z.infer<typeof scientificSourceObjectTypeSchema>;
