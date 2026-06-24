import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import type {
  ChatImageAttachment,
  ChatImageAttachmentMediaType,
  ChatPersistedAttachment,
  ChatValidatedImageAttachment
} from '../../../shared/types';
import { chatImageAttachmentMediaTypes } from '../../../shared/types';

const maxImageAttachments = 4;
const maxImageAttachmentBytes = 5 * 1024 * 1024;
const mediaTypes = new Set<ChatImageAttachmentMediaType>(chatImageAttachmentMediaTypes);
const extensionMediaTypes = new Map<string, ChatImageAttachmentMediaType>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

export type ChatPreparedImageAttachments = {
  metadata: ChatPersistedAttachment[];
  images: ChatValidatedImageAttachment[];
};

export function prepareChatImageAttachments(
  attachments: readonly ChatImageAttachment[] | undefined
): ChatPreparedImageAttachments {
  if (attachments === undefined || attachments.length === 0) {
    return { metadata: [], images: [] };
  }
  if (attachments.length > maxImageAttachments) {
    throw new Error('chat_image_too_many');
  }

  const images = attachments.map(prepareOneAttachment);
  return {
    metadata: images.map(({ base64: _base64, ...metadata }) => metadata),
    images
  };
}

function prepareOneAttachment(attachment: ChatImageAttachment): ChatValidatedImageAttachment {
  if (attachment.kind !== 'image') {
    throw new Error('chat_image_unsupported_type');
  }
  if (!mediaTypes.has(attachment.mediaType)) {
    throw new Error('chat_image_unsupported_type');
  }
  if (attachment.sizeBytes > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const hasPath = typeof attachment.path === 'string';
  const hasData = typeof attachment.data === 'string';
  if (hasPath === hasData) {
    throw new Error('chat_image_source_invalid');
  }
  if (hasPath) {
    return readPathAttachment(attachment as ChatImageAttachment & { path: string });
  }
  return readDataAttachment(attachment as ChatImageAttachment & { data: string });
}

function readPathAttachment(attachment: ChatImageAttachment & { path: string }): ChatValidatedImageAttachment {
  const mediaType = extensionMediaTypes.get(extname(attachment.path).toLowerCase());
  if (mediaType === undefined || mediaType !== attachment.mediaType) {
    throw new Error('chat_image_unsupported_type');
  }
  const stat = statSync(attachment.path);
  if (!stat.isFile()) {
    throw new Error('chat_image_unreadable');
  }
  if (stat.size === 0) {
    throw new Error('chat_image_empty');
  }
  if (stat.size > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const buffer = readFileSync(attachment.path);
  return {
    kind: 'image',
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: stat.size,
    base64: buffer.toString('base64')
  };
}

function readDataAttachment(attachment: ChatImageAttachment & { data: string }): ChatValidatedImageAttachment {
  const buffer = Buffer.from(attachment.data, 'base64');
  if (buffer.byteLength === 0) {
    throw new Error('chat_image_empty');
  }
  if (buffer.byteLength > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  if (buffer.byteLength !== attachment.sizeBytes) {
    throw new Error('chat_image_size_mismatch');
  }
  return {
    kind: 'image',
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    base64: attachment.data
  };
}
