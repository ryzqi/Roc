// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalWorkbench } from '../../src/renderer/workbench/TerminalWorkbench';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { TerminalSessionSnapshot } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

const terminalMockState = vi.hoisted(() => ({
  disposedCount: 0,
  writes: [] as string[]
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;

    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(data: string): void {
      terminalMockState.writes.push(data);
    }
    onData(): { dispose: () => void } {
      return { dispose: vi.fn() };
    }
    dispose(): void {
      terminalMockState.disposedCount += 1;
    }
  }
}));

describe('TerminalWorkbench', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    terminalMockState.disposedCount = 0;
    terminalMockState.writes = [];
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('closes a terminal session that resolves after the workbench is disposed', async () => {
    const createdSession = createTerminalSession('terminal-orphan');
    const deferredCreate = createDeferred({
      ok: true as const,
      data: createdSession
    });
    const closeSession = vi.fn(async () => ({ ok: true as const, data: { closed: true as const } }));
    const client = createTerminalClient({
      createSession: vi.fn(() => deferredCreate.promise),
      closeSession
    });

    await act(async () => {
      root.render(
        <TerminalWorkbench
          client={client}
          state={createLoadedState({
            workspace: createWorkspace(),
            terminalSession: null,
            terminalError: null
          })}
          updateWorkspaceData={() => {}}
          windowState={{ maximized: false, minimized: false, fullscreen: false }}
        />
      );
    });

    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      deferredCreate.resolve({
        ok: true,
        data: createdSession
      });
      await deferredCreate.promise;
    });

    expect(closeSession).toHaveBeenCalledWith({ sessionId: 'terminal-orphan' });
  });
});

function createWorkspace(): NonNullable<ReturnType<typeof createLoadedState>['workspace']> {
  return {
    id: 'workspace-1',
    path: 'F:\\Code\\Roc',
    displayName: 'Roc',
    lastOpenedAt: '2026-06-04T00:00:00.000Z',
    trustState: 'trusted'
  };
}

function createTerminalSession(id: string): TerminalSessionSnapshot {
  return {
    id,
    cwd: 'F:\\Code\\Roc',
    shell: 'pwsh',
    cols: 80,
    rows: 24,
    status: 'ready',
    exitCode: null
  };
}

function createTerminalClient({
  createSession,
  closeSession
}: {
  createSession: () => Promise<{ ok: true; data: TerminalSessionSnapshot }>;
  closeSession: (request: { sessionId: string }) => Promise<{ ok: true; data: { closed: true } }>;
}): RocClient {
  return {
    api: {
      terminal: {
        createSession,
        writeInput: vi.fn(async () => ({ ok: true as const, data: { delivered: true as const } })),
        resize: vi.fn(async () => ({ ok: true as const, data: createTerminalSession('terminal-resized') })),
        closeSession,
        onOutput: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn())
      }
    } as unknown as RocPreloadApi
  };
}

function createDeferred<T>(initialValue: T): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value = initialValue) => {
      resolvePromise(value);
    }
  };
}
