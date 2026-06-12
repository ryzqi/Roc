// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeature } from '../../../src/renderer/features/chat';
import { createChatFeatureActions } from '../../../src/renderer/features/chat/use-chat-feature';
import type { LoadedState } from '../../../src/renderer/loaded-state';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import type { AgentRuntimeStatus, ProviderConfig, SettingsSnapshot } from '../../../src/shared/types';
import { createLoadedState } from '../view-test-helpers';

describe('chat feature actions', () => {
  it('starts, resumes, cancels, and subscribes through the RocClient api', async () => {
    const client = createChatClient();
    const actions = createChatFeatureActions(client);
    const listener = vi.fn();

    await actions.startRun({
      enabledCapabilities: { mcpServers: ['filesystem'], skills: ['planner'] },
      input: '整理当前变更',
      mode: 'task',
      threadId: 'thread-1',
      workflowHint: 'propose_background_task'
    });
    await actions.resumeRun({
      decisions: [{ type: 'approve' }],
      interruptId: 'interrupt-1',
      runId: 'run-1',
      threadId: 'thread-1'
    });
    await actions.cancelRun('run-1');
    actions.subscribeRunEvents(listener);

    expect(client.api.chat.startRun).toHaveBeenCalledWith({
      enabledCapabilities: { mcpServers: ['filesystem'], skills: ['planner'] },
      input: '整理当前变更',
      mode: 'task',
      threadId: 'thread-1',
      workflowHint: 'propose_background_task'
    });
    expect(client.api.chat.resumeRun).toHaveBeenCalledWith({
      decisions: [{ type: 'approve' }],
      interruptId: 'interrupt-1',
      runId: 'run-1',
      threadId: 'thread-1'
    });
    expect(client.api.chat.cancelRun).toHaveBeenCalledWith('run-1');
    expect(client.api.chat.onRunEvent).toHaveBeenCalledWith(listener);
  });
});

describe('ChatFeature', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('loads selected thread transcript messages through RocClient tasks api', async () => {
    const client = createChatClient();
    const state = createLoadedState({
      taskSnapshot: {
        generatedAt: '2026-05-09T08:30:00.000Z',
        counts: {
          total: 1,
          running: 0,
          failed: 0,
          pendingConfirmation: 0
        },
        threads: [
          {
            id: 'thread-current',
            kind: 'chat',
            title: '当前会话',
            goal: '当前会话',
            status: 'completed',
            createdAt: '2026-05-09T08:00:00.000Z',
            updatedAt: '2026-05-09T08:30:00.000Z'
          }
        ],
        recentEvents: [
          {
            id: 'message-current',
            threadId: 'thread-current',
            runId: 'run-current',
            type: 'message',
            payload: { role: 'assistant', content: '截断回复' },
            createdAt: '2026-05-09T08:30:00.000Z'
          }
        ]
      }
    });

    await act(async () => {
      root.render(
        <ChatFeature
          chatSelectionVersion={1}
          client={client}
          onQueuedTaskPromptHandled={() => {}}
          onSubmitChatTask={async () => ({ ok: true as const })}
          queuedTaskPrompt={null}
          selectedThreadId="thread-current"
          state={state}
          updateLoadedState={() => {}}
        />
      );
    });
    await flushPromises();

    expect(client.api.tasks.getThreadMessages).toHaveBeenCalledWith({ threadId: 'thread-current' });
    expect(container.textContent).toContain('完整回复');
  });

  it('clears the blocked chat prompt after selecting a default model from the composer', async () => {
    const provider = createProvider();
    const blockedState = createLoadedState({
      providers: [provider],
      defaultModelId: null,
      agent: createAgentRuntimeStatus('blocked_until_provider_configured', null, null)
    });
    const savedSnapshot = createSettingsSnapshot(blockedState, provider.models[0]!.id);
    const client = createChatClient({
      agentStatus: createAgentRuntimeStatus('ready', provider.id, provider.models[0]!.id),
      settingsSnapshot: savedSnapshot
    });

    await act(async () => {
      root.render(
        <ChatFeatureHarness
          client={client}
          initialState={blockedState}
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-blocked"]')?.textContent).toBe('需要先配置默认模型');

    const modelTrigger = container.querySelector('[data-testid="chat-model-trigger"]');
    expect(modelTrigger).toBeInstanceOf(HTMLElement);
    await act(async () => {
      modelTrigger!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const modelChoice = Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-choice')).find(
      (button) => button.textContent?.includes(provider.models[0]!.id)
    );
    expect(modelChoice).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      modelChoice!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.agent.getStatus).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat-blocked"]')).toBeNull();
  });
});

function ChatFeatureHarness({ client, initialState }: { client: RocClient; initialState: LoadedState }): React.JSX.Element {
  const [state, setState] = useState(initialState);
  return (
    <ChatFeature
      chatSelectionVersion={1}
      client={client}
      onQueuedTaskPromptHandled={() => {}}
      onSubmitChatTask={async () => ({ ok: true as const })}
      queuedTaskPrompt={null}
      selectedThreadId={null}
      state={state}
      updateLoadedState={(partial) => setState((current) => ({ ...current, ...partial }))}
    />
  );
}

function createChatClient(input: { agentStatus?: AgentRuntimeStatus; settingsSnapshot?: SettingsSnapshot } = {}): RocClient {
  const api = {
    chat: {
      startRun: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          runId: 'run-1',
          mode: 'task',
          threadId: 'thread-1',
          providerId: 'provider-1',
          modelId: 'model-1',
          createdAt: '2026-05-09T08:00:00.000Z'
        }
      }),
      cancelRun: vi.fn().mockResolvedValue({ ok: true, data: { cancelled: true } }),
      resumeRun: vi.fn().mockResolvedValue({ ok: true, data: { resumed: true } }),
      onRunEvent: vi.fn().mockReturnValue(() => {})
    },
    tasks: {
      getThreadMessages: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            id: 'message-full',
            threadId: 'thread-current',
            runId: 'run-current',
            type: 'message',
            payload: { role: 'assistant', content: '完整回复' },
            createdAt: '2026-05-09T08:30:00.000Z'
          }
        ]
      })
    },
    files: {
      selectFromDialog: vi.fn()
    },
    settings: {
      save: vi.fn().mockResolvedValue({ ok: true, data: input.settingsSnapshot })
    },
    agent: {
      getStatus: vi.fn().mockResolvedValue({ ok: true, data: input.agentStatus })
    }
  } as unknown as RocPreloadApi;
  return { api };
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
        supportsToolCalls: true
      }
    ]
  };
}

function createSettingsSnapshot(state: LoadedState, defaultModelId: string | null): SettingsSnapshot {
  return {
    settings: state.settings,
    providers: state.providers,
    defaultModelId,
    providerSecretStatus: state.providerSecretStatus,
    permissions: state.permissions,
    mcpServers: state.mcpServers,
    skills: state.skills,
    hostIntegration: state.hostIntegration
  };
}

function createAgentRuntimeStatus(
  execution: AgentRuntimeStatus['execution'],
  providerId: string | null,
  modelId: string | null
): AgentRuntimeStatus {
  const ready = execution === 'ready';
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: true
    },
    defaultModelConfigured: ready,
    defaultModelState: {
      status: ready ? 'ready' : 'missing',
      modelId,
      providerId,
      reason: ready ? '默认模型可用。' : '未配置默认模型。'
    },
    memoryAccess: 'store_backend',
    execution
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
