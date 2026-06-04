// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeature } from '../../../src/renderer/features/chat';
import { createChatFeatureActions } from '../../../src/renderer/features/chat/use-chat-feature';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import { createLoadedState } from '../view-test-helpers';

describe('chat feature actions', () => {
  it('starts, resumes, cancels, and subscribes through the RocClient api', async () => {
    const client = createChatClient();
    const actions = createChatFeatureActions(client);
    const listener = vi.fn();

    await actions.startRun({
      enabledCapabilities: { mcpServers: ['filesystem'], skills: ['planner'] },
      input: '整理当前变更',
      mode: 'task',
      threadId: 'thread-1',
      workflowHint: 'propose_background_task'
    });
    await actions.resumeRun({
      decisions: [{ type: 'approve' }],
      interruptId: 'interrupt-1',
      runId: 'run-1',
      threadId: 'thread-1'
    });
    await actions.cancelRun('run-1');
    actions.subscribeRunEvents(listener);

    expect(client.api.chat.startRun).toHaveBeenCalledWith({
      enabledCapabilities: { mcpServers: ['filesystem'], skills: ['planner'] },
      input: '整理当前变更',
      mode: 'task',
      threadId: 'thread-1',
      workflowHint: 'propose_background_task'
    });
    expect(client.api.chat.resumeRun).toHaveBeenCalledWith({
      decisions: [{ type: 'approve' }],
      interruptId: 'interrupt-1',
      runId: 'run-1',
      threadId: 'thread-1'
    });
    expect(client.api.chat.cancelRun).toHaveBeenCalledWith('run-1');
    expect(client.api.chat.onRunEvent).toHaveBeenCalledWith(listener);
  });
});

describe('ChatFeature', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('loads selected thread transcript messages through RocClient tasks api', async () => {
    const client = createChatClient();
    const state = createLoadedState({
      taskSnapshot: {
        generatedAt: '2026-05-09T08:30:00.000Z',
        counts: {
          total: 1,
          running: 0,
          failed: 0,
          pendingConfirmation: 0
        },
        threads: [
          {
            id: 'thread-current',
            kind: 'chat',
            title: '当前会话',
            goal: '当前会话',
            status: 'completed',
            createdAt: '2026-05-09T08:00:00.000Z',
            updatedAt: '2026-05-09T08:30:00.000Z'
          }
        ],
        recentEvents: [
          {
            id: 'message-current',
            threadId: 'thread-current',
            runId: 'run-current',
            type: 'message',
            payload: { role: 'assistant', content: '截断回复' },
            createdAt: '2026-05-09T08:30:00.000Z'
          }
        ]
      }
    });

    await act(async () => {
      root.render(
        <ChatFeature
          chatSelectionVersion={1}
          client={client}
          onQueuedTaskPromptHandled={() => {}}
          onSubmitChatTask={async () => ({ ok: true as const })}
          queuedTaskPrompt={null}
          selectedThreadId="thread-current"
          state={state}
          updateLoadedState={() => {}}
        />
      );
    });
    await flushPromises();

    expect(client.api.tasks.getThreadMessages).toHaveBeenCalledWith({ threadId: 'thread-current' });
    expect(container.textContent).toContain('完整回复');
  });
});

function createChatClient(): RocClient {
  const api = {
    chat: {
      startRun: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          runId: 'run-1',
          mode: 'task',
          threadId: 'thread-1',
          providerId: 'provider-1',
          modelId: 'model-1',
          createdAt: '2026-05-09T08:00:00.000Z'
        }
      }),
      cancelRun: vi.fn().mockResolvedValue({ ok: true, data: { cancelled: true } }),
      resumeRun: vi.fn().mockResolvedValue({ ok: true, data: { resumed: true } }),
      onRunEvent: vi.fn().mockReturnValue(() => {})
    },
    tasks: {
      getThreadMessages: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            id: 'message-full',
            threadId: 'thread-current',
            runId: 'run-current',
            type: 'message',
            payload: { role: 'assistant', content: '完整回复' },
            createdAt: '2026-05-09T08:30:00.000Z'
          }
        ]
      })
    },
    files: {
      selectFromDialog: vi.fn()
    }
  } as unknown as RocPreloadApi;
  return { api };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
