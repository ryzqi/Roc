import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { ChatComposer } from '../../src/renderer/chat/chat-composer';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import { createLoadedState } from './view-test-helpers';

const testClient: RocClient = { api: {} as RocPreloadApi };

describe('chat composer skills popover', () => {
  it('renders skill names and descriptions inside the skill popover choices', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '规划一下',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        activeComposerPopover: 'skills',
        onActiveComposerPopoverChange: () => {},
        submitting: false,
        state: createLoadedState({
          skills: [
            {
              id: 'deep-review',
              name: 'Deep Review',
              enabled: true,
              path: 'F:\\Code\\Roc\\skills\\deep-review',
              description: '只保留这一段说明文本。',
              status: 'ready',
              lastError: null
            }
          ]
        }),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(html).toContain('data-testid="chat-skill-popover"');
    expect(html).toContain('data-testid="turn-skill-deep-review"');
    expect(html).toContain('>Deep Review<');
    expect(html).toContain('class="composer-choice-copy">');
    expect(html).toContain('class="composer-choice-description composer-choice-description--clamp-2">只保留这一段说明文本。</small>');
  });
});

describe('chat composer capability triggers', () => {
  it('keeps tool and skill triggers active without numeric badges', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '继续',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        activeComposerPopover: null,
        onActiveComposerPopoverChange: () => {},
        submitting: false,
        state: createLoadedState({
          selectedMcpServers: ['exa-hosted'],
          selectedSkills: ['deep-review']
        }),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(html).toContain('data-testid="chat-tool-trigger"');
    expect(html).toContain('data-testid="chat-skill-trigger"');
    expect(html).toContain('composer-tool composer-tool--tools active');
    expect(html).toContain('composer-tool composer-tool--skills active');
    expect(html).not.toContain('tool-badge');
  });

  it('renders shared popover structure for tools and models', () => {
    const toolsHtml = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '继续',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        activeComposerPopover: 'tools',
        onActiveComposerPopoverChange: () => {},
        submitting: false,
        state: createLoadedState({
          mcpServers: [
            {
              id: 'exa-hosted',
              name: 'Exa Hosted MCP',
              enabled: true,
              transport: 'http',
              status: 'ready',
              tools: 2,
              preset: true,
              riskLevel: 'medium',
              url: 'https://mcp.exa.ai/mcp',
              allowedTools: ['web_search_exa', 'web_search_advanced_exa'],
              lastError: null
            }
          ]
        }),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    const modelsHtml = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '继续',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        activeComposerPopover: 'models',
        onActiveComposerPopoverChange: () => {},
        submitting: false,
        state: createLoadedState({}),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(toolsHtml).toContain('data-testid="chat-tool-popover"');
    expect(toolsHtml).toContain('class="composer-popover-head"');
    expect(toolsHtml).toContain('class="composer-popover-copy"');
    expect(toolsHtml).toContain('class="composer-popover-actions"');
    expect(toolsHtml).toContain('class="composer-popover-list"');
    expect(modelsHtml).toContain('data-testid="chat-model-popover"');
    expect(modelsHtml).toContain('class="composer-popover-head"');
    expect(modelsHtml).toContain('class="composer-popover-list"');
  });
});
