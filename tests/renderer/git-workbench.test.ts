import { describe, expect, it } from 'vitest';
import {
  buildGitBranchSwitcherModel,
  buildGitCommitButtonState,
  buildGitSelectionModel,
  clampGitSplitWidth,
  selectAllGitChanges
} from '../../src/renderer/git-workbench';

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
});
