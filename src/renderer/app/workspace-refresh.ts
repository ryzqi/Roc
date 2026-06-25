import type { ChatRunEvent, Workspace, WorkspaceChangedEvent } from '../../shared/types';
import type { WorkspaceData } from './types';

const workspaceMutationToolNames = new Set(['delete_file', 'write_file', 'edit_file']);
const refreshDelayMs = 150;
const mutatingExecutePrefixes = [
  'remove-item',
  'rm',
  'del',
  'erase',
  'move-item',
  'mv',
  'ren',
  'rename-item',
  'copy-item',
  'cp',
  'new-item',
  'ni',
  'set-content',
  'add-content',
  'out-file',
  'set-itemproperty',
  'git add',
  'git rm',
  'git mv',
  'git restore',
  'git checkout',
  'git clean',
  'git reset'
] as const;

export type WorkspaceLiveData = Pick<
  WorkspaceData,
  | 'fileTree'
  | 'filePreview'
  | 'fileWorkbenchPdfPreview'
  | 'gitStatus'
  | 'gitBranches'
  | 'gitError'
  | 'gitSelectedPath'
  | 'gitSelectedPreview'
>;

export type WorkspaceRefreshSnapshot = {
  workspace: Workspace | null;
  previewRelativePath: string | null;
  fileWorkbenchPdfRelativePath: string | null;
  gitSelectedPath?: string | null;
};

export function shouldRefreshWorkspaceForRunEvent(event: ChatRunEvent): boolean {
  if (event.type !== 'assistant_block' || event.block.kind !== 'tool_call' || event.block.phase !== 'end') {
    return false;
  }
  if (workspaceMutationToolNames.has(event.block.name)) {
    return true;
  }
  if (event.block.name !== 'execute') {
    return false;
  }
  const outputCommand = readExecuteCommand(event.block.output);
  if (outputCommand !== null) {
    return isMutatingExecuteCommand(outputCommand);
  }
  const inputCommand = readExecuteCommand(event.block.input);
  if (inputCommand === null) {
    return false;
  }
  return isMutatingExecuteCommand(inputCommand);
}

export function createWorkspaceRefreshController(input: {
  readSnapshot: () => WorkspaceRefreshSnapshot;
  load: (
    workspace: Workspace,
    options: {
      previewRelativePath: string | null;
      fileWorkbenchPdfRelativePath: string | null;
      fallbackToFirstFilePreview: boolean;
      gitSelectedPath?: string | null;
    }
  ) => Promise<WorkspaceLiveData>;
  apply: (workspacePath: string, data: WorkspaceLiveData) => void;
  onError: (message: string) => void;
}): {
  dispose: () => void;
  handleWorkspaceChanged: (event: WorkspaceChangedEvent) => void;
  handleRunEvent: (event: ChatRunEvent) => void;
} {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let refreshInFlight = false;
  let refreshRequested = false;

  async function runRefresh(): Promise<void> {
    if (refreshInFlight) {
      refreshRequested = true;
      return;
    }
    refreshInFlight = true;
    try {
      do {
        refreshRequested = false;
        const snapshot = input.readSnapshot();
        if (snapshot.workspace === null) {
          return;
        }
        try {
          const data = await input.load(snapshot.workspace, {
            previewRelativePath: snapshot.previewRelativePath,
            fileWorkbenchPdfRelativePath: snapshot.fileWorkbenchPdfRelativePath,
            fallbackToFirstFilePreview: false,
            gitSelectedPath: snapshot.gitSelectedPath
          });
          if (disposed) {
            return;
          }
          input.apply(snapshot.workspace.path, data);
        } catch (error) {
          if (disposed) {
            return;
          }
          input.onError(error instanceof Error ? error.message : '工作区刷新失败。');
        }
      } while (refreshRequested && !disposed);
    } finally {
      refreshInFlight = false;
    }
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void runRefresh();
    }, refreshDelayMs);
  }

  return {
    dispose(): void {
      disposed = true;
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },
    handleRunEvent(event: ChatRunEvent): void {
      if (!shouldRefreshWorkspaceForRunEvent(event)) {
        return;
      }
      scheduleRefresh();
    },
    handleWorkspaceChanged(event: WorkspaceChangedEvent): void {
      const snapshot = input.readSnapshot();
      if (snapshot.workspace === null) {
        return;
      }
      if (!isSameWorkspacePath(snapshot.workspace.path, event.workspacePath)) {
        return;
      }
      scheduleRefresh();
    }
  };
}

export function createWorkspaceRefreshSubscription(input: {
  initialSnapshot: WorkspaceRefreshSnapshot;
  load: (
    workspace: Workspace,
    options: {
      previewRelativePath: string | null;
      fileWorkbenchPdfRelativePath: string | null;
      fallbackToFirstFilePreview: boolean;
      gitSelectedPath?: string | null;
    }
  ) => Promise<WorkspaceLiveData>;
  apply: (workspacePath: string, data: WorkspaceLiveData) => void;
  onError: (message: string) => void;
  subscribe: (listener: (event: ChatRunEvent) => void) => () => void;
  subscribeWorkspaceChanges?: (listener: (event: WorkspaceChangedEvent) => void) => () => void;
}): {
  dispose: () => void;
  updateSnapshot: (snapshot: WorkspaceRefreshSnapshot) => void;
} {
  let snapshot = input.initialSnapshot;
  const controller = createWorkspaceRefreshController({
    readSnapshot: () => snapshot,
    load: input.load,
    apply: input.apply,
    onError: input.onError
  });
  const unsubscribe = input.subscribe((event) => {
    controller.handleRunEvent(event);
  });
  const unsubscribeWorkspaceChanges =
    input.subscribeWorkspaceChanges === undefined
      ? null
      : input.subscribeWorkspaceChanges((event) => {
          controller.handleWorkspaceChanged(event);
        });

  return {
    dispose(): void {
      unsubscribe();
      if (unsubscribeWorkspaceChanges !== null) {
        unsubscribeWorkspaceChanges();
      }
      controller.dispose();
    },
    updateSnapshot(nextSnapshot: WorkspaceRefreshSnapshot): void {
      snapshot = nextSnapshot;
    }
  };
}

function readExecuteCommand(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  if (!('command' in data)) {
    return null;
  }
  const command = (data as { command?: unknown }).command;
  return typeof command === 'string' && command.trim().length > 0 ? command : null;
}

function isMutatingExecuteCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return mutatingExecutePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isSameWorkspacePath(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}
