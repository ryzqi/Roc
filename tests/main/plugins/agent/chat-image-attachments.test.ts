import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareChatImageAttachments } from '../../../../src/main/plugins/agent/chat-image-attachments';

describe('prepareChatImageAttachments', () => {
  it('reads file attachments and returns metadata plus base64', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-image-'));
    try {
      const filePath = join(root, 'sample.png');
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'file',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4,
          path: filePath
        }
      ]);

      expect(result.metadata).toEqual([
        {
          kind: 'image',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4
        }
      ]);
      expect(result.images).toEqual([
        {
          kind: 'image',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4,
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
        }
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts clipboard base64 data without persisting bytes', async () => {
    const result = await prepareChatImageAttachments([
      {
        kind: 'image',
        source: 'clipboard',
        name: 'pasted.png',
        mediaType: 'image/png',
        sizeBytes: 3,
        data: Buffer.from([1, 2, 3]).toString('base64')
      }
    ]);

    expect(result.metadata[0]).toEqual({
      kind: 'image',
      name: 'pasted.png',
      mediaType: 'image/png',
      sizeBytes: 3
    });
    expect(result.images[0]?.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('rejects more than four images', async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      kind: 'image' as const,
      source: 'clipboard' as const,
      name: `image-${index}.png`,
      mediaType: 'image/png' as const,
      sizeBytes: 1,
      data: Buffer.from([index]).toString('base64')
    }));

    await expect(prepareChatImageAttachments(attachments)).rejects.toThrow('chat_image_too_many');
  });

  it('rejects unsupported media types', async () => {
    await expect(
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'bad.gif',
          mediaType: 'image/gif' as never,
          sizeBytes: 1,
          data: Buffer.from([1]).toString('base64')
        }
      ])
    ).rejects.toThrow('chat_image_unsupported_type');
  });

  it('rejects images over five megabytes', async () => {
    await expect(
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'large.png',
          mediaType: 'image/png',
          sizeBytes: 5 * 1024 * 1024 + 1,
          data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
        }
      ])
    ).rejects.toThrow('chat_image_too_large');
  });

  it('rejects attachments with both path and data', async () => {
    await expect(
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'ambiguous.png',
          mediaType: 'image/png',
          sizeBytes: 1,
          path: 'C:\\tmp\\ambiguous.png',
          data: Buffer.from([1]).toString('base64')
        }
      ])
    ).rejects.toThrow('chat_image_source_invalid');
  });
});
