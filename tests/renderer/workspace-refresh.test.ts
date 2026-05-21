import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRunEvent, Workspace } from '../../src/shared/types';
import {
  createWorkspaceRefreshController,
  createWorkspaceRefreshSubscription,
  shouldRefreshWorkspaceForRunEvent,
  type WorkspaceLiveData
} from '../../src/renderer/app/workspace-refresh';

const workspace: Workspace = {
  id: 'workspace-1',
  path: 'F:\\Code\\Roc',
  displayName: 'Roc',
  lastOpenedAt: '2026-05-20T00:00:00.000Z',
  trustState: 'trusted'
};

const refreshedWorkspaceData: WorkspaceLiveData = {
  fileTree: {
    workspacePath: workspace.path,
    relativePath: '',
    truncated: false,
    entries: [
      {
        name: 'README.md',
        relativePath: 'README.md',
        type: 'file',
        size: 123,
        updatedAt: '2026-05-20T00:00:00.000Z'
      }
    ]
  },
  filePreview: null,
  fileWorkbenchPdfPreview: null,
  gitStatus: {
    workspacePath: workspace.path,
    isRepository: true,
    branch: 'main',
    porcelain: [],
    changes: [],
    changedFiles: 0
  },
  gitBranches: {
    workspacePath: workspace.path,
    currentBranch: 'main',
    branches: [{ current: true, name: 'main' }]
  },
  gitError: null,
  gitSelectedPath: null,
  gitSelectedPreview: null
};

