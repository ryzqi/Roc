import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { GitService } from '../services/git-service';
import type { TimedHandle } from './ipc-common';

export function registerGitIpc(timedHandle: TimedHandle, gitService: GitService): void {
  timedHandle(ipcChannels.gitStatus, () => wrapIpc(() => gitService.getStatusAsync()));
  timedHandle(ipcChannels.gitDiffStat, () => wrapIpc(() => gitService.getDiffStatAsync()));
  timedHandle(ipcChannels.gitFileDiff, (_event, request) => wrapIpc(() => gitService.getFileDiffAsync(request.relativePath)));
  timedHandle(ipcChannels.gitStageFile, (_event, request) => wrapIpc(() => gitService.stageFile(request.relativePath)));
  timedHandle(ipcChannels.gitStageFiles, (_event, request) => wrapIpc(() => gitService.stageFiles(request.relativePaths)));
  timedHandle(ipcChannels.gitUnstageFile, (_event, request) => wrapIpc(() => gitService.unstageFile(request.relativePath)));
  timedHandle(ipcChannels.gitDiscardFile, (_event, request) =>
    wrapIpc(() => gitService.discardFileChanges(request.relativePath))
  );
  timedHandle(ipcChannels.gitCommit, (_event, request) => wrapIpc(() => gitService.commit(request.message)));
  timedHandle(ipcChannels.gitPush, () => wrapIpc(() => gitService.push()));
  timedHandle(ipcChannels.gitListBranches, () => wrapIpc(() => gitService.listBranchesAsync()));
  timedHandle(ipcChannels.gitCreateBranch, (_event, request) =>
    wrapIpc(() => gitService.createBranch(request.name, request.checkoutAfterCreate))
  );
  timedHandle(ipcChannels.gitCheckoutBranch, (_event, request) => wrapIpc(() => gitService.checkoutBranch(request.name)));
}
