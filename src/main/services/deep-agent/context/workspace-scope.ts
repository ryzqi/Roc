import { buildWorkspaceHash } from '../../paths';

export type RuntimeWorkspaceIdentity = {
  path: string;
  hash: string;
};

export function resolveRuntimeWorkspaceIdentity(workspacePath: string | null): RuntimeWorkspaceIdentity | null {
  if (workspacePath === null) {
    return null;
  }
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    throw new Error('workspace_path_empty');
  }
  return {
    path: trimmed,
    hash: buildWorkspaceHash(trimmed)
  };
}

export function resolveSessionSearchWorkspaceHash(input: {
  scope: 'current' | 'all';
  runtimeWorkspacePath: string | null;
}): string | null {
  if (input.scope === 'all') {
    return null;
  }
  const identity = resolveRuntimeWorkspaceIdentity(input.runtimeWorkspacePath);
  if (identity === null) {
    throw new Error('session_search_workspace_required');
  }
  return identity.hash;
}
