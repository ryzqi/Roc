// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { ChatComposer } from '../../src/renderer/chat/chat-composer';
import type { LoadedState } from '../../src/renderer/loaded-state';
import { parseSlashSkillCommand } from '../../src/renderer/chat/slash-skill-command';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { ProviderConfig } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

const testClient: RocClient = { api: {} as RocPreloadApi };

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('opens tool, skill, and model popovers from trigger clicks', async () => {
    const client = createInteractiveClient();
    await act(async () => {
      root.render(
        React.createElement(ChatComposerHarness, {
          client,
          initialState: createLoadedState({
            mcpServers: [createMcpServer()],
            skills: [createSkill()],
            providers: [createProvider()],
            defaultModelId: 'provider-1:model-1'
          })
        })
      );
    });

    expect(container.querySelector('[data-testid="chat-tool-popover"]')).toBeNull();
    const toolTrigger = queryButton(container, 'chat-tool-trigger');
    expect(toolTrigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toolTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(queryElement(container, 'chat-tool-popover').textContent).toContain('工具');
    expect(toolTrigger.getAttribute('aria-expanded')).toBe('true');

    const skillTrigger = queryButton(container, 'chat-skill-trigger');
    await act(async () => {
      skillTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(queryElement(container, 'chat-skill-popover').textContent).toContain('技能');
    expect(skillTrigger.getAttribute('aria-expanded')).toBe('true');

    const modelTrigger = queryButton(container, 'chat-model-trigger');
    await act(async () => {
      modelTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(queryElement(container, 'chat-model-popover').textContent).toContain('默认模型');
    expect(modelTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(client.api.mcp.listServers).toHaveBeenCalledTimes(2);
    expect(client.api.skills.list).toHaveBeenCalledTimes(2);
  });

  it('opens tool, skill, and model popovers when trigger buttons receive focus', async () => {
    const client = createInteractiveClient();
    await act(async () => {
      root.render(
        React.createElement(ChatComposerHarness, {
          client,
          initialState: createLoadedState({
            mcpServers: [createMcpServer()],
            skills: [createSkill()],
            providers: [createProvider()],
            defaultModelId: 'provider-1:model-1'
          })
        })
      );
    });

    const toolTrigger = queryButton(container, 'chat-tool-trigger');
    await act(async () => {
      toolTrigger.focus();
    });
    expect(queryElement(container, 'chat-tool-popover').textContent).toContain('工具');
    expect(toolTrigger.getAttribute('aria-expanded')).toBe('true');

    const skillTrigger = queryButton(container, 'chat-skill-trigger');
    await act(async () => {
      skillTrigger.focus();
    });
    expect(queryElement(container, 'chat-skill-popover').textContent).toContain('技能');
    expect(skillTrigger.getAttribute('aria-expanded')).toBe('true');

    const modelTrigger = queryButton(container, 'chat-model-trigger');
    await act(async () => {
      modelTrigger.focus();
    });
    expect(queryElement(container, 'chat-model-popover').textContent).toContain('默认模型');
    expect(modelTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(client.api.mcp.listServers).toHaveBeenCalledTimes(2);
    expect(client.api.skills.list).toHaveBeenCalledTimes(2);
  });

  it('keeps a focused popover open inside its anchor and closes it after focus leaves', async () => {
    const client = createInteractiveClient();
    await act(async () => {
      root.render(
        React.createElement(ChatComposerHarness, {
          client,
          initialState: createLoadedState({
            mcpServers: [createMcpServer()],
            skills: [createSkill()],
            providers: [createProvider()],
            defaultModelId: 'provider-1:model-1'
          })
        })
      );
    });

    const toolTrigger = queryButton(container, 'chat-tool-trigger');
    await act(async () => {
      toolTrigger.focus();
    });
    expect(queryElement(container, 'chat-tool-popover').textContent).toContain('工具');

    const selectAll = queryButton(container, 'chat-tool-select-all');
    await act(async () => {
      selectAll.focus();
    });
    expect(queryElement(container, 'chat-tool-popover').textContent).toContain('工具');

    await act(async () => {
      queryButton(container, 'chat-task-submit').focus();
    });
    expect(container.querySelector('[data-testid="chat-tool-popover"]')).toBeNull();
    expect(toolTrigger.getAttribute('aria-expanded')).toBe('false');
  });

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

type ComposerPopover = 'tools' | 'skills' | 'models' | null;

function ChatComposerHarness({
  client,
  initialState
}: {
  client: RocClient;
  initialState: LoadedState;
}): React.JSX.Element {
  const [activeComposerPopover, setActiveComposerPopover] = useState<ComposerPopover>(null);
  return React.createElement(ChatComposer, {
    client,
    chatInput: '继续',
    onChatInputChange: () => {},
    selectedAttachments: [],
    onSelectedAttachmentsChange: () => {},
    imageInputSupported: true,
    activeComposerPopover,
    onActiveComposerPopoverChange: setActiveComposerPopover,
    composerMode: 'chat',
    onComposerModeChange: () => {},
    submitting: false,
    state: initialState,
    updateLoadedState: () => {},
    onSubmit: async () => {}
  });
}

function queryButton(parent: HTMLElement, testId: string): HTMLButtonElement {
  const button = parent.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) {
    throw new Error(`${testId}_missing`);
  }
  return button;
}

function queryElement(parent: HTMLElement, testId: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) {
    throw new Error(`${testId}_missing`);
  }
  return element;
}

function createInteractiveClient(): RocClient {
  const mcpServer = createMcpServer();
  const skill = createSkill();
  return {
    api: {
      mcp: {
        listServers: vi.fn().mockResolvedValue({ ok: true, data: [mcpServer] })
      },
      skills: {
        list: vi.fn().mockResolvedValue({ ok: true, data: [skill] })
      }
    } as unknown as RocPreloadApi
  };
}

function createMcpServer(): LoadedState['mcpServers'][number] {
  return {
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
  };
}

function createSkill(): LoadedState['skills'][number] {
  return {
    id: 'deep-review',
    name: 'Deep Review',
    enabled: true,
    path: 'F:\\Code\\Roc\\skills\\deep-review',
    description: '只保留这一段说明文本。',
    status: 'ready',
    lastError: null
  };
}

function createProvider(): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'Provider 1',
    type: 'openai_compatible',
    endpoint: 'https://example.test/v1',
    credentialRef: 'secret:provider-1',
    enabled: true,
    models: [
      {
        id: 'model-1',
        displayName: 'Model 1',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImages: false
      }
    ]
  };
}

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
