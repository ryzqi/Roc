import type {
  GitBatchFileOperationRequest,
  GitCheckoutBranchRequest,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitFileOperationRequest
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
