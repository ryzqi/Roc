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
});

function buildSettingsSnapshot(input: { defaultModelId?: string | null } = {}): SettingsSnapshot {
  const defaultModelId =
    input.defaultModelId === undefined ? 'llama_cpp:Qwen3.5-4B-UD-Q5_K_XL.gguf' : input.defaultModelId;
  const state = createLoadedState({
    providers: [
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
