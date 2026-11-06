import {z} from 'zod';
import {researchStageSchema, researchArtifactKindSchema} from './research';

const id = z.string().regex(/^[a-z][a-z0-9-]*$/u).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const resourcePath = z.string().max(200).regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/u);
const resource = z.object({path: resourcePath, hash}).strict();
const capability = z.string().regex(/^research\.[A-Za-z]+(?:\.[A-Za-z]+)+$/u);
const uniqueCapabilities = z.array(capability).max(100).refine(values => new Set(values).size === values.length);

export const researchSkillManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id, version: z.string().regex(/^\d+\.\d+\.\d+$/u), stage: researchStageSchema,
  description: z.string().trim().min(1).max(500),
  entry: resource, references: z.array(resource).max(20),
  license: z.object({
    id: z.enum(['LicenseRef-Roc-Internal', 'MIT', 'Apache-2.0', 'CC-BY-NC-4.0']),
    resource
  }).strict(),
  source: z.object({kind: z.enum(['project', 'third_party']), origin: z.string().min(1).max(500),
    revision: z.string().min(1).max(128), hash}).strict(),
  inputs: z.object({schema: z.literal('researchStageRunStartRequest/v1'), hash}).strict(),
  outputs: z.object({schema: z.literal('researchStageOutput/v1'), hash, artifactKind: researchArtifactKindSchema}).strict(),
  requiredCapabilities: uniqueCapabilities,
  forbiddenEffects: z.array(z.enum(['human_approval', 'final_delivery', 'permission_change', 'host_execution',
    'evidence_write', 'workspace_write', 'production_execute'])).min(1),
  qualityGates: z.array(z.string().min(1).max(300)).min(1).max(20),
  evalCases: z.array(resource).min(1).max(20),
  runtimeContract: z.literal('roc-research-stage/v2')
}).strict().superRefine((value, ctx) => {
  const paths = [value.entry.path, value.license.resource.path, ...value.references.map(entry => entry.path), ...value.evalCases.map(entry => entry.path)];
  if (new Set(paths).size !== paths.length) ctx.addIssue({code: 'custom', message: 'research_skill_resources_duplicate'});
  if (value.source.hash !== value.entry.hash) ctx.addIssue({code: 'custom', message: 'research_skill_source_hash_mismatch'});
  if (value.license.id === 'LicenseRef-Roc-Internal' && value.source.kind !== 'project') {
    ctx.addIssue({code: 'custom', message: 'research_skill_internal_license_requires_project_origin'});
  }
});

export const researchSkillPinSchema = z.object({
  id, stage: researchStageSchema, version: z.string().min(1), manifestHash: hash,
  runtimeContract: z.literal('roc-research-stage/v2')
}).strict();
export type ResearchSkillManifest = z.infer<typeof researchSkillManifestSchema>;
export type ResearchSkillPin = z.infer<typeof researchSkillPinSchema>;
