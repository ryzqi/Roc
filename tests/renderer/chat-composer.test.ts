import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { ChatComposer } from '../../src/renderer/chat/chat-composer';
import { parseSlashSkillCommand } from '../../src/renderer/chat/slash-skill-command';
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
        imageInputSupported: true,
        activeComposerPopover: 'skills',
        onActiveComposerPopoverChange: () => {},
        composerMode: 'chat',
        onComposerModeChange: () => {},
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
        imageInputSupported: true,
        activeComposerPopover: null,
        onActiveComposerPopoverChange: () => {},
        composerMode: 'chat',
        onComposerModeChange: () => {},
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

  it('renders selected image attachments with remove controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '描述图片',
        onChatInputChange: () => {},
        selectedAttachments: [
          {
            kind: 'image',
            source: 'clipboard',
            name: 'chart.png',
            mediaType: 'image/png',
            sizeBytes: 123,
            data: 'AQID',
            previewUrl: null
          }
        ],
        onSelectedAttachmentsChange: () => {},
        imageInputSupported: true,
        activeComposerPopover: null,
        onActiveComposerPopoverChange: () => {},
        composerMode: 'chat',
        onComposerModeChange: () => {},
        submitting: false,
        state: createLoadedState({}),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(html).toContain('data-testid="chat-image-attachment"');
    expect(html).toContain('chart.png');
    expect(html).toContain('data-testid="chat-image-remove"');
  });

  it('renders shared popover structure for tools and models', () => {
    const toolsHtml = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '继续',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        imageInputSupported: true,
        activeComposerPopover: 'tools',
        onActiveComposerPopoverChange: () => {},
        composerMode: 'chat',
        onComposerModeChange: () => {},
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
        imageInputSupported: true,
        activeComposerPopover: 'models',
        onActiveComposerPopoverChange: () => {},
        composerMode: 'chat',
        onComposerModeChange: () => {},
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

  it('renders chat and plan composer modes', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        client: testClient,
        chatInput: '规划',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        imageInputSupported: true,
        activeComposerPopover: null,
        onActiveComposerPopoverChange: () => {},
        composerMode: 'plan',
        onComposerModeChange: () => {},
        submitting: false,
        state: createLoadedState({}),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(html).toContain('data-testid="chat-composer-mode"');
    expect(html).toContain('Plan');
    expect(html).toContain('composer-mode-option is-selected');
  });
});

describe('slash skill command parser', () => {
  it('parses slash skill command into explicit skill id and cleaned input', () => {
    expect(parseSlashSkillCommand('/skill python-expert 优化这段代码')).toEqual({
      kind: 'ok',
      input: '优化这段代码',
      explicitSkillIds: ['python-expert']
    });
  });

  it('keeps multiline prompt after the skill id', () => {
    expect(parseSlashSkillCommand('/skill python-expert\n优化这段代码')).toEqual({
      kind: 'ok',
      input: '优化这段代码',
      explicitSkillIds: ['python-expert']
    });
  });

  it('does not treat other slash text or inline slash skill text as a command', () => {
    expect(parseSlashSkillCommand('/skills python-expert')).toEqual({
      kind: 'none',
      input: '/skills python-expert'
    });
    expect(parseSlashSkillCommand('请使用 /skill python-expert')).toEqual({
      kind: 'none',
      input: '请使用 /skill python-expert'
    });
  });

  it('returns concrete errors for missing id and missing prompt', () => {
    expect(parseSlashSkillCommand('/skill')).toEqual({
      kind: 'error',
      message: '请输入 Skill ID。'
    });
    expect(parseSlashSkillCommand('/skill python-expert')).toEqual({
      kind: 'error',
      message: '请输入要发送的内容。'
    });
  });
});
