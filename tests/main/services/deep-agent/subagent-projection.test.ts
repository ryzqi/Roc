import { describe, expect, it, vi } from 'vitest';
import { projectSubagentStream } from '../../../../src/main/services/deep-agent/subagent-projection';
import type { ChatRunEvent } from '../../../../src/shared/types';

describe('projectSubagentStream', () => {
  it('streams nested subagent messages and tool calls with stable identity', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_nested',
      subagents: single({
        name: 'research',
        taskInput: 'Search docs',
        messages: single({
          text: single('子代理正文')
        }),
        toolCalls: single({
          callId: 'call-web',
          name: 'web_read',
          input: { url: 'https://example.com' },
          output: 'ok'
        }),
        subagents: single({
          name: 'quote-check',
          taskInput: 'Verify quote',
          output: 'quote ok'
        }),
        output: 'done'
      }),
      callbacks: callbacks(events)
    });

    expect(events.map((event) => event.type)).toEqual([
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event',
      'subagent_event'
    ]);
    expect(events.map((event) => (event.type === 'subagent_event' ? event.sequence : 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events[0]).toMatchObject({
      runId: 'run_nested',
      sequence: 1,
      identity: {
        subagentId: 'subagent-run_nested-0',
        parentSubagentId: null,
        name: 'research',
        depth: 0,
        path: ['research#0'],
        execution: 'sync',
        taskInput: 'Search docs'
      },
      event: { kind: 'started' }
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ subagentId: 'subagent-run_nested-0' }),
        event: expect.objectContaining({
          kind: 'assistant_block',
          block: expect.objectContaining({
            kind: 'text',
            blockId: 'subagent-run_nested-0-text',
            phase: 'delta',
            text: '子代理正文'
          })
        })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ subagentId: 'subagent-run_nested-0' }),
        event: expect.objectContaining({
          kind: 'tool_call',
          block: expect.objectContaining({
            kind: 'tool_call',
            blockId: 'subagent-run_nested-0-tool-call-web',
            callId: 'call-web',
            name: 'web_read',
            phase: 'start',
            input: { url: 'https://example.com' }
          })
        })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({
          subagentId: 'subagent-run_nested-0-0',
          parentSubagentId: 'subagent-run_nested-0',
          name: 'quote-check',
          depth: 1,
          path: ['research#0', 'quote-check#0']
        }),
        event: { kind: 'started' }
      })
    );
    expect(events.at(-1)).toMatchObject({
      sequence: 7,
      identity: { subagentId: 'subagent-run_nested-0' },
      event: { kind: 'completed', summary: 'done' }
    });
  });

  it('keeps partial transcript when output rejects', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_failed_output',
      subagents: single({
        name: 'research',
        taskInput: 'Search docs',
        messages: single({ text: single('partial') }),
        output: Promise.reject(new Error('remote failed'))
      }),
      callbacks: callbacks(events)
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'assistant_block',
          block: expect.objectContaining({ text: 'partial' })
        })
      })
    );
    expect(events.at(-1)).toMatchObject({
      event: { kind: 'failed', error: 'remote failed' }
    });
  });
});

function callbacks(events: ChatRunEvent[]) {
  return {
    emitRuntimeEvent: vi.fn((event: ChatRunEvent) => events.push(event)),
    emitTodoEvent: vi.fn(),
    markVisibleOutput: vi.fn(),
    recordSessionToolCall: vi.fn()
  };
}

async function* single(value: unknown): AsyncGenerator<unknown> {
  yield value;
}
