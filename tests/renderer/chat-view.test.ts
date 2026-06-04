import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildChatResumeRunRequest, ChatView } from '../../src/renderer/chat/chat-view';
import { buildManualScrollBottomOptions, buildStreamingAutoFollowScrollOptions } from '../../src/renderer/chat/chat-transcript-panel';
import { applyChatRunEventBatch } from '../../src/renderer/chat/use-chat-run';
import { createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { bubbleEnterTransition, resolveMotionTransition } from '../../src/renderer/animations';
import { createLoadedState } from './view-test-helpers';

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('window', {
    roc: {
      chat: {
        onRunEvent: () => () => {},
        resumeRun: async () => ({ ok: true })
      },
      tasks: {
        getThreadMessages: async () => ({ ok: true, data: [] })
      },
      files: {
        selectFromDialog: async () => ({ ok: true, data: null })
      }
    }
  });
  Object.defineProperty(globalThis.window, 'roc', {
    configurable: true,
    value: globalThis.window.roc
  });
});

describe('chat view', () => {
  it('renders the new centered empty-state copy when there is no transcript yet', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatView, {
        chatSelectionVersion: 1,
        client: createChatClient(),
        queuedTaskPrompt: null,
        onQueuedTaskPromptHandled: () => {},
        selectedThreadId: null,
        state: createLoadedState({}),
        updateLoadedState: () => {},
        onSubmitChatTask: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('data-testid="chat-empty-state"');
    expect(html).toContain('Roc 本地工作台');
    expect(html).toContain('问问 Roc 或交给它一个任务');
    expect(html).toContain('class="chat-bottom-stack chat-bottom-stack--empty"');
  });

  it('does not add extra bottom offset for the empty chat composer layout', () => {
    const entryCss = readFileSync('src/renderer/styles/main.css', 'utf8');
    const chatCss = readFileSync('src/renderer/styles/chat.css', 'utf8');

    expect(entryCss).toContain("@import './chat.css';");
    expect(chatCss).toContain('.chat-bottom-stack--empty {');
    expect(chatCss).toContain('padding: 0;');
    expect(chatCss).not.toContain('.chat-bottom-stack--empty {\r\n  justify-items: center;\r\n  padding: 0 0 36px;');
    expect(chatCss).not.toContain('.chat-bottom-stack--empty {\n  justify-items: center;\n  padding: 0 0 36px;');
  });

  it('applies many chat deltas as one bounded frame batch', () => {
    const state = createEmptyChatRunState();
    const events = [
      {
        type: 'run_started' as const,
        runId: 'run_perf',
        mode: 'chat' as const,
        threadId: null,
        providerId: 'provider',
        modelId: 'model',
        createdAt: '2026-05-20T00:00:00.000Z'
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        type: 'message_delta' as const,
        runId: 'run_perf',
        delta: String(index % 10)
      }))
    ];

    const next = applyChatRunEventBatch(state, events);

    expect(next.runId).toBe('run_perf');
    expect(next.assistantMessage).toHaveLength(100);
    expect(next.assistantMessage).toBe('0123456789'.repeat(10));
  });

  it('keeps streaming auto-follow scroll instant in the hot path', () => {
    const options = buildStreamingAutoFollowScrollOptions(1234);

    expect(options).toEqual({ top: 1234 });
    expect('behavior' in options).toBe(false);
  });

  it('uses smooth scroll only for manual bottom jumps when motion is allowed', () => {
    expect(buildManualScrollBottomOptions(1234, false)).toEqual({ top: 1234, behavior: 'smooth' });
    expect(buildManualScrollBottomOptions(1234, true)).toEqual({ top: 1234 });
  });

  it('keeps chat reasoning animation off layout-affecting max-height', () => {
    const chatCss = readFileSync('src/renderer/styles/chat.css', 'utf8');
    const reasoningAnimation = chatCss.match(/@keyframes reasoning-expand \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(reasoningAnimation).not.toContain('max-height');
    expect(reasoningAnimation).toContain('opacity');
    expect(reasoningAnimation).toContain('transform');
  });

  it('disables motion durations when the system requests reduced motion', () => {
    const originalMatchMedia = globalThis.window.matchMedia;
    globalThis.window.matchMedia = vi.fn().mockReturnValue({ matches: true });

    try {
      expect(resolveMotionTransition(bubbleEnterTransition)).toEqual({ duration: 0 });
    } finally {
      globalThis.window.matchMedia = originalMatchMedia;
    }
  });

  it('builds approval resume IPC requests with a decisions array', () => {
    expect(
      buildChatResumeRunRequest({
        runId: 'run_approval',
        threadId: 'thread_approval',
        interruptId: 'interrupt-approval',
        decisions: [
          {
            type: 'approve'
          }
        ]
      })
    ).toEqual({
      runId: 'run_approval',
      threadId: 'thread_approval',
      interruptId: 'interrupt-approval',
      decisions: [
        {
          type: 'approve'
        }
      ]
    });
  });
});

function createChatClient(): RocClient {
  return { api: globalThis.window.roc as RocPreloadApi };
}
