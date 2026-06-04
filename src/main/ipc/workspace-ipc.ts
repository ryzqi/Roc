import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import { RocDomainError, wrapIpc } from '../services/errors';
import type { WorkspaceService } from '../services/workspace-service';
import type { TimedHandle } from './ipc-common';

export function registerWorkspaceIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  workspaceService: WorkspaceService
): void {
  timedHandle(ipcChannels.workspaceGetCurrent, () => wrapIpc(() => workspaceService.getCurrentWorkspace()));
  timedHandle(ipcChannels.workspaceSelect, (_event, request) => wrapIpc(() => workspaceService.selectWorkspace(request.path)));
  registerWorkspaceDialogIpc(timedHandle, mainWindow, workspaceService);
}

export function registerWorkspaceDialogIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  workspaceService: WorkspaceService
): void {
  timedHandle(ipcChannels.workspaceSelectFromDialog, () =>
    wrapIpc(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择工作区',
        properties: ['openDirectory']
      });
      if (result.canceled) {
        return null;
      }
      const selectedPath = result.filePaths[0];
      if (selectedPath === undefined) {
        throw new RocDomainError({
          code: 'workspace_dialog_empty_selection',
          message: '没有收到工作区目录。',
          category: 'validation',
          retryable: true,
          userAction: '请重新选择一个目录作为工作区。'
        });
      }
      return workspaceService.selectWorkspace(selectedPath);
    })
  );
}
