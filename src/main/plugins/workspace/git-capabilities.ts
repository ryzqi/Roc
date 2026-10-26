import type {
  GitBatchFileOperationRequest,
  GitCancelRequest,
  GitCheckoutBranchRequest,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitFileOperationRequest,
  GitPushRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { GitService } from '../../services/git-service';

const pluginId = '@roc/plugin-workspace';

export function registerGitCapabilities(
  context: RocPluginContext,
  descriptors: readonly CapabilityDescriptor[],
  gitService: GitService,
  cancelDescriptor: CapabilityDescriptor<GitCancelRequest, boolean>
): void {
  context.capabilities.register(pluginId, descriptors[0], async () => await gitService.getStatus());
  context.capabilities.register(pluginId, descriptors[1], async () => await gitService.getDiffStat());
  context.capabilities.register(pluginId, descriptors[2], async (input) =>
    await gitService.getFileDiff((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[3], async (input) =>
    await gitService.stageFile((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[4], async (input) =>
    await gitService.stageFiles((input as GitBatchFileOperationRequest).relativePaths)
  );
  context.capabilities.register(pluginId, descriptors[5], async (input) =>
    await gitService.unstageFile((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[6], async (input) =>
    await gitService.discardFileChanges((input as GitFileOperationRequest).relativePath)
  );
  context.capabilities.register(pluginId, descriptors[7], async (input) =>
    await gitService.commit((input as GitCommitRequest).message)
  );
  context.capabilities.register(pluginId, descriptors[8], async (input) =>
    await gitService.push({ operationId: (input as GitPushRequest).operationId })
  );
  context.capabilities.register(pluginId, descriptors[9], async () => await gitService.listBranches());
  context.capabilities.register(pluginId, descriptors[10], async (input) => {
    const request = input as GitCreateBranchRequest;
    return await gitService.createBranch(request.name, request.checkoutAfterCreate);
  });
  context.capabilities.register(pluginId, descriptors[11], async (input) =>
    await gitService.checkoutBranch((input as GitCheckoutBranchRequest).name)
  );
  context.capabilities.register(pluginId, cancelDescriptor, async (input) =>
    gitService.cancelOperation((input as GitCancelRequest).operationId)
  );
}
