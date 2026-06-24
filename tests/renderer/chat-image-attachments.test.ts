// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  createFileImageAttachment,
  isImageInputSupported,
  validateImageAttachmentSelection
} from '../../src/renderer/chat/image-attachments';
import { createLoadedState } from './view-test-helpers';

describe('chat image attachment helpers', () => {
  it('creates base64 attachments from dropped or pasted image files', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' });

    const attachment = await createFileImageAttachment(file, 'drop');

    expect(attachment).toMatchObject({
      kind: 'image',
      source: 'drop',
      name: 'chart.png',
      mediaType: 'image/png',
      sizeBytes: 3,
      data: 'AQID'
    });
  });

  it('rejects unsupported image types', async () => {
    const file = new File([new Uint8Array([1])], 'motion.gif', { type: 'image/gif' });

    await expect(createFileImageAttachment(file, 'drop')).rejects.toThrow('chat_image_unsupported_type');
  });

  it('rejects images over five megabytes', async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });

    await expect(createFileImageAttachment(file, 'drop')).rejects.toThrow('chat_image_too_large');
  });

  it('rejects selections with more than four images', () => {
    expect(() => validateImageAttachmentSelection([1, 2, 3, 4, 5])).toThrow('chat_image_too_many');
  });

  it('requires the selected default model to support images', () => {
    const supported = createLoadedState({
      defaultModelId: 'provider-1:vision-model',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'vision-model',
              displayName: 'Vision Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        }
      ]
    });
    const unsupported = createLoadedState({
      defaultModelId: 'provider-1:text-model',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'text-model',
              displayName: 'Text Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    expect(isImageInputSupported(supported)).toBe(true);
    expect(isImageInputSupported(unsupported)).toBe(false);
  });

  it('checks image support on the selected provider when model ids overlap', () => {
    const state = createLoadedState({
      defaultModelId: 'text-provider:shared-model',
      providers: [
        {
          id: 'vision-provider',
          name: 'Vision Provider',
          type: 'openai_compatible',
          endpoint: 'https://vision.example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'shared-model',
              displayName: 'Shared Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        },
        {
          id: 'text-provider',
          name: 'Text Provider',
          type: 'openai_compatible',
          endpoint: 'https://text.example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'shared-model',
              displayName: 'Shared Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    expect(isImageInputSupported(state)).toBe(false);
  });
});
