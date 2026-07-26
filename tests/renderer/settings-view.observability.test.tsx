// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RocClient } from '../../src/renderer/shared/roc-client';
import { SettingsView } from '../../src/renderer/settings';
import type { AgentLangSmithConfigV1, AgentLangSmithSettings, IpcResult } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsView observability', () => {
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

  it('loads only public LangSmith state and shows the external data and retention boundary', async () => {
    const load = deferred<IpcResult<AgentLangSmithSettings>>();
    const getLangSmithSettings = vi.fn(() => load.promise);

    await renderSettings(createClient({ getLangSmithSettings }));
    await clickByTestId('settings-section-observability');

    expect(queryByTestId('settings-observability-loading')).not.toBeNull();
    expect(getLangSmithSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      load.resolve(success({
        config: disabledConfig(),
        apiKeyStored: false,
        apiKey: 'lsv2-must-never-render'
      } as AgentLangSmithSettings));
      await flushPromises();
    });

    expect(queryByTestId('settings-panel-observability')).not.toBeNull();
    expect(queryByTestId('settings-observability-key-state')?.textContent).toContain('未设置');
    expect(container.textContent).toContain('发送到 LangSmith');
    expect(container.textContent).toContain('retention policy');
    expect(container.textContent).not.toContain('lsv2-must-never-render');
    expect(queryInput('settings-observability-enabled').disabled).toBe(true);
  });

  it('sets a key before enabling tracing, saves config, disables tracing, then clears the key', async () => {
    const getLangSmithSettings = vi.fn(async () => success(settings(false)));
    const saveLangSmithSettings = vi.fn(async (config: AgentLangSmithConfigV1) =>
      success({ config, apiKeyStored: true })
    );
    const setLangSmithApiKey = vi.fn(async () => success(settings(true)));
    const clearLangSmithApiKey = vi.fn(async () => success(settings(false)));

    await openObservability(createClient({
      clearLangSmithApiKey,
      getLangSmithSettings,
      saveLangSmithSettings,
      setLangSmithApiKey
    }));

    expect(queryInput('settings-observability-enabled').disabled).toBe(true);
    setInputValue('settings-observability-api-key', 'lsv2-user-entered');
    await clickByTestId('settings-observability-save-api-key');

    expect(setLangSmithApiKey).toHaveBeenCalledWith({ apiKey: 'lsv2-user-entered' });
    expect(queryInput('settings-observability-api-key').value).toBe('');
    expect(queryByTestId('settings-observability-key-state')?.textContent).toContain('已安全存储');
    expect(queryInput('settings-observability-enabled').disabled).toBe(false);

    await clickByTestId('settings-observability-enabled');
    expect(queryButton('settings-observability-clear-api-key').disabled).toBe(true);
    setInputValue('settings-observability-project-name', 'roc-production');
    await clickByTestId('settings-observability-save-config');

    expect(saveLangSmithSettings).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      enabled: true,
      projectName: 'roc-production'
    });
    expect(queryButton('settings-observability-clear-api-key').disabled).toBe(true);

    await clickByTestId('settings-observability-enabled');
    await clickByTestId('settings-observability-save-config');
    expect(saveLangSmithSettings).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      enabled: false,
      projectName: 'roc-production'
    });

    await clickByTestId('settings-observability-clear-api-key');
    expect(clearLangSmithApiKey).toHaveBeenCalledTimes(1);
    expect(queryByTestId('settings-observability-feedback')?.textContent).toContain('API Key 已清除');
    expect(queryByTestId('settings-observability-key-state')?.textContent).toContain('未设置');
  });

  it('recovers from load and save failures while keeping actions disabled in flight', async () => {
    const getLangSmithSettings = vi
      .fn()
      .mockResolvedValueOnce(failure<AgentLangSmithSettings>('加载失败，请重试。'))
      .mockResolvedValueOnce(success(settings(true)));
    const saveResult = deferred<IpcResult<AgentLangSmithSettings>>();
    const saveLangSmithSettings = vi
      .fn()
      .mockReturnValueOnce(saveResult.promise)
      .mockResolvedValueOnce(success({
        config: { ...disabledConfig(), projectName: 'roc-recovered' },
        apiKeyStored: true
      }));

    await openObservability(createClient({ getLangSmithSettings, saveLangSmithSettings }));

    expect(queryByTestId('settings-observability-feedback')?.getAttribute('role')).toBe('alert');
    expect(queryByTestId('settings-observability-feedback')?.textContent).toContain('加载失败，请重试。');

    await clickByTestId('settings-observability-retry');
    expect(getLangSmithSettings).toHaveBeenCalledTimes(2);
    setInputValue('settings-observability-project-name', 'roc-recovered');
    await clickByTestId('settings-observability-save-config');
    expect(queryButton('settings-observability-save-config').disabled).toBe(true);

    await act(async () => {
      saveResult.resolve(failure('保存失败，请重试。'));
      await flushPromises();
    });

    expect(queryByTestId('settings-observability-feedback')?.getAttribute('role')).toBe('alert');
    expect(queryByTestId('settings-observability-feedback')?.textContent).toContain('保存失败，请重试。');
    expect(queryButton('settings-observability-save-config').disabled).toBe(false);

    await clickByTestId('settings-observability-save-config');
    expect(queryByTestId('settings-observability-feedback')?.getAttribute('role')).toBe('status');
    expect(queryByTestId('settings-observability-feedback')?.textContent).toContain('可观测性设置已保存');
  });

  it('keeps global dirty state and save controls visible on the independently saved section', async () => {
    const getLangSmithSettings = vi.fn(async () => success(settings(false)));

    await renderSettings(createClient({ getLangSmithSettings }));
    await clickByTestId('settings-section-tasks');
    setInputValue('settings-task-running-seconds', '120');

    expect(queryByTestId('settings-dirty-count')?.textContent).toBe('未保存 1 项');
    expect(queryByTestId('settings-save-all')).not.toBeNull();

    await clickByTestId('settings-section-observability');
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId('settings-panel-observability')).not.toBeNull();
    expect(queryByTestId('settings-dirty-count')?.textContent).toBe('未保存 1 项');
    expect(queryByTestId('settings-save-all')).not.toBeNull();
  });

  async function renderSettings(client: RocClient): Promise<void> {
    await act(async () => {
      root.render(
        <SettingsView
          client={client}
          state={createLoadedState({})}
          updateLoadedState={vi.fn()}
        />
      );
    });
  }

  async function openObservability(client: RocClient): Promise<void> {
    await renderSettings(client);
    await clickByTestId('settings-section-observability');
    await act(async () => {
      await flushPromises();
    });
  }

  async function clickByTestId(testId: string): Promise<void> {
    const element = queryByTestId(testId);
    expect(element, testId).not.toBeNull();
    await act(async () => {
      element?.click();
      await flushPromises();
    });
  }

  function setInputValue(testId: string, value: string): void {
    const input = queryInput(testId);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function queryByTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function queryInput(testId: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    expect(input, testId).not.toBeNull();
    return input as HTMLInputElement;
  }

  function queryButton(testId: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button, testId).not.toBeNull();
    return button as HTMLButtonElement;
  }
});