describe('workspace refresh helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes only for confirmed workspace-mutating tool completions', () => {
    const deleteEvent: ChatRunEvent = {
      type: 'tool_event',
      runId: 'run-delete',
      event: 'end',
      name: 'delete_file',
      data: { relativePath: 'notes.md' }
    };
    const writeFileEvent: ChatRunEvent = {
      type: 'tool_event',
      runId: 'run-write',
      event: 'end',
      name: 'write_file',
      data: { relativePath: 'notes.md' }
    };
    const readOnlyExecuteEvent: ChatRunEvent = {
      type: 'tool_event',
      runId: 'run-execute',
      event: 'end',
      name: 'execute',
      data: { command: 'git status' }
    };
    const mutatingExecuteEvent: ChatRunEvent = {
      type: 'tool_event',
      runId: 'run-execute-write',
      event: 'end',
      name: 'execute',
      data: { command: 'Remove-Item notes.md' }
    };
    const webSearchEvent: ChatRunEvent = {
      type: 'tool_event',
      runId: 'run-web-search',
      event: 'end',
      name: 'web_search',
      data: { query: 'roc renderer' }
    };

    expect(shouldRefreshWorkspaceForRunEvent(deleteEvent)).toBe(true);
    expect(shouldRefreshWorkspaceForRunEvent(writeFileEvent)).toBe(true);
    expect(shouldRefreshWorkspaceForRunEvent(readOnlyExecuteEvent)).toBe(false);
    expect(shouldRefreshWorkspaceForRunEvent(mutatingExecuteEvent)).toBe(true);
    expect(shouldRefreshWorkspaceForRunEvent(webSearchEvent)).toBe(false);
  });

  it('schedules a workspace refresh after delete_file completes', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => refreshedWorkspaceData);
    const apply = vi.fn();
    const controller = createWorkspaceRefreshController({
      readSnapshot: () => ({
        workspace,
        previewRelativePath: 'notes.md',
        fileWorkbenchPdfRelativePath: null
      }),
      load,
      apply,
      onError: vi.fn()
    });

    controller.handleRunEvent({
      type: 'tool_event',
      runId: 'run-delete',
      event: 'end',
      name: 'delete_file',
      data: { relativePath: 'notes.md' }
    });

    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();

    expect(load).toHaveBeenCalledWith(workspace, {
      previewRelativePath: 'notes.md',
      fileWorkbenchPdfRelativePath: null,
      fallbackToFirstFilePreview: false
    });
    expect(apply).toHaveBeenCalledWith(workspace.path, refreshedWorkspaceData);
  });

  it('ignores non-mutating tool completions', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => refreshedWorkspaceData);
    const controller = createWorkspaceRefreshController({
      readSnapshot: () => ({
        workspace,
        previewRelativePath: null,
        fileWorkbenchPdfRelativePath: null
      }),
      load,
      apply: vi.fn(),
      onError: vi.fn()
    });

    controller.handleRunEvent({
      type: 'tool_event',
      runId: 'run-search',
      event: 'end',
      name: 'web_search',
      data: { query: 'roc renderer' }
    });

    await vi.runAllTimersAsync();

    expect(load).not.toHaveBeenCalled();
  });

  it('keeps a pending workspace refresh alive when the latest snapshot changes before the timer fires', async () => {
    vi.useFakeTimers();
    let runEventListener: ((event: ChatRunEvent) => void) | null = null;
    const load = vi.fn(async () => refreshedWorkspaceData);
    const apply = vi.fn();
    const subscription = createWorkspaceRefreshSubscription({
      initialSnapshot: {
        workspace,
        previewRelativePath: 'before-delete.md',
        fileWorkbenchPdfRelativePath: null,
        gitSelectedPath: 'before-delete.md'
      },
      load,
      apply,
      onError: vi.fn(),
      subscribe: (listener) => {
        runEventListener = listener;
        return () => {
          runEventListener = null;
        };
      }
    });

    const listener = runEventListener as ((event: ChatRunEvent) => void) | null;
    if (listener === null) {
      throw new Error('run event listener was not registered');
    }

    listener({
      type: 'tool_event',
      runId: 'run-delete',
      event: 'end',
      name: 'delete_file',
      data: { relativePath: 'notes.md' }
    });
    subscription.updateSnapshot({
      workspace,
      previewRelativePath: 'after-delete.md',
      fileWorkbenchPdfRelativePath: null,
      gitSelectedPath: 'after-delete.md'
    });

    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();

    expect(load).toHaveBeenCalledWith(workspace, {
      previewRelativePath: 'after-delete.md',
      fileWorkbenchPdfRelativePath: null,
      fallbackToFirstFilePreview: false,
      gitSelectedPath: 'after-delete.md'
    });
    expect(apply).toHaveBeenCalledWith(workspace.path, refreshedWorkspaceData);

    subscription.dispose();
    expect(runEventListener).toBeNull();
  });

  it('preserves files workbench PDF selection separately from shared preview state', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ({
      ...refreshedWorkspaceData,
      fileWorkbenchPdfPreview: {
        relativePath: 'docs/spec.pdf',
        resourceUrl: 'roc-preview://workspace/pdf/docs%2Fspec.pdf',
        sizeBytes: 1024,
        mediaType: 'application/pdf' as const
      }
    }));
    const apply = vi.fn();
    const errors: string[] = [];
    const listenerRef: { current: ((event: ChatRunEvent) => void) | null } = { current: null };

    const subscription = createWorkspaceRefreshSubscription({
      initialSnapshot: {
        workspace,
        previewRelativePath: null,
        fileWorkbenchPdfRelativePath: 'docs/spec.pdf',
        gitSelectedPath: null
      },
      load,
      apply,
      onError: (message) => {
        errors.push(message);
      },
      subscribe: (nextListener) => {
        listenerRef.current = nextListener;
        return () => {
          listenerRef.current = null;
        };
      }
    });

    const runEventListener = listenerRef.current;
    if (runEventListener === null) {
      throw new Error('run event listener was not registered');
    }

    runEventListener({
      type: 'tool_event',
      runId: 'run-delete',
      event: 'end',
      name: 'delete_file',
      data: { relativePath: 'docs/spec.pdf' }
    });

    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();

    expect(load).toHaveBeenCalledWith(workspace, {
      previewRelativePath: null,
      fileWorkbenchPdfRelativePath: 'docs/spec.pdf',
      fallbackToFirstFilePreview: false,
      gitSelectedPath: null
    });
    expect(apply).toHaveBeenCalledWith(workspace.path, {
      ...refreshedWorkspaceData,
      fileWorkbenchPdfPreview: {
        relativePath: 'docs/spec.pdf',
        resourceUrl: 'roc-preview://workspace/pdf/docs%2Fspec.pdf',
        sizeBytes: 1024,
        mediaType: 'application/pdf'
      }
    });
    expect(errors).toEqual([]);

    subscription.dispose();
  });
});
