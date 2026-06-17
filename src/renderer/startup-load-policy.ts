export type StartupLoadViewId =
  | 'chat'
  | 'tasks-board'
  | 'task-detail'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';

export type StartupWorkbenchTool = 'files' | 'git' | 'terminal';

export type StartupLoadTarget = 'workspace' | 'memory' | 'operations' | 'taskSurface';

export type StartupLoadIntent = {
  targets: Set<StartupLoadTarget>;
};

export type StartupLoadPolicyInput = {
  activeView: StartupLoadViewId;
  activeWorkbenchTool: StartupWorkbenchTool;
  workbenchVisible: boolean;
  includeOperations?: boolean;
};

const WORKSPACE_VIEWS = new Set<StartupLoadViewId>(['workspace', 'git', 'preview']);
const OPERATIONS_VIEWS = new Set<StartupLoadViewId>(['diagnostics']);
const WORKSPACE_WORKBENCH_TOOLS = new Set<StartupWorkbenchTool>(['files', 'git']);

export function getStartupLoadIntent(input: StartupLoadPolicyInput): StartupLoadIntent {
  const targets = new Set<StartupLoadTarget>();

  if (WORKSPACE_VIEWS.has(input.activeView)) {
    targets.add('workspace');
  }

  if (
    input.activeView === 'chat' &&
    input.workbenchVisible &&
    WORKSPACE_WORKBENCH_TOOLS.has(input.activeWorkbenchTool)
  ) {
    targets.add('workspace');
  }

  if (input.activeView === 'memory') {
    targets.add('memory');
  }

  if (input.activeView === 'tasks-board' || input.activeView === 'task-detail') {
    targets.add('taskSurface');
  }

  if (OPERATIONS_VIEWS.has(input.activeView) || input.includeOperations === true) {
    targets.add('operations');
  }

  return { targets };
}
