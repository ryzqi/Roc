import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiagnosticPackagePanel } from '../../src/renderer/views/diagnostics/DiagnosticPackagePanel';
import { DiagnosticsView } from '../../src/renderer/views/diagnostics/DiagnosticsView';
import { GitView } from '../../src/renderer/views/git/GitView';
import { PerformancePanel } from '../../src/renderer/views/diagnostics/PerformancePanel';
import { PreviewView } from '../../src/renderer/views/preview/PreviewView';
import { TerminalView } from '../../src/renderer/views/terminal/TerminalView';
import { WorkspaceView } from '../../src/renderer/views/workspace/WorkspaceView';
import { createLoadedState } from './view-test-helpers';

describe('workspace and diagnostics surfaces', () => {
  it('renders workspace view with section surfaces instead of legacy cards', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceView, {
        loadState: { status: 'ready', error: null, key: 'workspace' },
        onSelectWorkspace: async () => {},
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
          },
          gitStatus: {
            workspacePath: 'F:\\Code\\Roc',
            isRepository: true,
            branch: 'main',
            porcelain: [' M README.md'],
            changes: [],
            changedFiles: 1
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
        })
      })
    );

    expect(html).toContain('data-testid="workspace-view"');
    expect(html).toContain('workspace-surface-grid');
    expect(html).toContain('section-title">文件操作预览');
    expect(html).toContain('section-title">工作区状态');
    expect(html).not.toContain('card-title');
    expect(html).not.toContain('class="card"');
  });

  it('renders preview view with unified preview surfaces', () => {
    const html = renderToStaticMarkup(
      React.createElement(PreviewView, {
        loadState: { status: 'ready', error: null, key: 'preview' },
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          filePreview: {
            relativePath: 'README.md',
            kind: 'text',
            content: '# Preview',
            truncated: false,
            sizeBytes: 123
          },
          fileSearch: {
            query: 'Preview',
            truncated: false,
            matches: [
              {
                relativePath: 'README.md',
                line: 1,
                column: 1,
                preview: '# Preview'
              }
            ]
          }
        })
      })
    );

    expect(html).toContain('data-testid="preview-view"');
    expect(html).toContain('preview-surface-grid');
    expect(html).toContain('preview-surface');
    expect(html).toContain('搜索命中');
    expect(html).not.toContain('card-title');
  });

  it('renders workspace view PDF previews through the shared text fallback contract', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceView, {
        loadState: { status: 'ready', error: null, key: 'workspace' },
        onSelectWorkspace: async () => {},
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          filePreview: {
            relativePath: 'docs/spec.pdf',
            kind: 'binary',
            content: 'PDF 文件需要在文件工作台中预览。',
            truncated: false,
            sizeBytes: 1024,
            mediaType: 'application/pdf'
          }
        })
      })
    );

    expect(html).toContain('PDF 文件需要在文件工作台中预览。');
    expect(html).not.toContain('application/pdf');
  });

  it('renders preview view PDF previews through shared preview text without iframe UI', () => {
    const html = renderToStaticMarkup(
      React.createElement(PreviewView, {
        loadState: { status: 'ready', error: null, key: 'preview' },
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            lastOpenedAt: '2026-05-16T08:00:00.000Z',
            trustState: 'trusted'
          },
          filePreview: {
            relativePath: 'docs/spec.pdf',
            kind: 'binary',
            content: 'PDF 文件需要在文件工作台中预览。',
            truncated: false,
            sizeBytes: 1024,
            mediaType: 'application/pdf'
          },
          fileSearch: null
        })
      })
    );

    expect(html).toContain('PDF 文件需要在文件工作台中预览。');
    expect(html).not.toContain('iframe');
  });

  it('renders terminal view with section copy and shell surface', () => {
    const html = renderToStaticMarkup(
      React.createElement(TerminalView, {
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
        })
      })
    );

    expect(html).toContain('data-testid="terminal-view"');
    expect(html).toContain('terminal-surface');
    expect(html).toContain('section-title">命令执行边界');
    expect(html).not.toContain('card-title');
  });

  it('renders git view with stat row and section surfaces', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitView, {
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
            changes: [],
            changedFiles: 1
          }
        })
      })
    );

    expect(html).toContain('data-testid="git-view"');
    expect(html).toContain('class="stat-row"');
    expect(html).toContain('class="section"');
    expect(html).not.toContain('card-title');
  });

  it('renders diagnostics in single-panel form', () => {
    const state = createLoadedState({
      diagnosticPackage: {
        id: 'pkg-1',
        taskId: 'task-1',
        path: 'F:\\Code\\Roc\\.artifacts\\pkg.zip',
        createdAt: '2026-05-16T08:00:00.000Z',
        includes: ['task_snapshot', 'performance_sample'],
        redacted: true
      },
      performanceSample: {
        id: 'perf-1',
        sampledAt: '2026-05-16T08:00:00.000Z',
        mode: 'test',
        uptimeSeconds: 42,
        rssMb: 128,
        heapUsedMb: 48,
        heapTotalMb: 96,
        memoryBudgetMb: 256,
        exceedsBudget: false,
        timing: {
          generatedAt: '2026-05-16T08:00:00.000Z',
          samples: []
        },
        ipc: {
          generatedFromSamples: 0,
          totalCalls: 0,
          topLimit: 5,
          topSlowCalls: [],
          topFrequentCalls: [],
          windowSetBoundsCalls: 0
        },
        electron: {
          browserWindowCount: 0,
          processCount: 0,
          processMetrics: []
        }
      },
      diagnosticChecks: [
        {
          id: 'scheduler_running',
          label: '调度器运行',
          status: 'pass',
          severity: 'info',
          message: '调度器正在运行。',
          checkedAt: '2026-05-16T08:00:00.000Z'
        },
        {
          id: 'scheduler_missed_runs_recent',
          label: '近期错过调度',
          status: 'warn',
          severity: 'warning',
          message: '过去 24 小时存在 1 条 skipped 调度。',
          checkedAt: '2026-05-16T08:00:00.000Z'
        }
      ],
      taskSnapshot: {
        generatedAt: '2026-05-16T08:00:00.000Z',
        counts: {
          total: 1,
          running: 0,
          failed: 1,
          pendingConfirmation: 0
        },
        threads: [],
        recentEvents: [
          {
            id: 'event-1',
            threadId: 'thread-1',
            runId: 'run-1',
            type: 'error',
            payload: {},
            createdAt: '2026-05-16T08:00:00.000Z'
          }
        ]
      }
    });

    const diagnosticsHtml = renderToStaticMarkup(
      React.createElement(DiagnosticsView, {
        loadState: { status: 'ready', error: null, key: 'diagnostics' },
        state
      })
    );

    expect(diagnosticsHtml).toContain('data-testid="diagnostics-view"');
    expect(diagnosticsHtml).toContain('class="single-panel"');
    expect(diagnosticsHtml).toContain('task_snapshot');
    expect(diagnosticsHtml).toContain('调度器运行');
    expect(diagnosticsHtml).toContain('近期错过调度');
    expect(diagnosticsHtml).not.toContain('card-title');
  });

  it('renders diagnostic package and performance panels as section blocks', () => {
    const diagnosticHtml = renderToStaticMarkup(
      React.createElement(DiagnosticPackagePanel, {
        diagnosticPackage: {
          id: 'pkg-1',
          taskId: 'task-1',
          path: 'F:\\Code\\Roc\\.artifacts\\pkg.zip',
          createdAt: '2026-05-16T08:00:00.000Z',
          includes: ['task_snapshot'],
          redacted: true
        }
      })
    );
    const performanceHtml = renderToStaticMarkup(
      React.createElement(PerformancePanel, {
        performanceSample: {
          id: 'perf-1',
          sampledAt: '2026-05-16T08:00:00.000Z',
          mode: 'test',
          uptimeSeconds: 42,
          rssMb: 128,
        heapUsedMb: 48,
        heapTotalMb: 96,
        memoryBudgetMb: 256,
        exceedsBudget: false,
        timing: {
          generatedAt: '2026-05-16T08:00:00.000Z',
          samples: [
            {
              id: 'timing-1',
              phase: 'provider_first_token',
              label: 'nvidia:model',
              startedAtMs: 1,
              durationMs: 42,
              metadata: {
                providerId: 'nvidia',
                modelId: 'model'
              }
            }
          ]
        },
        ipc: {
          generatedFromSamples: 1,
          totalCalls: 0,
          topLimit: 5,
          topSlowCalls: [],
          topFrequentCalls: [],
          windowSetBoundsCalls: 0
        },
        electron: {
          browserWindowCount: 0,
          processCount: 0,
          processMetrics: []
        }
      }
    })
  );

    expect(diagnosticHtml).toContain('class="section"');
    expect(diagnosticHtml).toContain('task_snapshot');
    expect(diagnosticHtml).not.toContain('card-title');

    expect(performanceHtml).toContain('class="section"');
    expect(performanceHtml).toContain('class="stat-row"');
    expect(performanceHtml).toContain('metric-value');
    expect(performanceHtml).toContain('metric-label');
    expect(performanceHtml).toContain('metric-note');
    expect(performanceHtml).toContain('Electron/Chromium/Node 基线内');
    expect(performanceHtml).toContain('Provider 首 token');
    expect(performanceHtml).toContain('42');
    expect(performanceHtml).not.toContain('正常');
    expect(performanceHtml).not.toContain('card-title');
  });
});
