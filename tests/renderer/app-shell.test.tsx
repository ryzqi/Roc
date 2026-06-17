// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/renderer/app/AppShell';
import type { AppBootstrap } from '../../src/renderer/app/use-app-bootstrap';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { createLoadedState } from './view-test-helpers';

describe('AppShell', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
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
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders navigation, window controls, selected view, and settings trigger', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.querySelector('[data-testid="roc-app"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-minimize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-toggle-maximize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-close"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-gear"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="active-view"]')).not.toBeNull();
    expect(container.textContent).toContain('任务工作台');
  });

  it('subscribes to task updates through the RocClient api', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(client.api.tasks.onUpdated).toHaveBeenCalledTimes(1);
  });

  it('opens the task workbench entry as the board page instead of chat', async () => {
    const client = createShellClient();
    window.roc = client.api;
    window.history.replaceState(null, '', '/?page=tasks-board');

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).toContain('任务工作台');
    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();
  });

  it('does not keep queued task prompt state in the task workbench flow', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).not.toContain('请调用 propose_background_task 创建任务');
  });
});

function createBootstrap(): AppBootstrap {
  return {
    error: null,
    setError: vi.fn(),
    setState: vi.fn(),
    setWindowState: vi.fn(),
    state: createLoadedState({}),
    windowState: {
      maximized: false,
      minimized: false,
      fullscreen: false
    }
  };
}

function createShellClient(): RocClient {
  const state = createLoadedState({});
  const api = {
    app: {
      getStatus: vi.fn().mockResolvedValue({ ok: true, data: state.appStatus }),
      onAppearanceUpdated: vi.fn().mockReturnValue(() => {}),
      onNavigate: vi.fn().mockReturnValue(() => {})
    },
    tasks: {
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, data: state.taskSnapshot }),
      getActiveTasks: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getSchedulerStatus: vi.fn().mockResolvedValue({ ok: true, data: state.schedulerStatus }),
      onUpdated: vi.fn().mockReturnValue(() => {}),
      deleteThread: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } })
    },
    lifecycle: {
      getTraySummary: vi.fn().mockResolvedValue({ ok: true, data: state.traySummary })
    },
    chat: {
      startRun: vi.fn(),
      resumeRun: vi.fn(),
      onRunEvent: vi.fn().mockReturnValue(() => {})
    },
    agent: {
      getCapabilityPreview: vi.fn()
    },
    workspace: {
      selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: null })
    },
    window: {
      close: vi.fn().mockResolvedValue({ ok: true, data: { closed: true } }),
      minimize: vi.fn().mockResolvedValue({
        ok: true,
        data: { maximized: false, minimized: true, fullscreen: false }
      }),
      toggleMaximize: vi.fn().mockResolvedValue({
        ok: true,
        data: { maximized: true, minimized: false, fullscreen: false }
      })
    },
    files: {
      selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: null })
    }
  } as unknown as RocPreloadApi;
  return { api };
}
