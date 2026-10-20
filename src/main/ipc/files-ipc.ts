import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { join } from 'node:path';
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
      /**
       * Test seam (`ROC_SMOKE=1`), registered in `docs/README.md` § 测试 seam.
       *
       * The smoke harness and the eight verification gates drive the packaged app through
       * Playwright, which cannot answer a native `showOpenDialog`. They need a path that
       * always yields a file, so this returns the workspace's seeded
       * `assets/smoke-image.png` (written by `tests/smoke/lib/fixtures.mjs`) instead of
       * opening the panel. The env-var gate is what keeps it out of a normal run: this is the
       * harness's entry point, not a fallback used when the dialog is unavailable.
       */
      if (process.env.ROC_SMOKE === '1') {
        const smokeWorkspace = await workspaceProvider.getCurrentWorkspace();
        if (smokeWorkspace !== null) {
          return {
            filePaths: [join(smokeWorkspace.path, 'assets', 'smoke-image.png')]
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
