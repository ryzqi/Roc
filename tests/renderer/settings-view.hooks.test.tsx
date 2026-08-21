// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import { SettingsView } from '../../src/renderer/settings';
import type { RocHookConfigSnapshot } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

describe('SettingsView hooks', () => {
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

  it('wires hooks refresh, save, and trust through settings IPC', async () => {
    const hookSettings = buildHookSettings();
    const state = createLoadedState({ hookSettings });
    const editedConfig = {
      schemaVersion: 1 as const,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command' as const,
                command: 'node stop-hook.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue' as const
              }
            ]
          }
        ]
      }
    };
    const getHooks = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...hookSettings,
        exists: true
      }
    }));
    const saveHooks = vi.fn(async (request: { config: RocHookConfigSnapshot['config'] }) => ({
      ok: true as const,
      data: {
        ...hookSettings,
        config: request.config
      }
    }));
    const trustHook = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...hookSettings,
        handlers: hookSettings.handlers.map((handler) => ({ ...handler, trustState: 'trusted' as const }))
      }
    }));
    const updateLoadedState = vi.fn();
    const client: RocClient = {
      api: {
        settings: {
          getHooks,
          saveHooks,
          trustHook,
          get: vi.fn(),
          save: vi.fn(),
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
          state,
          updateLoadedState
        })
      );
    });

    await clickByTestId('settings-section-hooks');
    expect(queryByTestId('settings-panel-hooks')).not.toBeNull();

    setTextareaValue(JSON.stringify(editedConfig, null, 2));
    await clickButton('保存');
    expect(saveHooks).toHaveBeenCalledWith({ config: editedConfig });
    expect(updateLoadedState).toHaveBeenCalledWith({
      hookSettings: expect.objectContaining({ config: editedConfig })
    });

    await clickButton('刷新');
    expect(getHooks).toHaveBeenCalledTimes(1);

    await clickButton('信任当前命令');
    expect(trustHook).toHaveBeenCalledWith({ handlerId: 'PreToolUse:0:0', hash: 'abc123' });
  });

  async function clickByTestId(testId: string): Promise<void> {
    const button = queryByTestId(testId);
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function clickButton(label: string): Promise<void> {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);
    expect(button).not.toBeUndefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  function queryByTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function setTextareaValue(value: string): void {
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="settings-hooks-json"]');
    expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

function buildHookSettings(): RocHookConfigSnapshot {
  return {
    configPath: 'C:\\Users\\me\\.roc\\hooks.json',
    exists: true,
    config: {
      schemaVersion: 1,
      hooks: {}
    },
    validationErrors: [],
    handlers: [
      {
        id: 'PreToolUse:0:0',
        event: 'PreToolUse',
        matcher: '^run_shell_command$',
        command: 'node hook.js',
        commandWindows: null,
        timeoutSeconds: 30,
        statusMessage: 'Checking command',
        enabled: true,
        failureMode: 'continue',
        hash: 'abc123',
        trustState: 'review_required',
        validationError: null,
        lastRun: null
      }
    ]
  };
}
