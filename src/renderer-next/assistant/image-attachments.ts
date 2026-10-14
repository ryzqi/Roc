import type { ChatImageAttachment, ChatImageAttachmentMediaType } from '../../shared/types';
import { parseProviderModelKey } from '../../shared/provider-model-key';

/**
 * Image attachments (T4.5).
 *
 * Ported from the legacy shell's `chat/image-attachments.ts` (ADR-M04), with two
 * changes:
 *
 *   1. **No Blob URL.** The legacy version built the preview with
 *      `URL.createObjectURL(file)`. The base64 payload is already computed to send
 *      to the model, so the preview is simply `data:<mediaType>;base64,…` — one fewer
 *      live resource to revoke, and it keeps R9's "no object URLs" property
 *      absolute and greppable instead of "only for project files".
 *   2. **No `LoadedState`.** That type belongs to the legacy shell. This module only
 *      needs the model list, so it takes a narrow structural snapshot that the P4
 *      header can build from `settings.get` (ADR-M02: the renderer derives).
 *
 * The wire contract is `chatImageAttachmentSchema`, which requires **exactly one** of
 * `data` (bytes the renderer read from a paste/drop) or `path` (a file the main
 * process reads) — see the refine in that schema.
 */

export type RendererImageAttachment = ChatImageAttachment & {
  /** A `data:` URL, never a Blob URL. */
  previewUrl: string | null;
};

/** The minimum a caller must supply to answer "can this model see images?". */
export type ImageSupportSnapshot = {
  defaultModelId: string | null;
  providers: ReadonlyArray<{
    id: string;
    models: ReadonlyArray<{ id: string; supportsImages: boolean }>;
  }>;
};

const maxImageAttachments = 4;
const maxImageAttachmentBytes = 5 * 1024 * 1024;
const mediaTypes = new Set<string>(['image/png', 'image/jpeg', 'image/webp']);

export function validateImageAttachmentSelection(items: readonly unknown[]): void {
  if (items.length > maxImageAttachments) {
    throw new Error('chat_image_too_many');
  }
}

export async function createFileImageAttachment(file: File, source: 'clipboard' | 'drop'): Promise<RendererImageAttachment> {
  const mediaType = resolveFileMediaType(file);
  if (mediaType === null) {
    throw new Error('chat_image_unsupported_type');
  }
  if (file.size > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const base64 = await readFileBase64(file);
  return {
    kind: 'image',
    source,
    name: file.name.length === 0 ? 'pasted-image.png' : file.name,
    mediaType,
    sizeBytes: file.size,
    data: base64,
    previewUrl: `data:${mediaType};base64,${base64}`
  };
}

export function isImageInputSupported(snapshot: ImageSupportSnapshot): boolean {
  if (snapshot.defaultModelId === null) {
    return false;
  }
  const modelKey = parseProviderModelKey(snapshot.defaultModelId);
  if (modelKey === null) {
    return false;
  }
  for (const provider of snapshot.providers) {
    if (provider.id !== modelKey.providerId) {
      continue;
    }
    const model = provider.models.find((item) => item.id === modelKey.modelId);
    if (model !== undefined) {
      return model.supportsImages;
    }
  }
  return false;
}

function resolveFileMediaType(file: File): ChatImageAttachmentMediaType | null {
  if (mediaTypes.has(file.type)) {
    return file.type as ChatImageAttachmentMediaType;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) {
    return 'image/png';
  }
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (name.endsWith('.webp')) {
    return 'image/webp';
  }
  return null;
}

async function readFileBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
