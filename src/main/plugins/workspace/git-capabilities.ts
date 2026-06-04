import type {
  GitBatchFileOperationRequest,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCheckoutBranchRequest,
  GitCommitRequest,
  GitCommitResult,
  GitCreateBranchRequest,
  GitDiffStatResult,
  GitFileDiffResult,
  GitFileOperationRequest,
  GitPushResult,
  GitStatusResult
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { GitService } from '../../services/git-service';

const pluginId = '@roc/plugin-workspace';

export function registerGitCapabilities(
  context: RocPluginContext,
  descriptors: readonly CapabilityDescriptor[],
  gitService: GitService
): void {
  context.capabilities.register(pluginId, descriptors[0], async () => gitService.getStatusAsync());
  context.capabilities.register(pluginId, descriptors[1], async () => gitService.getDiffStatAsync());
  context.capabilities.register(pluginId, descriptors[2], async (input) =>
    gitService.getFileDiffAsync((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[3], async (input) =>
    gitService.stageFile((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[4], async (input) =>
    gitService.stageFiles((input as GitBatchFileOperationRequest).relativePaths)
  );
  context.capabilities.register(pluginId, descriptors[5], async (input) =>
    gitService.unstageFile((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[6], async (input) =>
    gitService.discardFileChanges((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[7], async (input) =>
    gitService.commit((input as GitCommitRequest).message)
  );
  context.capabilities.register(pluginId, descriptors[8], async () => gitService.push());
  context.capabilities.register(pluginId, descriptors[9], async () => gitService.listBranchesAsync());
  context.capabilities.register(pluginId, descriptors[10], async (input) => {
    const request = input as GitCreateBranchRequest;
    return gitService.createBranch(request.name, request.checkoutAfterCreate);
  });
  context.capabilities.register(pluginId, descriptors[11], async (input) =>
    gitService.checkoutBranch((input as GitCheckoutBranchRequest).name)
  );
}

export type WorkspaceGitCapabilityTypes = {
  status: {
    input: Record<string, never>;
    output: GitStatusResult;
  };
  diffStat: {
    input: Record<string, never>;
    output: GitDiffStatResult;
  };
  fileDiff: {
    input: GitFileOperationRequest;
    output: GitFileDiffResult;
  };
  stageFile: {
    input: GitFileOperationRequest;
    output: GitStatusResult;
  };
  stageFiles: {
    input: GitBatchFileOperationRequest;
    output: GitStatusResult;
  };
  unstageFile: {
    input: GitFileOperationRequest;
    output: GitStatusResult;
  };
  discardFile: {
    input: GitFileOperationRequest;
    output: GitStatusResult;
  };
  commit: {
    input: GitCommitRequest;
    output: GitCommitResult;
  };
  push: {
    input: Record<string, never>;
    output: GitPushResult;
  };
  listBranches: {
    input: Record<string, never>;
    output: GitBranchListResult;
  };
  createBranch: {
    input: GitCreateBranchRequest;
    output: GitBranchMutationResult;
  };
  checkoutBranch: {
    input: GitCheckoutBranchRequest;
    output: GitBranchMutationResult;
  };
};
