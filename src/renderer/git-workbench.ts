import type { GitBranchListResult, ShellConfirmationRequest } from '../shared/types';

const GIT_SPLIT_MIN_WIDTH = 320;
const GIT_SPLIT_MAX_WIDTH = 720;
export const GIT_SPLIT_DEFAULT_WIDTH = 410;

type GitBranchSwitcherModelInput = {
  actionBusy: boolean;
  branchInfo: GitBranchListResult | null;
  branchSearch: string;
};

type GitCommitButtonStateInput = {
  actionBusy: boolean;
  changedFiles: number;
  commitMessage: string;
};

type GitSelectablePath = {
  relativePath: string;
};

type GitDiffPreviewRequestInput = {
  failedPath: string | null;
  loadingPath: string | null;
  selectedPath: string | null;
  selectedPreview: { relativePath: string } | null;
};

export function clampGitSplitWidth(width: number): number {
  return Math.min(GIT_SPLIT_MAX_WIDTH, Math.max(GIT_SPLIT_MIN_WIDTH, Math.round(width)));
}

export function selectAllGitChanges<T extends GitSelectablePath>(changes: T[]): string[] {
  return changes.map((change) => change.relativePath);
}

export function buildGitCommitButtonState({
  actionBusy,
  changedFiles,
  commitMessage
}: GitCommitButtonStateInput): {
  enabled: boolean;
} {
  return {
    enabled: !actionBusy && changedFiles > 0 && commitMessage.trim().length > 0
  };
}

export function buildGitCreateBranchConfirmationRequest({
  workspacePath,
  branchName,
  checkoutAfterCreate
}: {
  workspacePath: string;
  branchName: string;
  checkoutAfterCreate: boolean;
}): ShellConfirmationRequest {
  return {
    title: 'Git 分支确认',
    message: checkoutAfterCreate
      ? `确认在工作区 ${workspacePath} 创建并切换到分支 ${branchName} 吗？`
      : `确认在工作区 ${workspacePath} 创建分支 ${branchName} 吗？`,
    confirmLabel: '确认',
    cancelLabel: '取消'
  };
}

export function buildGitCheckoutBranchConfirmationRequest({
  workspacePath,
  targetBranch
}: {
  workspacePath: string;
  targetBranch: string;
}): ShellConfirmationRequest {
  return {
    title: 'Git 分支确认',
    message: `确认在工作区 ${workspacePath} 切换到分支 ${targetBranch} 吗？`,
    confirmLabel: '确认',
    cancelLabel: '取消'
  };
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

export function buildGitDiffPreviewRequest({
  failedPath,
  loadingPath,
  selectedPath,
  selectedPreview
}: GitDiffPreviewRequestInput): { relativePath: string } | null {
  if (selectedPath === null) {
    return null;
  }
  if (loadingPath === selectedPath) {
    return null;
  }
  if (failedPath === selectedPath) {
    return null;
  }
  if (selectedPreview !== null && selectedPreview.relativePath === selectedPath) {
    return null;
  }
  return { relativePath: selectedPath };
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
