import {z} from 'zod';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchReviewLinkTargetSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('protocol'), versionId: id, expectedVersionHash: hash, expectedFreezeHash: hash.nullable()}).strict(),
  z.object({kind: z.literal('query'), reviewSearchId: id, expectedSnapshotHash: hash}).strict(),
  z.object({kind: z.literal('corpus'), corpusId: id, expectedCorpusHash: hash}).strict(),
  z.object({kind: z.literal('report'), corpusId: id, expectedBodyHash: hash}).strict()
]);
export const researchReviewLinkSchema = z.object({
  projectId: id, title: id, target: researchReviewLinkTargetSchema
}).strict();
export const researchReviewLinksSchema = researchReviewLinkSchema.array().min(1).max(3)
  .refine(links => new Set(links.map(link => JSON.stringify([link.projectId, link.target]))).size === links.length,
    'review_links_duplicate');
export type ResearchReviewLink = z.infer<typeof researchReviewLinkSchema>;
export type ResearchReviewLinksArtifact = {kind: 'roc_review_receipt_links'; links: ResearchReviewLink[]};

/** Only explicit structured metadata is navigable; previews and prose carry no receipt identity. */
export function reviewLinksPayload(output: unknown): unknown {
  if (typeof output !== 'object' || output === null) return undefined;
  if ('reviewLinks' in output) return output.reviewLinks;
  const artifact = 'artifact' in output ? output.artifact : null;
  return typeof artifact === 'object' && artifact !== null && 'kind' in artifact &&
    artifact.kind === 'roc_review_receipt_links' && 'links' in artifact ? artifact.links : undefined;
}
