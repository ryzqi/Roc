import { describe, expect, it } from 'vitest';
import { appendLiveTranscriptMessages } from '../../src/renderer/chat-transcript';
import { applyChatRunEvent, createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { ChatRunEvent } from '../../src/shared/types';

describe('renderer chat hook events', () => {
  it('ignores hook runtime events without polluting the model-visible transcript', () => {
    const runStarted: ChatRunEvent = {
      type: 'run_started',
      runId: 'run-1',
      mode: 'chat',
      threadId: 'thread-1',
      providerId: 'provider-a',
      modelId: 'model-a',
      createdAt: '2026-06-24T00:00:00.000Z'
    };
    const hookStarted: ChatRunEvent = {
      type: 'hook_started',
      runId: 'run-1',
      hook: {
        runId: 'hook-run-1',
        handlerId: 'PreToolUse:0:0',
        event: 'PreToolUse',
        status: 'running',
        durationMs: null,
        message: 'Checking shell command'
      }
    };
    const assistantBlock: ChatRunEvent = {
      type: 'assistant_block',
      runId: 'run-1',
      block: {
        kind: 'text',
        blockId: 'text-1',
        phase: 'delta',
        text: 'Visible answer'
      }
    };
    const hookCompleted: ChatRunEvent = {
      type: 'hook_completed',
      runId: 'run-1',
      hook: {
        runId: 'hook-run-1',
        handlerId: 'PreToolUse:0:0',
        event: 'PreToolUse',
        status: 'completed',
        durationMs: 12,
        message: 'Hook completed'
      }
    };
    const runCompleted: ChatRunEvent = {
      type: 'run_completed',
      runId: 'run-1',
      threadId: 'thread-1',
      providerId: 'provider-a',
      modelId: 'model-a',
      createdAt: '2026-06-24T00:00:00.000Z',
      durationMs: 25,
      summary: 'done',
      assistantMessage: 'Visible answer'
    };

    const running = applyChatRunEvent(createEmptyChatRunState(), runStarted);
    const afterHookStarted = applyChatRunEvent(running, hookStarted);
    const afterAssistant = applyChatRunEvent(afterHookStarted, assistantBlock);
    const afterHookCompleted = applyChatRunEvent(afterAssistant, hookCompleted);
    const completed = applyChatRunEvent(afterHookCompleted, runCompleted);
    const transcript = appendLiveTranscriptMessages({
      chatRunState: afterHookCompleted,
      pendingUserInput: null,
      persistedMessages: [],
      selectedThreadId: 'thread-1'
    });

    expect(afterHookStarted).toEqual(running);
    expect(afterHookCompleted.assistantMessage).toBe('Visible answer');
    expect(afterHookCompleted.activityBlocks).toEqual([]);
    expect(completed.status).toBe('completed');
    expect(completed.summary).toBe('done');
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'Visible answer'
    });
    expect(JSON.stringify(transcript)).not.toContain('Checking shell command');
    expect(JSON.stringify(transcript)).not.toContain('Hook completed');
  });
});
