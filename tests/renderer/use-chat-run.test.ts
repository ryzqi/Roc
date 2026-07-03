import { describe, expect, it } from 'vitest';
import {
  applyChatRunEventBatch,
  clearPendingChatRunEvents,
  coalesceChatRunEvents,
  isTerminalChatRunEvent,
  normalizeSequencedChatRunEvent,
  shouldApplySequencedRunEvent
} from '../../src/renderer/chat/use-chat-run';
import { createEmptyChatRunState } from '../../src/renderer/chat-run-state';
import type { ChatRunEvent, SequencedChatRunEvent } from '../../src/shared/types';

function createRunStartedEvent(): ChatRunEvent {
  return {
    type: 'run_started',
    runId: 'chat_test',
    mode: 'chat',
    threadId: 'thread_test',
    providerId: 'nvidia',
    modelId: 'moonshotai/kimi-k2.6',
    createdAt: '2026-05-09T08:00:00.000Z'
  };
}

function createDeltaEvent(delta: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId: 'chat_test',
    block: {
      kind: 'text',
      blockId: 'text-chat_test',
      phase: 'delta',
      text: delta
    }
  };
}

describe('applyChatRunEventBatch', () => {
  it('coalesces same-frame text and reasoning deltas before reducing state', () => {
    const events: ChatRunEvent[] = [
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'text',
          blockId: 'text-chat_test',
          phase: 'delta',
          text: 'Hel'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'text',
          blockId: 'text-chat_test',
          phase: 'delta',
          text: 'lo'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-chat_test',
          phase: 'delta',
          text: '思'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-chat_test',
          phase: 'delta',
          text: '考'
        }
      }
    ];

    expect(coalesceChatRunEvents(events)).toEqual([
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'text',
          blockId: 'text-chat_test',
          phase: 'delta',
          text: 'Hello'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-chat_test',
          phase: 'delta',
          text: '思考'
        }
      }
    ]);
  });

  it('reduces a hundred message deltas into a single concatenated assistant message', () => {
    const initial = applyChatRunEventBatch(createEmptyChatRunState(), [createRunStartedEvent()]);
    const tokens = Array.from({ length: 100 }, (_, index) => `token-${index} `);
    const events = tokens.map((token) => createDeltaEvent(token));

    const next = applyChatRunEventBatch(initial, events);

    expect(next.assistantMessage).toBe(tokens.join(''));
    expect(next.runId).toBe('chat_test');
    expect(next.status).toBe('running');
  });

  it('returns the same state reference when the batch is empty', () => {
    const state = createEmptyChatRunState();
    expect(applyChatRunEventBatch(state, [])).toBe(state);
  });

  it('applies interleaved message tool and subagent batches in arrival order', () => {
    const next = applyChatRunEventBatch(createEmptyChatRunState(), [
      createRunStartedEvent(),
      {
        type: 'subagent_event',
        runId: 'chat_test',
        sequence: 1,
        identity: {
          subagentId: 'subagent-chat_test-0',
          parentSubagentId: null,
          name: 'research',
          depth: 0,
          path: ['research#0'],
          execution: 'sync',
          taskInput: 'Search docs'
        },
        event: {
          kind: 'started'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'text',
          blockId: 'text-chat_test',
          phase: 'delta',
          text: 'A'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'tool_call',
          blockId: 'tool-web-search',
          callId: 'call-web-search',
          name: 'web_search',
          phase: 'start',
          input: { query: 'roc' }
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-chat_test',
          phase: 'delta',
          text: 'R'
        }
      },
      {
        type: 'subagent_event',
        runId: 'chat_test',
        sequence: 2,
        identity: {
          subagentId: 'subagent-chat_test-0',
          parentSubagentId: null,
          name: 'research',
          depth: 0,
          path: ['research#0'],
          execution: 'sync',
          taskInput: 'Search docs'
        },
        event: {
          kind: 'completed',
          summary: 'Search docs'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'tool_call',
          blockId: 'tool-web-search',
          callId: 'call-web-search',
          name: 'web_search',
          phase: 'end',
          output: 'done'
        }
      },
      {
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'text',
          blockId: 'text-chat_test',
          phase: 'delta',
          text: 'B'
        }
      }
    ]);

    expect(next.assistantMessage).toBe('AB');
    expect(next.subagents).toEqual([
      {
        identity: {
          subagentId: 'subagent-chat_test-0',
          parentSubagentId: null,
          name: 'research',
          depth: 0,
          path: ['research#0'],
          execution: 'sync',
          taskInput: 'Search docs'
        },
        status: 'completed',
        summary: 'Search docs',
        error: null,
        blocks: [],
        children: []
      }
    ]);
    expect(next.activityBlocks).toEqual([
      {
        id: 'tool-web-search',
        kind: 'tool_call',
        callId: 'call-web-search',
        name: 'web_search',
        status: 'end',
        input: { query: 'roc' },
        output: 'done',
        error: null
      },
      {
        id: 'reasoning-chat_test',
        kind: 'reasoning',
        content: 'R'
      }
    ]);
  });
});

