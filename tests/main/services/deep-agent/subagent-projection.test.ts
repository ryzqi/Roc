import { describe, expect, it, vi } from 'vitest';

import type { DeepAgentDomainEvent, DeepAgentSubagentScope } from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';
import {
  consumeDeepAgentEventStream,
  createStreamConsumerState,
  createUsageAccumulator
} from '../../../../src/main/services/deep-agent/stream-consumers';
import type { ChatRunEvent } from '../../../../src/shared/types';

describe('subagent domain event projection', () => {
  it('projects nested lifecycle, text, and tool events with stable identity and sequence', async () => {
    const parent = scope('research', [0], ['research#0']);
    const child = scope('reader', [0, 1], ['research#0', 'reader#1']);
    const events: DeepAgentDomainEvent[] = [
      { type: 'subagent_started', scope: parent },
      { type: 'assistant_delta', scope: parent, kind: 'text', text: 'parent text' },
      { type: 'subagent_started', scope: child },
      {
        type: 'tool_call_started',
        scope: child,
        callId: 'call-child',
        name: 'web_read',
        input: { url: 'https://example.com' }
      },
      {
        type: 'tool_call_completed',
        scope: child,
        callId: 'call-child',
        name: 'web_read',
        input: { url: 'https://example.com' },
        output: 'done'
      },
      { type: 'subagent_completed', scope: child },
      { type: 'subagent_completed', scope: parent }
    ];
    const runtimeEvents: ChatRunEvent[] = [];
    const recordSessionToolCall = vi.fn();
    const markVisibleOutput = vi.fn();

    await consumeDeepAgentEventStream({
      events: asyncValues(events),
      runId: 'run-subagent',
      state: createStreamConsumerState({
        assistantChunks: [],
        reasoningChunks: [],
        usageAccumulator: createUsageAccumulator()
      }),
      callbacks: {
        emitRuntimeEvent: (event) => runtimeEvents.push(event),
        markVisibleOutput,
        recordSessionToolCall
      }
    });

    expect(runtimeEvents).toHaveLength(7);
    expect(runtimeEvents.map((event) => event.type === 'subagent_event' ? event.sequence : null))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(runtimeEvents[0]).toMatchObject({
      identity: {
        subagentId: 'subagent-run-subagent-0',
        parentSubagentId: null,
        depth: 0,
        path: ['research#0']
      },
      event: { kind: 'started' }
    });
    expect(runtimeEvents[2]).toMatchObject({
      identity: {
        subagentId: 'subagent-run-subagent-0-1',
        parentSubagentId: 'subagent-run-subagent-0',
        depth: 1,
        path: ['research#0', 'reader#1']
      },
      event: { kind: 'started' }
    });
    expect(runtimeEvents[4]).toMatchObject({
      event: {
        kind: 'tool_call',
        block: { phase: 'end', output: 'done' }
      }
    });
    expect(recordSessionToolCall).toHaveBeenCalledWith(
      'web_read',
      { url: 'https://example.com' },
      'done'
    );
    expect(markVisibleOutput).toHaveBeenCalledTimes(7);
  });

  it('projects a subagent failure as a terminal lifecycle event', async () => {
    const runtimeEvents: ChatRunEvent[] = [];
    await consumeDeepAgentEventStream({
      events: asyncValues<DeepAgentDomainEvent>([{
        type: 'subagent_failed',
        scope: scope('research', [0], ['research#0']),
        error: '[REDACTED]'
      }]),
      runId: 'run-failed',
      state: createStreamConsumerState({
        assistantChunks: [],
        reasoningChunks: [],
        usageAccumulator: createUsageAccumulator()
      }),
      callbacks: {
        emitRuntimeEvent: (event) => runtimeEvents.push(event)
      }
    });

    expect(runtimeEvents).toEqual([
      expect.objectContaining({ event: { kind: 'failed', error: '[REDACTED]' } })
    ]);
  });
});

function scope(
  name: string,
  ordinalPath: readonly number[],
  path: readonly string[]
): DeepAgentSubagentScope {
  return { name, ordinalPath, path };
}

async function* asyncValues<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
}
