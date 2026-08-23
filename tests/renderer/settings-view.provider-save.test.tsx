// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import { SettingsView } from '../../src/renderer/settings';
import { emptyRocHookConfigSnapshot } from '../../src/shared/types';
import type { AgentRuntimeStatus, SettingsSnapshot } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

describe('SettingsView provider save', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
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
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('creates a custom provider without saving a secret when the API key is empty', async () => {
    const snapshot = buildSettingsSnapshot({ defaultModelId: null });
    const save = vi.fn(async (request: unknown) => {
      const providers = (request as { providers: SettingsSnapshot['providers'] }).providers;
      return {
        ok: true as const,
        data: {
          ...snapshot,
          providers,
          providerSecretStatus: providers.map((provider) => ({
            providerId: provider.id,
            stored: provider.id === 'llama_cpp'
          }))
        }
      };
    });
    const setProviderSecret = vi.fn();
    const updateLoadedState = vi.fn();
    const client: RocClient = {
      api: {
        settings: {
          get: vi.fn(async () => ({ ok: true as const, data: snapshot })),
          save,
          testProvider: vi.fn(),
          setProviderSecret,
          clearProviderSecret: vi.fn()
        }
      }
    } as unknown as RocClient;

    await act(async () => {
      root.render(
        React.createElement(SettingsView, {
          client,
          state: {
            settings: snapshot.settings,
            providers: snapshot.providers,
            defaultModelId: snapshot.defaultModelId,
            providerSecretStatus: snapshot.providerSecretStatus,
            permissions: snapshot.permissions,
            mcpServers: snapshot.mcpServers,
            skills: snapshot.skills,
            hookSettings: snapshot.hooks,
            hostIntegration: snapshot.hostIntegration,
            providerTestStatus: null
          },
          updateLoadedState
        })
      );
    });

    await act(async () => {
      queryByTestId('provider-add-openai')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setInputValue('provider-draft-name', 'Provider Without Key');
    setInputValue('provider-draft-endpoint', 'https://openai.example.test/v1');
    await clickByTestId('provider-model-open-0');
    setInputValue('provider-model-id-0', 'gpt-x');
    setInputValue('provider-model-name-0', 'GPT X');

    await act(async () => {
      queryByTestId('provider-save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(save).toHaveBeenCalledTimes(1);
    expect(setProviderSecret).not.toHaveBeenCalled();
    const request = save.mock.calls[0]?.[0] as {
      providers: Array<{ id: string; name: string; credentialRef: string | null }>;
    };
    expect(request.providers).toContainEqual(
      expect.objectContaining({
        id: 'provider-without-key',
        name: 'Provider Without Key',
        credentialRef: 'secret:provider-without-key'
      })
    );
    expect(queryByTestId('provider-draft-status')).toBeNull();
    const apiKeyInput = queryByTestId('provider-draft-api-key') as HTMLInputElement | null;
    expect(apiKeyInput?.value).toBe('');
    expect(updateLoadedState).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'provider-without-key',
            name: 'Provider Without Key',
            credentialRef: 'secret:provider-without-key'
          })
        ]),
        providerSecretStatus: expect.arrayContaining([
          expect.objectContaining({
            providerId: 'provider-without-key',
            stored: false
          })
        ])
      })
    );
  });

  it('does not preserve a stale llama.cpp credentialRef when saving with an empty API key', async () => {
    const snapshot = buildSettingsSnapshot();
    const save = vi.fn(async (request: unknown) => ({
      ok: true as const,
      data: {
        ...snapshot,
        providers: (request as { providers: SettingsSnapshot['providers'] }).providers
      }
    }));
    const client: RocClient = {
      api: {
        settings: {
          get: vi.fn(async () => ({ ok: true as const, data: snapshot })),
          save,
          testProvider: vi.fn(),
          setProviderSecret: vi.fn(),
          clearProviderSecret: vi.fn()
        }
      }
    } as unknown as RocClient;

    await act(async () => {
      root.render(
        React.createElement(SettingsView, {
          client,
          state: {
            settings: snapshot.settings,
            providers: snapshot.providers,
            defaultModelId: snapshot.defaultModelId,
            providerSecretStatus: snapshot.providerSecretStatus,
            permissions: snapshot.permissions,
            mcpServers: snapshot.mcpServers,
            skills: snapshot.skills,
            hookSettings: snapshot.hooks,
            hostIntegration: snapshot.hostIntegration,
            providerTestStatus: null
          },
          updateLoadedState: () => {}
        })
      );
    });

    setInputValue('provider-draft-endpoint', 'http://127.0.0.1:8081');

    await act(async () => {
      queryByTestId('provider-save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(save).toHaveBeenCalledTimes(1);
    const request = save.mock.calls[0]?.[0] as {
      providers: Array<{ id: string; credentialRef: string | null; endpoint: string }>;
    };
    const llamaCpp = request.providers.find((provider) => provider.id === 'llama_cpp');
    expect(llamaCpp).toMatchObject({
      id: 'llama_cpp',
      endpoint: 'http://127.0.0.1:8081/v1',
      credentialRef: null
    });
  });

  it('refreshes agent runtime after selecting a default model in settings', async () => {
    const modelId = 'Qwen3.5-4B-UD-Q5_K_XL.gguf';
    const modelKey = `llama_cpp:${modelId}`;
    const snapshot = buildSettingsSnapshot({ defaultModelId: null });
    const agentStatus = createReadyAgentStatus('llama_cpp', modelId);
    const save = vi.fn(async (request: unknown) => ({
      ok: true as const,
      data: {
        ...snapshot,
        defaultModelId: (request as { defaultModelId: string | null }).defaultModelId
      }
    }));
    const getStatus = vi.fn(async () => ({ ok: true as const, data: agentStatus }));
    const updateLoadedState = vi.fn();
    const client: RocClient = {
      api: {
        settings: {
          get: vi.fn(async () => ({ ok: true as const, data: snapshot })),
          save,
          testProvider: vi.fn(),
          setProviderSecret: vi.fn(),
          clearProviderSecret: vi.fn()
        },
        agent: {
          getStatus
        }
      }
    } as unknown as RocClient;

    await act(async () => {
      root.render(
        React.createElement(SettingsView, {
          client,
          state: {
            settings: snapshot.settings,
            providers: snapshot.providers,
            defaultModelId: snapshot.defaultModelId,
            providerSecretStatus: snapshot.providerSecretStatus,
            permissions: snapshot.permissions,
            mcpServers: snapshot.mcpServers,
            skills: snapshot.skills,
            hookSettings: snapshot.hooks,
            hostIntegration: snapshot.hostIntegration,
            providerTestStatus: null
          },
          updateLoadedState
        })
      );
    });

    await act(async () => {
      queryByTestId('settings-section-default-model')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      queryByTestId(`default-model-llama_cpp-${modelId}`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultModelId: modelKey }));
    expect(getStatus).toHaveBeenCalled();
    expect(updateLoadedState).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModelId: modelKey,
        agent: agentStatus,
        agentCapabilityPreview: null
      })
    );
  });

  it('clears a removed default model and refreshes the blocked agent state', async () => {
    const provider = {
      id: 'provider-a',
      name: 'Provider A',
      type: 'openai_compatible' as const,
      endpoint: 'https://provider-a.example.test/v1',
      credentialRef: 'secret:provider-a',
      enabled: true,
      models: [
        {
          id: 'model-a',
          displayName: 'Model A',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
        },
        {
          id: 'model-b',
          displayName: 'Model B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
        }
      ]
    };
    const snapshot = buildSettingsSnapshot({
      defaultModelId: 'provider-a:model-a',
      providers: [provider]
    });
    const blockedAgentStatus: AgentRuntimeStatus = {
      deepAgentsPackage: 'available',
      deepAgentsApi: {
        createDeepAgent: true
      },
      defaultModelConfigured: false,
      defaultModelState: {
        status: 'missing',
        modelId: null,
        providerId: null,
        reason: '未配置默认模型。'
      },
      memoryAccess: 'store_backend',
      execution: 'blocked_until_provider_configured'
    };
    const save = vi.fn(async (request: unknown) => ({
      ok: true as const,
      data: {
        ...snapshot,
        providers: (request as { providers: SettingsSnapshot['providers'] }).providers,
        defaultModelId: (request as { defaultModelId: string | null }).defaultModelId
      }
    }));
    const getStatus = vi.fn(async () => ({ ok: true as const, data: blockedAgentStatus }));
    const updateLoadedState = vi.fn();
    const client: RocClient = {
      api: {
        settings: {
          get: vi.fn(async () => ({ ok: true as const, data: snapshot })),
          save,
          testProvider: vi.fn(),
          setProviderSecret: vi.fn(),
          clearProviderSecret: vi.fn()
        },
        agent: {
          getStatus
        }
      }
    } as unknown as RocClient;

    await act(async () => {
      root.render(
        React.createElement(SettingsView, {
          client,
          state: {
            settings: snapshot.settings,
            providers: snapshot.providers,
            defaultModelId: snapshot.defaultModelId,
            providerSecretStatus: snapshot.providerSecretStatus,
            permissions: snapshot.permissions,
            mcpServers: snapshot.mcpServers,
            skills: snapshot.skills,
            hookSettings: snapshot.hooks,
            hostIntegration: snapshot.hostIntegration,
            providerTestStatus: null
          },
          updateLoadedState
        })
      );
    });

    await act(async () => {
      queryByTestId('provider-list-item-provider-a')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await clickByTestId('provider-model-open-0');
    setInputValue('provider-model-id-0', 'model-b');
    setInputValue('provider-model-name-0', 'Model B');
    await act(async () => {
      queryByTestId('provider-save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultModelId: null }));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(updateLoadedState).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModelId: null,
        agent: blockedAgentStatus,
        agentCapabilityPreview: null
      })
    );
  });

  it('discards provider draft changes before navigating to another settings section', async () => {
    const snapshot = buildSettingsSnapshot();
    const client: RocClient = {
      api: {
        settings: {
          get: vi.fn(), save: vi.fn(), testProvider: vi.fn(), setProviderSecret: vi.fn(), clearProviderSecret: vi.fn()
        }
      }
    } as unknown as RocClient;
    await act(async () => {
      root.render(React.createElement(SettingsView, {
        client,
        state: {
          settings: snapshot.settings,
          providers: snapshot.providers,
          defaultModelId: snapshot.defaultModelId,
          providerSecretStatus: snapshot.providerSecretStatus,
          permissions: snapshot.permissions,
          mcpServers: snapshot.mcpServers,
          skills: snapshot.skills,
          hookSettings: snapshot.hooks,
          hostIntegration: snapshot.hostIntegration,
          providerTestStatus: null
        },
        updateLoadedState: () => {}
      }));
    });
    setInputValue('provider-draft-endpoint', 'http://changed.example.test/v1');
    await clickByTestId('settings-section-default-model');
    expect(document.body.textContent).toContain('放弃提供商修改？');
    const dialog = document.body.querySelector('[role="alertdialog"]');
    const discard = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === '放弃修改');
    await act(async () => discard?.click());
    expect(queryByTestId('default-model-settings')).not.toBeNull();
    await clickByTestId('settings-section-providers');
    expect((queryByTestId('provider-draft-endpoint') as HTMLInputElement | null)?.value).toBe('http://127.0.0.1:8081/v1');
  });
});

