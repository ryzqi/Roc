// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HooksSection } from '../../src/renderer/settings/sections/hooks-section';
import type { RocHookConfigSnapshot } from '../../src/shared/types';

describe('HooksSection', () => {
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

  it('shows review required hook and trusts current hash', async () => {
    const onTrust = vi.fn();
    await renderHooksSection({
      snapshot: buildSnapshot(),
      onRefresh: vi.fn(),
      onTrust,
      onSave: vi.fn()
    });

    expect(container.textContent).toContain('PreToolUse');
    expect(container.textContent).toContain('review_required');

    await clickButton('信任当前命令');

    expect(onTrust).toHaveBeenCalledWith({ handlerId: 'PreToolUse:0:0', hash: 'abc123' });
  });

  it('saves edited hooks JSON', async () => {
    const onSave = vi.fn(async () => undefined);
    await renderHooksSection({
      snapshot: buildSnapshot(),
      onRefresh: vi.fn(),
      onTrust: vi.fn(),
      onSave
    });
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

    setTextareaValue(JSON.stringify(editedConfig, null, 2));
    await clickButton('保存');

    expect(onSave).toHaveBeenCalledWith({ config: editedConfig });
  });

  it('refreshes and resets the JSON editor from the latest snapshot', async () => {
    const onRefresh = vi.fn(async () => undefined);
    await renderHooksSection({
      snapshot: buildSnapshot(),
      onRefresh,
      onTrust: vi.fn(),
      onSave: vi.fn()
    });

    setTextareaValue('{');
    await clickButton('刷新');
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const refreshed = buildSnapshot({
      config: {
        schemaVersion: 1,
        hooks: {
          SessionStart: [
            {
              matcher: 'chat',
              hooks: [
                {
                  type: 'command',
                  command: 'node session-start.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'continue'
                }
              ]
            }
          ]
        }
      }
    });
    await renderHooksSection({
      snapshot: refreshed,
      onRefresh,
      onTrust: vi.fn(),
      onSave: vi.fn()
    });

    expect(queryTextarea().value).toBe(JSON.stringify(refreshed.config, null, 2));
  });

  it('shows local parse errors and snapshot validation errors', async () => {
    const onSave = vi.fn();
    await renderHooksSection({
      snapshot: buildSnapshot({ validationErrors: ['handler 0 command is empty'] }),
      onRefresh: vi.fn(),
      onTrust: vi.fn(),
      onSave
    });

    setTextareaValue('{');
    await clickButton('保存');

    expect(container.textContent).toContain('JSON');
    expect(container.textContent).toContain('handler 0 command is empty');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows save failures from the settings IPC handler', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('hooks save failed');
    });
    await renderHooksSection({
      snapshot: buildSnapshot(),
      onRefresh: vi.fn(),
      onTrust: vi.fn(),
      onSave
    });

    await clickButton('保存');

    expect(container.textContent).toContain('hooks save failed');
  });

  async function renderHooksSection(props: React.ComponentProps<typeof HooksSection>): Promise<void> {
    await act(async () => {
      root.render(React.createElement(HooksSection, props));
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

  function queryTextarea(): HTMLTextAreaElement {
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="settings-hooks-json"]');
    expect(textarea).not.toBeNull();
    return textarea as HTMLTextAreaElement;
  }

  function setTextareaValue(value: string): void {
    const textarea = queryTextarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

function buildSnapshot(input: Partial<RocHookConfigSnapshot> = {}): RocHookConfigSnapshot {
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
    ],
    ...input
  };
}
