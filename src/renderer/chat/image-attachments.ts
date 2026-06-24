import type { ChatImageAttachment, ChatImageAttachmentMediaType } from '../../shared/types';
import { parseProviderModelKey } from '../../shared/provider-model-key';
import type { LoadedState } from '../loaded-state';

export type RendererImageAttachment = ChatImageAttachment & {
  previewUrl: string | null;
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
    previewUrl: URL.createObjectURL(file)
  };
}

export function isImageInputSupported(state: LoadedState): boolean {
  if (state.defaultModelId === null) {
    return false;
  }
  const modelKey = parseProviderModelKey(state.defaultModelId);
  if (modelKey === null) {
    return false;
  }
  for (const provider of state.providers) {
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

export function toChatImageAttachments(attachments: readonly RendererImageAttachment[]): ChatImageAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
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
