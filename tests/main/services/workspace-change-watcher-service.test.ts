import { describe, expect, it, vi } from 'vitest';

import { WorkspaceChangeWatcherService } from '../../../src/main/services/workspace-change-watcher-service';
import type { WorkspaceChangedEvent } from '../../../src/shared/types';

describe('WorkspaceChangeWatcherService', () => {
  it('publishes debounced workspace change events from the active workspace watcher', async () => {
    vi.useFakeTimers();
    const changes: WorkspaceChangedEvent[] = [];
    const close = vi.fn();
    const watcherCallbackRef: { current: ((eventType: string, filename: string | Buffer | null) => void) | null } = {
      current: null
    };
    const service = new WorkspaceChangeWatcherService({
      debounceMs: 25,
      logger: { warn: vi.fn() },
      onChange: async (event) => {
        changes.push(event);
      },
      watch: vi.fn((_path, _options, listener) => {
        watcherCallbackRef.current = listener;
        return { close, on: vi.fn() };
      })
    });

    service.setWorkspace('F:\\Code\\Roc');
    const watcherCallback = watcherCallbackRef.current;
    if (watcherCallback === null) {
      throw new Error('workspace watcher was not registered');
    }

    watcherCallback('rename', 'src\\new-file.ts');
    watcherCallback('change', 'src\\new-file.ts');
    await vi.advanceTimersByTimeAsync(25);

    expect(changes).toEqual([
      {
        workspacePath: 'F:\\Code\\Roc',
        relativePath: 'src/new-file.ts',
        eventType: 'change'
      }
    ]);

    service.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores noisy generated directories but keeps .git changes for Git status refreshes', async () => {
    vi.useFakeTimers();
    const changes: WorkspaceChangedEvent[] = [];
    const watcherCallbackRef: { current: ((eventType: string, filename: string | Buffer | null) => void) | null } = {
      current: null
    };
    const service = new WorkspaceChangeWatcherService({
      debounceMs: 25,
      logger: { warn: vi.fn() },
      onChange: async (event) => {
        changes.push(event);
      },
      watch: vi.fn((_path, _options, listener) => {
        watcherCallbackRef.current = listener;
        return { close: vi.fn(), on: vi.fn() };
      })
    });

    service.setWorkspace('F:\\Code\\Roc');
    const watcherCallback = watcherCallbackRef.current;
    if (watcherCallback === null) {
      throw new Error('workspace watcher was not registered');
    }

    watcherCallback('change', 'node_modules\\pkg\\index.js');
    watcherCallback('change', '.git\\index');
    await vi.advanceTimersByTimeAsync(25);

    expect(changes).toEqual([
      {
        workspacePath: 'F:\\Code\\Roc',
        relativePath: '.git/index',
        eventType: 'change'
      }
    ]);

    service.shutdown();
    vi.useRealTimers();
  });

  it('retries the same workspace path after a watcher start failure', () => {
    const watch = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('watch failed');
      })
      .mockImplementationOnce(() => ({ close: vi.fn(), on: vi.fn() }));
    const service = new WorkspaceChangeWatcherService({
      logger: { warn: vi.fn() },
      onChange: vi.fn(),
      watch
    });

    service.setWorkspace('F:\\Code\\Roc');
    service.setWorkspace('F:\\Code\\Roc');

    expect(watch).toHaveBeenCalledTimes(2);
    service.shutdown();
  });

  it('closes the watcher and retries after an asynchronous watcher error', () => {
    const close = vi.fn();
    const errorListenerRef: { current: ((error: Error) => void) | null } = { current: null };
    const logger = { warn: vi.fn() };
    const watch = vi.fn((_path, _options, _listener) => ({
      close,
      on: (event: string, listener: (error: Error) => void) => {
        if (event === 'error') {
          errorListenerRef.current = listener;
        }
        return undefined;
      }
    }));
    const service = new WorkspaceChangeWatcherService({
      logger,
      onChange: vi.fn(),
      watch
    });

    service.setWorkspace('F:\\Code\\Roc');
    const errorListener = errorListenerRef.current;
    if (errorListener === null) {
      throw new Error('watcher error listener was not registered');
    }

    errorListener(new Error('permission changed'));
    service.setWorkspace('F:\\Code\\Roc');

    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Workspace change watcher failed after start.',
      expect.objectContaining({
        workspacePath: 'F:\\Code\\Roc',
        error: 'permission changed'
      })
    );
    expect(watch).toHaveBeenCalledTimes(2);
    service.shutdown();
  });
});
