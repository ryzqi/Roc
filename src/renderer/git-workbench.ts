import type { GitBranchListResult, GitStatusChange } from '../shared/types';

export const GIT_SPLIT_MIN_WIDTH = 320;
export const GIT_SPLIT_MAX_WIDTH = 720;
export const GIT_SPLIT_DEFAULT_WIDTH = 410;

type GitBranchSwitcherModelInput = {
  actionBusy: boolean;
  branchInfo: GitBranchListResult | null;
  branchSearch: string;
};

type GitSelectablePath = {
  relativePath: string;
};

export function clampGitSplitWidth(width: number): number {
  return Math.min(GIT_SPLIT_MAX_WIDTH, Math.max(GIT_SPLIT_MIN_WIDTH, Math.round(width)));
}

export function selectAllGitChanges<T extends GitSelectablePath>(changes: T[]): string[] {
  return changes.map((change) => change.relativePath);
}

export function buildGitSelectionModel<T extends GitSelectablePath>(changes: T[], selectedPaths: string[]): {
  allSelectableSelected: boolean;
  selectedCount: number;
} {
  const selectedPathSet = new Set(selectedPaths);
  return {
    selectedCount: selectedPaths.length,
    allSelectableSelected: changes.length > 0 && changes.every((change) => selectedPathSet.has(change.relativePath))
  };
}

export function buildGitBranchSwitcherModel({
  actionBusy,
  branchInfo,
  branchSearch
}: GitBranchSwitcherModelInput): {
  creationEntry: {
    visible: true;
  };
  visibleBranches: Array<{ current: boolean; name: string }>;
  searchDisabled: boolean;
} {
  const normalizedSearch = branchSearch.trim().toLocaleLowerCase();
  const visibleBranches =
    branchInfo?.branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalizedSearch)) ?? [];

  return {
    creationEntry: {
      visible: true
    },
    visibleBranches,
    searchDisabled: actionBusy
  };
}

export function selectedGitPaths(paths: string[]): Set<string> {
  return new Set(paths);
}

export function gitSelectableChanges(status: { changes: GitStatusChange[] } | null): GitStatusChange[] {
  return status?.changes ?? [];
}
