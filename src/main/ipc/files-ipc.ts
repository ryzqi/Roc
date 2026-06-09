import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { ipcChannels } from '../../shared/ipc';
import type { Workspace } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

type CurrentWorkspaceProvider = {
  getCurrentWorkspace(): Promise<Workspace | null> | Workspace | null;
};

export function registerFilesDialogIpc(
  timedHandle: TimedHandle,
  mainWindow: BrowserWindow,
  workspaceProvider: CurrentWorkspaceProvider
): void {
  timedHandle(ipcChannels.filesSelectFromDialog, () =>
    wrapIpc(async () => {
      if (process.env.ROC_SMOKE === '1') {
        const smokeWorkspace = await workspaceProvider.getCurrentWorkspace();
        if (smokeWorkspace !== null) {
          return {
            filePaths: [`${smokeWorkspace.path}\\phase-three-notes.txt`]
          };
        }
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择文件',
        properties: ['openFile', 'multiSelections']
      });
      if (result.canceled) {
        return null;
      }
      return {
        filePaths: result.filePaths
      };
    })
  );
}
