import {z} from 'zod';
import {researchExportFileSchema} from './research-export-file';
import {researchCrateLicenseSchema, researchCratePublicationSchema, researchPublicTextSchema,
  researchPublicUrlSchema} from './research-ro-crate';

const id = researchPublicTextSchema.max(300);
const sourceFields = {...researchExportFileSchema.shape, id};
export const researchExportResourceSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({...sourceFields, kind: z.literal('experiment'), area: z.enum(['input', 'output'])}),
  z.strictObject({...sourceFields, kind: z.literal('figure'), area: z.enum(['input', 'output'])}),
  z.strictObject({...sourceFields, kind: z.literal('template'), area: z.null()})
]);
const metadataFields = {
  name: researchPublicTextSchema, description: researchPublicTextSchema,
  version: researchPublicTextSchema.nullable(), url: researchPublicUrlSchema.nullable(),
  license: researchCrateLicenseSchema
};
export const researchExportResourceReviewSchema = z.strictObject({
  source: researchExportResourceSourceSchema,
  kind: z.enum(['software', 'dataset', 'result', 'figure']),
  ...metadataFields,
  delivery: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('bundled')}),
    z.strictObject({kind: z.literal('metadata_only'), url: researchPublicUrlSchema.nullable(), instructions: researchPublicTextSchema})
  ])
}).superRefine((value, context) => {
  if (value.kind === 'software' && (value.url === null || value.version === null)) {
    context.addIssue({code: 'custom', message: 'research_export_software_metadata_required'});
  }
});
export const researchExportReferenceReviewSchema = z.strictObject({
  id, ...metadataFields, instructions: researchPublicTextSchema
});
export const researchExportPublicationReviewSchema = z.strictObject({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  publication: researchCratePublicationSchema,
  resources: z.array(researchExportResourceReviewSchema).max(10000),
  references: z.array(researchExportReferenceReviewSchema).max(5000)
}).superRefine((value, context) => {
  const keys = value.resources.map(resource => researchExportResourceKey(resource.source));
  if (new Set(keys).size !== keys.length || new Set(value.references.map(reference => reference.id)).size !== value.references.length) {
    context.addIssue({code: 'custom', message: 'research_export_duplicate_selection'});
  }
});
export const researchExportResourceCandidateSchema = z.strictObject({
  source: researchExportResourceSourceSchema,
  role: z.enum(['program', 'input', 'output', 'figure', 'template']),
  mandatory: z.boolean(),
  reason: researchPublicTextSchema.nullable()
});
export const researchExportInputsSchema = z.strictObject({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  resources: z.array(researchExportResourceCandidateSchema).max(10000),
  // Private source metadata is editable in the review; only the submitted public metadata is constrained.
  references: z.array(z.strictObject({id, name: z.string().min(1).max(8192), url: z.string().max(8192).nullable()})).max(5000)
});

export type ResearchExportResourceSource = z.infer<typeof researchExportResourceSourceSchema>;
export type ResearchExportResourceReview = z.infer<typeof researchExportResourceReviewSchema>;
export type ResearchExportPublicationReview = z.infer<typeof researchExportPublicationReviewSchema>;
export type ResearchExportInputs = z.infer<typeof researchExportInputsSchema>;

export function researchExportResourceKey(source: ResearchExportResourceSource): string {
  return JSON.stringify([source.kind, source.id, source.area, source.path]);
}
