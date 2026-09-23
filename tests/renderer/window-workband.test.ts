import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WindowWorkband } from '../../src/renderer/app/WindowWorkband';

describe('WindowWorkband', () => {
  it('shows new project and settings on the project list', () => {
    const html = renderToStaticMarkup(
      React.createElement(WindowWorkband, {
        activeView: 'research',
        onNewConversation: vi.fn(),
        onNewProject: vi.fn(),
        onOpenSettings: vi.fn(),
        onReturnToProjects: vi.fn(),
        researchContext: null,
        topMeta: '研究项目'
      })
    );
    expect(html).toContain('data-testid="research-top-new-project"');
    expect(html).toContain('data-testid="settings-gear"');
    expect(html).toContain('研究项目');
    expect(html).not.toContain('brand-mark');
    expect(html).not.toContain('microscope');
    expect(html).not.toContain('data-testid="research-shell-all-projects"');
    expect(html).not.toContain('data-testid="chat-new-conversation"');
  });

  it('shows all-projects and the current title inside a research project', () => {
    const html = renderToStaticMarkup(
      React.createElement(WindowWorkband, {
        activeView: 'chat',
        onNewConversation: vi.fn(),
        onNewProject: vi.fn(),
        onOpenSettings: vi.fn(),
        onReturnToProjects: vi.fn(),
        researchContext: {
          projectId: 'research_1',
          projectTitle: '证据图',
          currentStage: 'writing',
          workspacePath: '/tmp/project'
        },
        topMeta: 'Roc'
      })
    );
    expect(html).toContain('data-testid="research-shell-all-projects"');
    expect(html).toContain('证据图');
    expect(html).toContain('data-testid="settings-gear"');
    expect(html).toContain('data-testid="chat-new-conversation"');
  });
});
