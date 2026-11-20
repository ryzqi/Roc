export const workspacePathStructureChangedEventType = 'workspace.path-structure-changed';

export type WorkspacePathStructureChangedPayload = {
  workspacePath: string;
  reason: string;
};

export type WorkspacePathStructureChangeNotifier = (workspacePath: string, reason: string) => void;
