import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WindowWorkband } from '../../src/renderer/app/WindowWorkband';
import { buildTopMeta } from '../../src/renderer/app/view-routing';
import { createLoadedState } from './view-test-helpers';

describe('WindowWorkband', () => {
  it('renders chat top meta as the workspace label without the message count', () => {
    const state = createLoadedState({
      appStatus: {
        ...createLoadedState({}).appStatus,
        workspace: {
          selectedPath: 'F:\\Code\\Roc',
          label: 'Roc'
        }
      },
      taskSnapshot: {
        ...createLoadedState({}).taskSnapshot,
        recentEvents: [
          {
            id: 'event-1',
            threadId: 'thread-1',
            runId: 'run-1',
            type: 'message',
            payload: { role: 'user', content: '帮我检查工作区' },
            createdAt: '2026-05-25T08:00:00.000Z'
          },
          {
            id: 'event-2',
            threadId: 'thread-1',
            runId: 'run-1',
            type: 'message',
            payload: { role: 'assistant', content: '已检查。' },
            createdAt: '2026-05-25T08:00:01.000Z'
          }
        ]
      }
    });

    const html = renderToStaticMarkup(
      React.createElement(WindowWorkband, {
        activeView: 'chat',
        chatSidebarCollapsed: false,
        onHistorySearchToggle: vi.fn(),
        onNewConversation: vi.fn(),
        onSidebarToggle: vi.fn(),
        onWindowClose: vi.fn(),
        onWindowMaximizeToggle: vi.fn(),
        onWindowMinimize: vi.fn(),
        showHistorySearch: false,
        topMeta: buildTopMeta('chat', state),
        windowState: { maximized: false, minimized: false, fullscreen: false }
      })
    );

    expect(html).toContain('data-testid="window-workband"');
    expect(html).toContain('Roc');
    expect(html).not.toContain('条消息');
  });
});
