export type GitStatusResult = {
  workspacePath: string;
  isRepository: true;
  branch: string;
  porcelain: string[];
  changes: GitStatusChange[];
  changedFiles: number;
};

export type GitStatusChange = {
  porcelain: string;
  index: string;
  worktree: string;
  relativePath: string;
  originalPath?: string;
};

export type GitDiffStatResult = {
  workspacePath: string;
  stat: string;
};

export type GitFileDiffResult = {
  workspacePath: string;
  relativePath: string;
  patch: string;
};

export type GitFileOperationRequest = {
  relativePath: string;
};

export type GitBatchFileOperationRequest = {
  relativePaths: string[];
};

export type GitCommitRequest = {
  message: string;
};

export type GitBranchSummary = {
  name: string;
  current: boolean;
};

export type GitBranchListResult = {
  workspacePath: string;
  currentBranch: string;
  branches: GitBranchSummary[];
};

export type GitCreateBranchRequest = {
  name: string;
  checkoutAfterCreate: boolean;
};

export type GitCheckoutBranchRequest = {
  name: string;
};

export type GitBranchMutationResult = {
  workspacePath: string;
  branchInfo: GitBranchListResult;
  status: GitStatusResult;
};

export type GitCommitResult = {
  workspacePath: string;
  commitMessage: string;
  commitSha: string;
  status: GitStatusResult;
};

export type GitPushResult = {
  workspacePath: string;
  remoteName: string;
  branch: string;
  status: GitStatusResult;
  output: string;
};
