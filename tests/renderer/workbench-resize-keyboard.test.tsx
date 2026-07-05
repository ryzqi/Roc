// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesWorkbench } from '../../src/renderer/workbench/FilesWorkbench';
import { GitWorkbench } from '../../src/renderer/workbench/GitWorkbench';
import { WorkbenchPanel } from '../../src/renderer/workbench/WorkbenchPanel';
import { createLoadedState } from './view-test-helpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('workbench resize separator keyboard controls', () => {
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

  it('resizes the right workbench panel with horizontal arrow keys', async () => {
    const onWidthChange = vi.fn();
    await act(async () => {
      root.render(
        <WorkbenchPanelHarness onWidthChange={onWidthChange} />
      );
    });

    keydown(queryElement('workbench-resize-handle'), 'ArrowLeft');

    expect(onWidthChange).toHaveBeenCalledWith(536);
    expect(queryElement('workbench-resize-handle').getAttribute('aria-valuenow')).toBe('536');
  });

  it('resizes the files tree pane with horizontal arrow keys', async () => {
    await act(async () => {
      root.render(
        <FilesWorkbench
          loadState={{ status: 'ready', error: null, key: 'workspace' }}
          state={createLoadedState({
            workspace: createWorkspace(),
            fileTree: {
              workspacePath: 'F:\\Code\\Roc',
              relativePath: '',
              truncated: false,
              entries: []
            }
          })}
          updateWorkspaceData={() => {}}
        />
      );
    });

    keydown(queryElement('workbench-file-splitter'), 'ArrowRight');

    expect(queryElementByClass('workbench-files').style.getPropertyValue('--file-pane-width')).toBe('320px');
    expect(queryElement('workbench-file-splitter').getAttribute('aria-valuenow')).toBe('320');
  });

  it('resizes the git change pane and clamps to the maximum width', async () => {
    await act(async () => {
      root.render(
        <GitWorkbench
          loadState={{ status: 'ready', error: null, key: 'git' }}
          state={createLoadedState({
            workspace: createWorkspace(),
            gitStatus: {
              workspacePath: 'F:\\Code\\Roc',
              isRepository: true,
              branch: 'main',
              porcelain: [],
              changes: [],
              changedFiles: 0
            }
          })}
          updateWorkspaceData={() => {}}
        />
      );
    });

    keydown(queryElement('workbench-git-splitter'), 'End');

    expect(queryElementByClass('workbench-git').style.getPropertyValue('--git-pane-width')).toBe('720px');
    expect(queryElement('workbench-git-splitter').getAttribute('aria-valuenow')).toBe('720');
  });

  function queryElement(testId: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (element === null) {
      throw new Error(`${testId}_missing`);
    }
    return element;
  }

  function queryElementByClass(className: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`.${className}`);
    if (element === null) {
      throw new Error(`${className}_missing`);
    }
    return element;
  }
});

function WorkbenchPanelHarness({ onWidthChange }: { onWidthChange: (width: number) => void }): React.JSX.Element {
  const [width, setWidth] = useState(520);
  function handleWidthChange(nextWidth: number): void {
    onWidthChange(nextWidth);
    setWidth(nextWidth);
  }
  return (
    <WorkbenchPanel
      activeTool="files"
      activeView="chat"
      onClose={() => {}}
      onToolChange={() => {}}
      onWidthChange={handleWidthChange}
      state={createLoadedState({})}
      updateWorkspaceData={() => {}}
      width={width}
      windowState={{ maximized: false, minimized: false, fullscreen: false }}
      workspaceLoadState={{ status: 'ready', error: null, key: 'workspace' }}
    />
  );
}

function keydown(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function createWorkspace(): NonNullable<ReturnType<typeof createLoadedState>['workspace']> {
  return {
    id: 'workspace-1',
    path: 'F:\\Code\\Roc',
    displayName: 'Roc',
    lastOpenedAt: '2026-05-16T08:00:00.000Z',
    trustState: 'trusted'
  };
}
