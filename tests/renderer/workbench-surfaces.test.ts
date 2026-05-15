import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesWorkbench } from '../../src/renderer/workbench/FilesWorkbench';
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

    expect(html).toContain('data-testid="terminal-session-surface"');
    expect(html).toContain('terminal-shell-frame');
    expect(html).toContain('PowerShell');
  });
});
