import { describe, expect, it } from 'vitest';

import {
  resolveRuntimeWorkspaceIdentity,
  resolveSessionSearchWorkspaceHash
} from '../../../../../src/main/services/deep-agent/context/workspace-scope';
import { buildWorkspaceHash } from '../../../../../src/main/services/paths';

describe('workspace scope utilities', () => {
  it('derives workspace hash from the real Windows workspace path', () => {
    const identity = resolveRuntimeWorkspaceIdentity('F:\\Code\\Roc');

    expect(identity).toEqual({
      path: 'F:\\Code\\Roc',
      hash: buildWorkspaceHash('F:\\Code\\Roc')
    });
  });

  it('returns null identity when no workspace exists', () => {
    expect(resolveRuntimeWorkspaceIdentity(null)).toBeNull();
  });

  it('requires a runtime workspace for current scoped session search', () => {
    expect(() =>
      resolveSessionSearchWorkspaceHash({
        scope: 'current',
        runtimeWorkspacePath: null
      })
    ).toThrow('session_search_workspace_required');
  });

  it('does not require workspace hash for all scoped session search', () => {
    expect(
      resolveSessionSearchWorkspaceHash({
        scope: 'all',
        runtimeWorkspacePath: null
      })
    ).toBeNull();
  });
});
