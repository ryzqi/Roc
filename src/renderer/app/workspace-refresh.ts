import type { ChatRunEvent, Workspace } from '../../shared/types';
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
  'fileTree' | 'filePreview' | 'gitStatus' | 'gitBranches' | 'gitError' | 'gitSelectedPath' | 'gitSelectedPreview'
>;

export type WorkspaceRefreshSnapshot = {
  workspace: Workspace | null;
  previewRelativePath: string | null;
  gitSelectedPath?: string | null;
};

export function shouldRefreshWorkspaceForRunEvent(event: ChatRunEvent): boolean {
  if (event.type !== 'tool_event' || event.event !== 'end') {
    return false;
  }
  if (workspaceMutationToolNames.has(event.name)) {
    return true;
  }
  if (event.name !== 'execute') {
    return false;
  }
  const command = readExecuteCommand(event.data);
  if (command === null) {
    return false;
  }
  return isMutatingExecuteCommand(command);
}

export function createWorkspaceRefreshController(input: {
  readSnapshot: () => WorkspaceRefreshSnapshot;
  load: (
    workspace: Workspace,
    options: {
      previewRelativePath: string | null;
      fallbackToFirstFilePreview: boolean;
      gitSelectedPath?: string | null;
    }
  ) => Promise<WorkspaceLiveData>;
  apply: (workspacePath: string, data: WorkspaceLiveData) => void;
  onError: (message: string) => void;
}): {
  dispose: () => void;
  handleRunEvent: (event: ChatRunEvent) => void;
} {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function runRefresh(): Promise<void> {
    const snapshot = input.readSnapshot();
    if (snapshot.workspace === null) {
      return;
    }
    try {
      const data = await input.load(snapshot.workspace, {
        previewRelativePath: snapshot.previewRelativePath,
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
    }
  };
}

export function createWorkspaceRefreshSubscription(input: {
  initialSnapshot: WorkspaceRefreshSnapshot;
  load: (
    workspace: Workspace,
    options: {
      previewRelativePath: string | null;
      fallbackToFirstFilePreview: boolean;
      gitSelectedPath?: string | null;
    }
  ) => Promise<WorkspaceLiveData>;
  apply: (workspacePath: string, data: WorkspaceLiveData) => void;
  onError: (message: string) => void;
  subscribe: (listener: (event: ChatRunEvent) => void) => () => void;
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

  return {
    dispose(): void {
      unsubscribe();
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
