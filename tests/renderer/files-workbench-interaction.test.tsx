// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesWorkbench } from '../../src/renderer/workbench/FilesWorkbench';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { FileTreeResult, Workspace } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

const workspace: Workspace = {
  id: 'workspace-1',
  path: 'F:\\Code\\Roc',
  displayName: 'Roc',
  lastOpenedAt: '2026-05-16T08:00:00.000Z',
  trustState: 'trusted'
};

const rootTree: FileTreeResult = {
  workspacePath: workspace.path,
  relativePath: '',
  truncated: false,
  entries: [
    {
      name: 'src',
      relativePath: 'src',
      type: 'directory',
      size: 0,
      updatedAt: '2026-05-16T08:00:00.000Z'
    }
  ]
};

describe('FilesWorkbench interactions', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps an expanded directory open after the root file tree refreshes', async () => {
    const client = createFilesClient();
    const state = createLoadedState({
      workspace,
      fileTree: rootTree,
      filePreview: null
    });

    await act(async () => {
      root.render(
        <FilesWorkbench
          client={client}
          loadState={{ status: 'ready', error: null, key: workspace.path }}
          state={state}
          updateWorkspaceData={() => {}}
        />
      );
    });

    const directoryButton = container.querySelector<HTMLButtonElement>('[data-testid="workbench-directory-src"]');
    expect(directoryButton).not.toBeNull();
    await act(async () => {
      directoryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="workbench-file-src-App.tsx"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <FilesWorkbench
          client={client}
          loadState={{ status: 'ready', error: null, key: workspace.path }}
          state={createLoadedState({
            workspace,
            fileTree: { ...rootTree, entries: [...rootTree.entries] },
            filePreview: null
          })}
          updateWorkspaceData={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="workbench-file-src-App.tsx"]')).not.toBeNull();
  });
});

function createFilesClient(): RocClient {
  const api = {
    files: {
      listTree: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          workspacePath: workspace.path,
          relativePath: 'src',
          truncated: false,
          entries: [
            {
              name: 'App.tsx',
              relativePath: 'src/App.tsx',
              type: 'file',
              size: 256,
              updatedAt: '2026-05-16T08:00:00.000Z'
            }
          ]
        }
      }),
      preview: vi.fn(),
      previewPdf: vi.fn()
    }
  } as unknown as RocPreloadApi;
  return { api };
}