describe('sequenced chat run events', () => {
  it('unwraps sequenced events and ignores duplicate or older sequence numbers', () => {
    const seen = new Map<string, number>();
    const sequenced: SequencedChatRunEvent = {
      runId: 'chat_test',
      sequence: 2,
      event: createDeltaEvent('A'),
      createdAt: '2026-07-03T00:00:00.000Z'
    };

    expect(normalizeSequencedChatRunEvent(sequenced)).toEqual(createDeltaEvent('A'));
    expect(shouldApplySequencedRunEvent(seen, sequenced)).toBe(true);
    expect(shouldApplySequencedRunEvent(seen, sequenced)).toBe(false);
    expect(
      shouldApplySequencedRunEvent(seen, {
        ...sequenced,
        sequence: 1
      })
    ).toBe(false);
    expect(
      shouldApplySequencedRunEvent(seen, {
        ...sequenced,
        sequence: 3
      })
    ).toBe(true);
  });
});

describe('isTerminalChatRunEvent', () => {
  it('treats run_started, run_completed, and run_failed as terminal flush triggers', () => {
    expect(isTerminalChatRunEvent({ ...createRunStartedEvent() })).toBe(true);
    expect(
      isTerminalChatRunEvent({
        type: 'run_completed',
        runId: 'chat_test',
        threadId: 'thread_test',
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k2.6',
        createdAt: '2026-05-09T08:00:01.000Z',
        durationMs: 1000,
        summary: 'ok',
        assistantMessage: 'done'
      })
    ).toBe(true);
    expect(
      isTerminalChatRunEvent({
        type: 'run_failed',
        runId: 'chat_test',
        threadId: 'thread_test',
        code: 'provider_execution_failed',
        message: 'fail',
        retryable: true
      })
    ).toBe(true);
  });

  it('treats incremental deltas as non-terminal', () => {
    expect(isTerminalChatRunEvent(createDeltaEvent('hello'))).toBe(false);
    expect(
      isTerminalChatRunEvent({
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'reasoning',
          blockId: 'reasoning-chat_test',
          phase: 'delta',
          text: 'thinking'
        }
      })
    ).toBe(false);
    expect(
      isTerminalChatRunEvent({
        type: 'assistant_block',
        runId: 'chat_test',
        block: {
          kind: 'tool_call',
          blockId: 'tool-web-read',
          callId: 'call-web-read',
          name: 'web_read',
          phase: 'start',
          input: null
        }
      })
    ).toBe(false);
  });
});

describe('clearPendingChatRunEvents', () => {
  it('cancels scheduled flush work and drops pending events', () => {
    const pendingEventsRef = {
      current: [createDeltaEvent('buffered')]
    };
    const rafHandleRef = {
      current: 42
    };
    const cancelledFrames: number[] = [];

    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef, (handle) => {
      cancelledFrames.push(handle);
    });

    expect(cancelledFrames).toEqual([42]);
    expect(rafHandleRef.current).toBeNull();
    expect(pendingEventsRef.current).toEqual([]);
  });
});
