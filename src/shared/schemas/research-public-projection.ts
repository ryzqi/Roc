import {z} from 'zod';
import {researchExportFileSchema} from './research-export-file';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchPublicOmissionReasonSchema = z.enum(['native_path', 'credential', 'private_url', 'private_key', 'verification_claim']);
export type ResearchPublicOmissionReason = z.infer<typeof researchPublicOmissionReasonSchema>;

/** Recognized private values must be omitted explicitly, never presented as the original receipt. */
export function researchPrivateValueReason(value: string): ResearchPublicOmissionReason | null {
  if (/(?:file:\/\/|^\/[^\s/\p{C}\uFFFD]+$|(?:^|[\s"'(=:])\/[A-Za-z0-9_.~-][^\s"'<>)\p{C}\uFFFD]*\/[^\s"'<>)\p{C}\uFFFD]+(?=$|[\s"'<>)])|(?:^|[\s"'(=:])[A-Za-z]:[\\/])/iu.test(value)) {
    return 'native_path';
  }
  if (/(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]|\bBearer\s+\S+|\b(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]+/iu.test(value)) {
    return 'credential';
  }
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>()]+/giu)) {
    const url = new URL(match[0]);
    if (url.username || url.password || url.search || url.hash) return 'private_url';
  }
  return null;
}

export const researchPublicProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verification: z.literal('public_projection'),
  originalSha256: digest,
  projectionSha256: digest,
  omittedFields: z.array(z.strictObject({
    pointer: z.string().max(8192),
    reason: researchPublicOmissionReasonSchema
  })).max(100000),
  value: z.json()
});
export type ResearchPublicProjection = z.infer<typeof researchPublicProjectionSchema>;

export const researchPublicFileProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1), verification: z.literal('public_file_projection'),
  originalFile: researchExportFileSchema,
  projection: researchPublicProjectionSchema
});
