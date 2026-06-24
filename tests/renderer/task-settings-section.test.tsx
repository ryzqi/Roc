// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSettingsSection } from '../../src/renderer/settings/sections/task-settings-section';
import type { AppSettings } from '../../src/shared/types';

function createSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: { openAtLogin: false, minimizeToTray: true },
    globalHotkey: null,
    memory: {
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
    },
    tasks: {
      longRunningThresholds: {
        runningSeconds: 90,
        toolCallCount: 8,
        subagentCount: 1
      },
      scheduler: {
        catchUpOnStartup: true,
        maxRegisteredTasks: 256
      }
    }
  };
}

describe('TaskSettingsSection', () => {
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

  it('edits task thresholds and scheduler settings', async () => {
    const onChange = vi.fn();
    const settings = createSettings();

    await act(async () => {
      root.render(<TaskSettingsSection draft={settings} onChange={onChange} />);
    });

    setInputValue('settings-task-running-seconds', '120');
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      tasks: {
        ...settings.tasks,
        longRunningThresholds: {
          ...settings.tasks.longRunningThresholds,
          runningSeconds: 120
        }
      }
    });

    await act(async () => {
      query<HTMLInputElement>('settings-task-catch-up-on-startup').click();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      tasks: {
        ...settings.tasks,
        scheduler: {
          ...settings.tasks.scheduler,
          catchUpOnStartup: false
        }
      }
    });
  });

  it('shows row-level validation and does not emit invalid numeric settings', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<TaskSettingsSection draft={createSettings()} onChange={onChange} />);
    });

    setInputValue('settings-task-max-registered-tasks', '0');

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('必须是大于 0 的整数');
  });

  it('treats empty threshold inputs as invalid instead of saving zero', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<TaskSettingsSection draft={createSettings()} onChange={onChange} />);
    });

    setInputValue('settings-task-running-seconds', '');

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('必须是大于或等于 0 的整数');
  });

  function query<T extends HTMLElement>(testId: string): T {
    const element = container.querySelector<T>(`[data-testid="${testId}"]`);
    expect(element).not.toBeNull();
    return element as T;
  }

  function setInputValue(testId: string, value: string): void {
    const input = query<HTMLInputElement>(testId);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
