import {z} from 'zod';
import {researchExportFileSchema} from './research-export-file';
import {researchExperimentPathSchema} from './research-experiments';
import {researchPrivateValueReason} from './research-public-projection';

export const researchCrateVersion = '1.2' as const;
export const researchCrateProfile = 'roc-research-1' as const;
export const researchCrateContext = 'https://w3id.org/ro/crate/1.2/context' as const;
export const researchCrateMetadataPath = 'ro-crate-metadata.json' as const;
export const researchCrateProfilePath = 'ro-crate-profile.html' as const;

// Public fields are a separate contract. Reject private values instead of silently rewriting them.
export const researchPublicTextSchema = z.string().trim().min(1).max(16000).refine(value =>
  researchPrivateValueReason(value) === null,
{message: 'research_export_private_metadata'});
export const researchPublicUrlSchema = z.string().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch { return false; }
}, {message: 'research_export_public_url_invalid'});
const id = researchPublicTextSchema.max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchCrateLicenseSchema = z.strictObject({
  name: researchPublicTextSchema, description: researchPublicTextSchema, url: researchPublicUrlSchema.nullable()
});
export const researchCratePublicationSchema = z.strictObject({
  profile: z.literal(researchCrateProfile), version: z.literal(researchCrateVersion),
  name: researchPublicTextSchema, description: researchPublicTextSchema,
  datePublished: z.iso.date(),
  authors: z.array(z.strictObject({
    name: researchPublicTextSchema,
    orcid: z.string().regex(/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/u).nullable()
  })).min(1).max(100),
  license: researchCrateLicenseSchema
});
export const researchCrateWorkSchema = z.strictObject({
  id, kind: z.enum(['manuscript', 'dataset', 'software', 'figure', 'result', 'reference']),
  name: researchPublicTextSchema, description: researchPublicTextSchema,
  version: researchPublicTextSchema.nullable(), url: researchPublicUrlSchema.nullable(), license: researchCrateLicenseSchema,
  delivery: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('bundled'), paths: z.array(researchExperimentPathSchema).min(1).max(10000)}),
    z.strictObject({kind: z.literal('metadata_only'), url: researchPublicUrlSchema.nullable(), instructions: researchPublicTextSchema})
  ]),
  basedOn: z.array(id).max(1000)
});
const property = z.strictObject({
  name: researchPublicTextSchema.refine(value => !/^(?:api[_-]?key|access[_-]?token|authorization|password|secret)$/iu.test(value),
    {message: 'research_export_private_metadata'}),
  value: researchPublicTextSchema
});
export const researchCrateActivitySchema = z.strictObject({
  id, name: researchPublicTextSchema, status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.iso.datetime().nullable(), endedAt: z.iso.datetime().nullable(),
  inputs: z.array(id).max(1000), outputs: z.array(id).max(1000), software: id,
  environment: z.strictObject({
    hash, version: researchPublicTextSchema,
    packages: z.array(property).max(10000)
  }),
  parameters: z.array(property).max(1000), seed: z.number().int().nonnegative().nullable(),
  cost: z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('known'), microusd: z.number().int().nonnegative()}),
    z.strictObject({kind: z.literal('unknown'), reason: researchPublicTextSchema})
  ])
});
export const researchCrateInputSchema = z.strictObject({
  publication: researchCratePublicationSchema,
  files: z.array(researchExportFileSchema).min(1).max(10000),
  works: z.array(researchCrateWorkSchema).min(1).max(5000),
  activities: z.array(researchCrateActivitySchema).max(1000),
  approvals: z.array(z.strictObject({
    artifactId: id, artifactVersion: hash, workId: id, recordedAt: z.iso.datetime(), reviewPath: researchExperimentPathSchema
  })).min(1).max(1000)
}).superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({code: 'custom', message});
  const paths = new Set(value.files.map(file => file.path));
  const works = new Map(value.works.map(work => [work.id, work]));
  if (paths.size !== value.files.length ||
    new Set(value.files.map(file => file.path.normalize('NFC').toLowerCase())).size !== value.files.length || works.size !== value.works.length ||
    new Set(value.activities.map(activity => activity.id)).size !== value.activities.length) fail('research_crate_duplicate_entity');
  const nodeCount = 9 + value.publication.authors.length + value.files.length + value.works.length * 2 +
    value.approvals.length + value.activities.reduce((count, activity) =>
      count + 5 + activity.environment.packages.length + activity.parameters.length, 0);
  if (nodeCount > 50000) fail('research_crate_entity_limit');
  if (!paths.has(researchCrateProfilePath)) fail('research_crate_profile_missing');
  if (value.works.filter(work => work.kind === 'manuscript').length !== 1) fail('research_crate_manuscript_required');
  for (const work of value.works) {
    if (work.delivery.kind === 'bundled' && (new Set(work.delivery.paths).size !== work.delivery.paths.length ||
      work.delivery.paths.some(path => !paths.has(path)))) fail('research_crate_file_missing');
    if (work.basedOn.some(id => !works.has(id) || id === work.id)) fail('research_crate_reference_missing');
    if (work.kind === 'manuscript' && work.delivery.kind !== 'bundled') fail('research_crate_manuscript_required');
    if (work.kind === 'reference' && work.delivery.kind !== 'metadata_only') fail('research_crate_reference_metadata_only');
    if (work.kind === 'software' && (work.version === null || work.url === null)) fail('research_crate_software_metadata_required');
  }
  for (const activity of value.activities) {
    if ([...activity.inputs, ...activity.outputs].some(id => !works.has(id)) ||
      works.get(activity.software)?.kind !== 'software') fail('research_crate_reference_missing');
  }
  for (const approval of value.approvals) {
    if (!works.has(approval.workId) || !paths.has(approval.reviewPath)) fail('research_crate_approval_missing');
  }
  const manuscript = value.works.find(work => work.kind === 'manuscript');
  if (!value.approvals.some(approval => approval.workId === manuscript?.id)) fail('research_crate_approval_missing');
  if (paths.has(researchCrateMetadataPath) || paths.has('manifest.json')) fail('research_crate_generation_order');
});

export type ResearchCrateInput = z.infer<typeof researchCrateInputSchema>;
