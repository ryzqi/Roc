import {z} from 'zod';
import {paperIrArtifactSchema, paperIrV2Schema} from './research-paper-ir-v2';
import {scientificKnowledgeReadRequestSchema, scientificKnowledgeReadSchema} from './research-scientific-extraction';
import {scientificIdSchema} from './research-scientific-facts';

export const paperCardKnowledgeReadRequestSchema = scientificKnowledgeReadRequestSchema;
/** Complete immutable objects, separate from the six reading sections and model prose. */
export const paperCardObjectsSchema = z.object({
  tables: paperIrV2Schema.shape.tables, figures: paperIrV2Schema.shape.figures,
  equations: paperIrV2Schema.shape.equations, algorithms: paperIrV2Schema.shape.algorithms
}).strict();
export const paperCardKnowledgeSchema = scientificKnowledgeReadSchema.extend({
  version: z.literal(2), documentId: scientificIdSchema,
  paperIR: paperIrArtifactSchema.nullable(), objects: paperCardObjectsSchema.nullable(),
  methodComponentIds: z.array(scientificIdSchema).max(500)
}).strict().superRefine((value, context) => {
  const job = value.publishedJob;
  if (job === null ? value.paperIR !== null || value.objects !== null || value.methodComponentIds.length !== 0 :
    value.paperIR === null || value.objects === null ||
    value.documentId !== job.snapshot.source.paperIR.identity.documentId ||
    value.paperIR.sha256 !== job.snapshot.source.paperIR.sha256) {
    context.addIssue({code: 'custom', message: 'wiki_paper_knowledge_binding_invalid'});
  }
  const components = value.knowledge?.facts.filter(fact => fact.factType === 'method_component').map(fact => fact.id) ?? [];
  if (JSON.stringify(components) !== JSON.stringify(value.methodComponentIds)) {
    context.addIssue({code: 'custom', message: 'wiki_paper_method_components_invalid'});
  }
});
export type PaperCardKnowledge = z.infer<typeof paperCardKnowledgeSchema>;
export type PaperCardKnowledgeReadRequest = z.infer<typeof paperCardKnowledgeReadRequestSchema>;
