import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesWorkbench } from '../../src/renderer/workbench/FilesWorkbench';
import { GitBranchPopover } from '../../src/renderer/workbench/GitBranchPopover';
import { GitDiffPanel } from '../../src/renderer/workbench/GitDiffPanel';
import { GitWorkbench } from '../../src/renderer/workbench/GitWorkbench';
import { TerminalWorkbench } from '../../src/renderer/workbench/TerminalWorkbench';
import { createLoadedState } from './view-test-helpers';

describe('workbench surfaces', () => {
  it('renders files workbench with neutral explorer copy and rounded surfaces', () => {
    const html = renderToStaticMarkup(
      React.createElement(FilesWorkbench, {
        loadState: { status: 'ready', error: null, key: 'workspace' },
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          fileTree: {
            workspacePath: 'F:\\Code\\Roc',
            relativePath: '',
            truncated: false,
            entries: [
              {
                name: 'README.md',
                relativePath: 'README.md',
                type: 'file',
                size: 123,
                updatedAt: '2026-05-16T08:00:00.000Z'
              }
            ]
          },
          filePreview: {
            relativePath: 'README.md',
            kind: 'text',
            content: '# Preview',
            truncated: false,
            sizeBytes: 123
          }
        }),
        updateWorkspaceData: () => {}
      })
    );

    expect(html).toContain('data-testid="workbench-file-tree"');
    expect(html).toContain('pane-title">文件树');
    expect(html).toContain('workbench-surface workbench-surface--files');
    expect(html).not.toContain('EXPLORER');
  });

  it('renders git workbench without legacy uppercase section labels', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitWorkbench, {
        loadState: { status: 'ready', error: null, key: 'git' },
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          gitStatus: {
            workspacePath: 'F:\\Code\\Roc',
            isRepository: true,
            branch: 'main',
            porcelain: [' M README.md'],
            changes: [
              {
                relativePath: 'README.md',
                porcelain: ' M README.md',
                index: ' ',
                worktree: 'M'
              }
            ],
            changedFiles: 1
          }
        }),
        updateWorkspaceData: () => {}
      })
    );

    expect(html).toContain('data-testid="workbench-git-changes"');
    expect(html).toContain('待提交变更');
    expect(html).toContain('工作区变更');
    expect(html).not.toContain('STAGED CHANGES');
    expect(html).not.toContain('CHANGES');
  });

  it('renders git branch popover with filtered branches and preserved creation controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitBranchPopover, {
        actionBusy: false,
        branchDraft: 'feature/new-worktree',
        branchSearch: 'feature',
        checkoutAfterCreate: true,
        visibleBranches: [
          { current: false, name: 'feature/alpha' },
          { current: true, name: 'feature/beta' }
        ],
        onBranchDraftChange: () => {},
        onBranchSearchChange: () => {},
        onCheckoutAfterCreateChange: () => {},
        onCheckoutBranch: async () => {},
        onClose: () => {},
        onCreateBranch: async () => {}
      })
    );

    expect(html).toContain('data-testid="git-branch-controls"');
    expect(html).toContain('data-testid="git-branch-select"');
    expect(html).toContain('data-testid="git-branch-create-input"');
    expect(html).toContain('data-testid="git-branch-create-checkout"');
    expect(html).toContain('data-testid="git-branch-create"');
    expect(html).toContain('feature/alpha');
    expect(html).toContain('feature/beta');
    expect(html).toContain('checkout');
    expect(html).not.toContain('main');
  });

  it('renders git diff panel with selected path and unified diff preview anchor', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitDiffPanel, {
        failedPath: null,
        loadingPath: null,
        selectedChange: {
          relativePath: 'src/renderer/App.tsx',
          porcelain: ' M src/renderer/App.tsx',
          index: ' ',
          worktree: 'M'
        },
        selectedDiffFile: {
          oldPath: 'src/renderer/App.tsx',
          newPath: 'src/renderer/App.tsx',
          type: 'modify',
          hunks: [
            {
              content: '@@ -1 +1 @@',
              oldStart: 1,
              newStart: 1,
              oldLines: 1,
              newLines: 1,
              changes: []
            }
          ]
        } as never,
        selectionPreview: {
          workspacePath: 'F:\\Code\\Roc',
          relativePath: 'src/renderer/App.tsx',
          patch:
            'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n--- a/src/renderer/App.tsx\n+++ b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
        },
        state: createLoadedState({})
      })
    );

    expect(html).toContain('data-testid="workbench-git-selection"');
    expect(html).toContain('data-testid="workbench-git-selection-path"');
    expect(html).toContain('data-testid="workbench-git-selection-preview"');
    expect(html).toContain('src/renderer/App.tsx');
    expect(html).toContain('工作区修改');
    expect(html).toContain('modify');
  });

  it('renders git diff panel failure copy when the selected file preview failed', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitDiffPanel, {
        failedPath: 'README.md',
        loadingPath: null,
        selectedChange: {
          relativePath: 'README.md',
          porcelain: ' M README.md',
          index: ' ',
          worktree: 'M'
        },
        selectedDiffFile: null,
        selectionPreview: null,
        state: createLoadedState({
          gitStatus: {
            workspacePath: 'F:\\Code\\Roc',
            isRepository: true,
            branch: 'main',
            porcelain: [' M README.md'],
            changes: [
              {
                relativePath: 'README.md',
                porcelain: ' M README.md',
                index: ' ',
                worktree: 'M'
              }
            ],
            changedFiles: 1
          }
        })
      })
    );

    expect(html).toContain('当前文件 diff 加载失败。');
    expect(html).toContain('README.md');
  });

  it('renders terminal workbench with session shell surface contract', () => {
    const html = renderToStaticMarkup(
      React.createElement(TerminalWorkbench, {
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          terminalSession: {
            id: 'terminal-1',
            cwd: 'F:\\Code\\Roc',
            shell: 'pwsh',
            cols: 120,
            rows: 32,
            status: 'ready',
            exitCode: null
          }
        }),
        updateWorkspaceData: () => {},
        windowState: { maximized: false, minimized: false, fullscreen: false }
      })
    );

    expect(html).toContain('data-testid="terminal-xterm"');
    expect(html).toContain('workbench-surface--terminal');
    expect(html).not.toContain('PowerShell');
  });
});