type LangSmithClientMethods = {
  clearLangSmithApiKey?: () => Promise<IpcResult<AgentLangSmithSettings>>;
  getLangSmithSettings?: () => Promise<IpcResult<AgentLangSmithSettings>>;
  saveLangSmithSettings?: (config: AgentLangSmithConfigV1) => Promise<IpcResult<AgentLangSmithSettings>>;
  setLangSmithApiKey?: (request: { apiKey: string }) => Promise<IpcResult<AgentLangSmithSettings>>;
};

function createClient(methods: LangSmithClientMethods): RocClient {
  return {
    api: {
      agent: {
        clearLangSmithApiKey: methods.clearLangSmithApiKey,
        getLangSmithSettings: methods.getLangSmithSettings,
        saveLangSmithSettings: methods.saveLangSmithSettings,
        setLangSmithApiKey: methods.setLangSmithApiKey
      }
    }
  } as unknown as RocClient;
}

function disabledConfig(): AgentLangSmithConfigV1 {
  return {
    schemaVersion: 1,
    enabled: false,
    projectName: 'roc'
  };
}

function settings(apiKeyStored: boolean): AgentLangSmithSettings {
  return {
    config: disabledConfig(),
    apiKeyStored
  };
}

function success<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function failure<T>(message: string): IpcResult<T> {
  return {
    ok: false,
    error: {
      category: 'internal',
      code: 'internal_error',
      message,
      retryable: false
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