function buildSettingsSnapshot(
  input: { defaultModelId?: string | null; providers?: SettingsSnapshot['providers'] } = {}
): SettingsSnapshot {
  const defaultModelId =
    input.defaultModelId === undefined ? 'llama_cpp:Qwen3.5-4B-UD-Q5_K_XL.gguf' : input.defaultModelId;
  const state = createLoadedState({
    providers:
      input.providers ?? [
        {
          id: 'llama_cpp',
          name: 'llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081',
          credentialRef: 'secret:llama_cpp',
          enabled: true,
          models: [
            {
              id: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
              displayName: 'Qwen 3.5 4B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ],
    defaultModelId,
    providerSecretStatus: [{ providerId: 'llama_cpp', stored: true }]
  });

  return {
    settings: state.settings,
    providers: state.providers,
    defaultModelId: state.defaultModelId,
    providerSecretStatus: state.providerSecretStatus,
    permissions: state.permissions,
    mcpServers: state.mcpServers,
    skills: state.skills,
    hooks: emptyRocHookConfigSnapshot,
    hostIntegration: state.hostIntegration
  };
}

function createReadyAgentStatus(providerId: string, modelId: string): AgentRuntimeStatus {
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: true
    },
    defaultModelConfigured: true,
    defaultModelState: {
      status: 'ready',
      modelId,
      providerId,
      reason: '默认模型可用。'
    },
    memoryAccess: 'store_backend',
    execution: 'ready'
  };
}

function queryByTestId(testId: string): HTMLElement | null {
  return containerRef().querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(testId: string, value: string): void {
  const input = containerRef().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(input).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  expect(setter).not.toBeUndefined();
  setter?.call(input, value);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickByTestId(testId: string): Promise<void> {
  const element = queryByTestId(testId);
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function containerRef(): HTMLDivElement {
  const element = document.body.querySelector('div');
  expect(element).not.toBeNull();
  return element as HTMLDivElement;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
