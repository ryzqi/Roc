import {z} from 'zod';
import {
  hfIdentitySchema, hfMetadataSchema, hfFilePathSchema, hfRevisionSchema,
  type HfIdentity, type HfMetadata
} from '../../../shared/schemas/research-huggingface';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(8192);
const payloadSchema = z.object({
  id: text, sha: hfRevisionSchema, private: z.boolean().nullish(),
  gated: z.union([z.literal(false), z.enum(['auto', 'manual'])]).nullish(),
  disabled: z.boolean().nullish(), lastModified: z.string().datetime().nullish(),
  cardData: z.object({
    license: z.union([text, z.array(text).max(64)]).nullish(), license_name: text.nullish(), license_link: text.nullish()
  }).nullish(),
  siblings: z.array(z.object({
    rfilename: hfFilePathSchema, size: bytes, blobId: hfRevisionSchema,
    lfs: z.object({size: bytes, sha256: z.string().regex(/^[a-f0-9]{64}$/u), pointerSize: bytes}).nullish()
  })).max(10000)
});

export function huggingFaceEndpoint({kind, repo, revision}: HfIdentity): string {
  hfIdentitySchema.parse({kind, repo, revision});
  return `https://huggingface.co/api/${kind === 'model' ? 'models' : 'datasets'}/${repo}/revision/${revision}?blobs=true`;
}

export function readHuggingFaceMetadata({kind, repo, revision}: HfIdentity, payload: unknown): HfMetadata {
  const request = hfIdentitySchema.parse({kind, repo, revision});
  const value = payloadSchema.parse(payload);
  if (value.id !== request.repo || value.sha !== request.revision) throw new Error('literature_provider_response_invalid');
  return hfMetadataSchema.parse({
    ...request, private: value.private ?? null, gated: value.gated ?? null, disabled: value.disabled ?? null,
    lastModified: value.lastModified ?? null, license: value.cardData?.license ?? null,
    licenseName: value.cardData?.license_name ?? null, licenseLink: value.cardData?.license_link ?? null,
    files: value.siblings.map(file => ({path: file.rfilename, size: file.size, blobId: file.blobId, lfs: file.lfs ?? null}))
  });
}
