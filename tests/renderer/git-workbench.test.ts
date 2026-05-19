import { describe, expect, it } from 'vitest';
import {
  buildGitBranchSwitcherModel,
  buildGitCommitButtonState,
  buildGitDiffPreviewRequest,
  buildGitSelectionModel,
  clampGitSplitWidth,
  selectAllGitChanges
} from '../../src/renderer/git-workbench';
import { createGitDiffPreviewController } from '../../src/renderer/workbench/useGitDiffPreview';
import type { GitFileDiffResult } from '../../src/shared/types';

describe('git workbench helpers', () => {
  it('keeps branch creation only in the lower form', () => {
    const model = buildGitBranchSwitcherModel({
      actionBusy: false,
      branchInfo: {
        workspacePath: '/repo',
        currentBranch: 'main',
        branches: [
          { current: true, name: 'main' },
          { current: false, name: 'feature/alpha' }
        ]
      },
      branchSearch: 'feature'
    });

    expect(model.creationEntry.visible).toBe(true);
    expect('createTrigger' in model).toBe(false);
    expect(model.visibleBranches.map((branch) => branch.name)).toEqual(['feature/alpha']);
  });

  it('builds the select-all selection set without starting a stage action', () => {
    const changes = [
      { relativePath: 'a.txt' },
      { relativePath: 'b.txt' },
      { relativePath: 'c.txt' }
    ] as Array<{ relativePath: string }>;

    const selectedPaths = selectAllGitChanges(changes);
    const model = buildGitSelectionModel(changes, selectedPaths);

    expect(selectedPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(model.selectedCount).toBe(3);
    expect(model.allSelectableSelected).toBe(true);
  });

  it('clamps the git split width to the workbench bounds', () => {
    expect(clampGitSplitWidth(0)).toBe(320);
    expect(clampGitSplitWidth(500)).toBe(500);
    expect(clampGitSplitWidth(9999)).toBe(720);
  });

  it('disables commit when the message is only whitespace', () => {
    expect(
      buildGitCommitButtonState({
        actionBusy: false,
        changedFiles: 2,
        commitMessage: '   '
      }).enabled
    ).toBe(false);
  });

  it('enables commit when the message is non-empty and changes exist', () => {
    expect(
      buildGitCommitButtonState({
        actionBusy: false,
        changedFiles: 2,
        commitMessage: 'feat: update notes'
      }).enabled
    ).toBe(true);
  });

  it('disables commit while a git action is in progress', () => {
    expect(
      buildGitCommitButtonState({
        actionBusy: true,
        changedFiles: 2,
        commitMessage: 'feat: update notes'
      }).enabled
    ).toBe(false);
  });

  it('disables commit when no changes are available', () => {
    expect(
      buildGitCommitButtonState({
        actionBusy: false,
        changedFiles: 0,
        commitMessage: 'feat: update notes'
      }).enabled
    ).toBe(false);
  });

  it('requests the selected file diff when the first selected path has no preview yet', () => {
    expect(
      buildGitDiffPreviewRequest({
        failedPath: null,
        loadingPath: null,
        selectedPath: 'src/renderer/App.tsx',
        selectedPreview: null
      })
    ).toEqual({
      relativePath: 'src/renderer/App.tsx'
    });
  });

  it('requests the selected file diff when the current preview belongs to a stale path', () => {
    expect(
      buildGitDiffPreviewRequest({
        failedPath: null,
        loadingPath: null,
        selectedPath: 'src/renderer/styles.css',
        selectedPreview: {
          relativePath: 'src/renderer/App.tsx'
        }
      })
    ).toEqual({
      relativePath: 'src/renderer/styles.css'
    });
  });

  it('does not duplicate a selected file diff request while loading or after a failed attempt', () => {
    expect(
      buildGitDiffPreviewRequest({
        failedPath: null,
        loadingPath: 'src/renderer/App.tsx',
        selectedPath: 'src/renderer/App.tsx',
        selectedPreview: null
      })
    ).toBe(null);
    expect(
      buildGitDiffPreviewRequest({
        failedPath: 'src/renderer/App.tsx',
        loadingPath: null,
        selectedPath: 'src/renderer/App.tsx',
        selectedPreview: null
      })
    ).toBe(null);
  });
});

describe('git diff preview controller', () => {
  it('loads the selected file diff and stores the preview for the same path', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const actionErrors: Array<string | null> = [];
    const controller = createGitDiffPreviewController({
      fileDiff: async ({ relativePath }) => ({
        ok: true,
        data: {
          workspacePath: 'F:\\Code\\Roc',
          relativePath,
          patch: `diff --git a/${relativePath} b/${relativePath}\n--- a/${relativePath}\n+++ b/${relativePath}\n@@ -1 +1 @@\n-old\n+new\n`
        }
      }),
      onActionError: (message) => {
        actionErrors.push(message);
      },
      updateWorkspaceData: (partial) => {
        updates.push(partial);
      }
    });

    await controller.load('src/renderer/App.tsx');

    expect(controller.getState()).toEqual({
      failedPath: null,
      loadingPath: null
    });
    expect(actionErrors).toEqual([null]);
    expect(updates).toEqual([
      {
        gitSelectedPath: 'src/renderer/App.tsx',
        gitSelectedPreview: {
          workspacePath: 'F:\\Code\\Roc',
          relativePath: 'src/renderer/App.tsx',
          patch:
            'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n--- a/src/renderer/App.tsx\n+++ b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
        }
      }
    ]);
  });

  it('marks the path as failed when file diff loading rejects', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const actionErrors: Array<string | null> = [];
    const controller = createGitDiffPreviewController({
      fileDiff: async () => {
        throw new Error('git selected file diff failed: denied');
      },
      onActionError: (message) => {
        actionErrors.push(message);
      },
      updateWorkspaceData: (partial) => {
        updates.push(partial);
      }
    });

    await controller.load('README.md');

    expect(controller.getState()).toEqual({
      failedPath: 'README.md',
      loadingPath: null
    });
    expect(actionErrors).toEqual([null, 'git selected file diff failed: denied']);
    expect(updates).toEqual([
      {
        gitSelectedPath: 'README.md',
        gitSelectedPreview: null
      }
    ]);
  });

  it('ignores stale diff responses after a newer request starts', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const deferred = new Map<
      string,
      {
        resolve: (value: { ok: true; data: GitFileDiffResult }) => void;
      }
    >();
    const controller = createGitDiffPreviewController({
      fileDiff: ({ relativePath }) =>
        new Promise((resolve) => {
          deferred.set(relativePath, { resolve });
        }),
      onActionError: () => {},
      updateWorkspaceData: (partial) => {
        updates.push(partial);
      }
    });

    const firstLoad = controller.load('src/old.ts');
    const secondLoad = controller.load('src/new.ts');

    deferred.get('src/new.ts')?.resolve({
      ok: true,
      data: {
        workspacePath: 'F:\\Code\\Roc',
        relativePath: 'src/new.ts',
        patch: 'diff --git a/src/new.ts b/src/new.ts\n'
      }
    });
    await secondLoad;

    deferred.get('src/old.ts')?.resolve({
      ok: true,
      data: {
        workspacePath: 'F:\\Code\\Roc',
        relativePath: 'src/old.ts',
        patch: 'diff --git a/src/old.ts b/src/old.ts\n'
      }
    });
    await firstLoad;

    expect(controller.getState()).toEqual({
      failedPath: null,
      loadingPath: null
    });
    expect(updates).toEqual([
      {
        gitSelectedPath: 'src/new.ts',
        gitSelectedPreview: {
          workspacePath: 'F:\\Code\\Roc',
          relativePath: 'src/new.ts',
          patch: 'diff --git a/src/new.ts b/src/new.ts\n'
        }
      }
    ]);
  });
});
