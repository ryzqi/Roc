import { describe, expect, it } from 'vitest';
import { appendLiveTranscriptMessages } from '../../src/renderer/chat-transcript';
import { applyChatRunEvent, createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { ChatRunEvent } from '../../src/shared/types';

describe('renderer chat hook events', () => {
  it('renders hook runtime activity without polluting assistant text', () => {
    const sessionStartContext = '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>';
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
        message: 'Checking shell command',
        commandDisplay: 'node hook.js',
        additionalContext: null,
        requestContinue: null
      }
    };
    const assistantBlock: ChatRunEvent = {
      type: 'assistant_block',
      runId: 'run-1',
      block: {
        kind: 'text',
        blockId: 'text-1',
        phase: 'delta',
        text: `${sessionStartContext}\n\nVisible answer`
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
        message: 'Hook completed',
        commandDisplay: 'node hook.js',
        additionalContext: sessionStartContext,
        requestContinue: null
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

    expect(afterHookStarted).not.toEqual(running);
    expect(afterHookStarted.activityBlocks).toMatchObject([
      {
        id: 'hook-run-1',
        kind: 'hook_call',
        event: 'PreToolUse',
        handlerId: 'PreToolUse:0:0',
        status: 'running',
        durationMs: null,
        message: 'Checking shell command',
        commandDisplay: 'node hook.js',
        additionalContext: null,
        requestContinue: null
      }
    ]);
    expect(afterHookCompleted.assistantMessage).toBe(`${sessionStartContext}\n\nVisible answer`);
    expect(afterHookCompleted.activityBlocks).toMatchObject([
      {
        id: 'hook-run-1',
        kind: 'hook_call',
        event: 'PreToolUse',
        handlerId: 'PreToolUse:0:0',
        status: 'completed',
        durationMs: 12,
        message: 'Hook completed',
        commandDisplay: 'node hook.js',
        additionalContext: sessionStartContext,
        requestContinue: null
      }
    ]);
    expect(completed.status).toBe('completed');
    expect(completed.summary).toBe('done');
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'Visible answer'
    });
    expect(JSON.stringify(transcript)).toContain(sessionStartContext);
    expect(JSON.stringify(transcript)).toContain('Hook completed');
    expect(JSON.stringify(transcript)).toContain('node hook.js');
    expect(JSON.stringify(transcript)).not.toContain('stdout');
    expect(JSON.stringify(transcript)).not.toContain('stderr');
    expect(JSON.stringify(transcript)).not.toContain('toolInput');
    expect(transcript[0]?.reasoning).toBeNull();
  });
});
