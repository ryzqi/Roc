import { describe, expect, it, vi } from 'vitest';

import {
  DeepAgents110V3ContractError,
  type DeepAgents110V3Message,
  type DeepAgents110V3Subagent,
  type DeepAgents110V3ToolCall
} from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';
import { projectSubagentStream } from '../../../../src/main/services/deep-agent/subagent-projection';
import type { ChatRunEvent } from '../../../../src/shared/types';

describe('projectSubagentStream', () => {
  it('propagates subagent output-projection failure instead of emitting a tool error', async () => {
    const events: ChatRunEvent[] = [];
    const callbackSet = callbacks(events);
    callbackSet.projectToolOutput
      .mockImplementationOnce(() => {
        throw new Error('subagent_tool_output_projection_failed');
      })
      .mockImplementation(({ output }: { output: unknown }) => output);

    await expect(
      projectSubagentStream({
        runId: 'run_subagent_projection_failure',
        subagents: single(createSubagent({
          name: 'research',
          toolCalls: single(createToolCall({
            callId: 'call-subagent-projection-failure',
            name: 'web_read',
            input: { url: 'https://example.com' },
            outcome: Promise.resolve({ status: 'finished', output: 'web read completed' })
          }))
        })),
        callbacks: callbackSet
      })
    ).rejects.toThrow('subagent_tool_output_projection_failed');

    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool_call',
          block: expect.objectContaining({ phase: 'error' })
        })
      })
    );
  });

  it('observes subagent output failure when stream projection also fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const events: ChatRunEvent[] = [];
      const callbackSet = callbacks(events);
      callbackSet.projectToolOutput.mockImplementation(() => {
        throw new Error('subagent tool projection failed');
      });

      await expect(projectSubagentStream({
        runId: 'run_concurrent_subagent_failure',
        subagents: single(createSubagent({
          output: Promise.reject(new Error('subagent output failed')),
          toolCalls: single(createToolCall())
        })),
        callbacks: callbackSet
      })).rejects.toThrow('subagent tool projection failed');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('observes tool outcome failure when tool start projection also fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const events: ChatRunEvent[] = [];
      const callbackSet = callbacks(events);
      callbackSet.emitRuntimeEvent.mockImplementation((event: ChatRunEvent) => {
        const eventCount = events.push(event);
        if (event.type === 'subagent_event' && event.event.kind === 'tool_call') {
          throw new Error('subagent tool start projection failed');
        }
        return eventCount;
      });

      await expect(projectSubagentStream({
        runId: 'run_concurrent_subagent_tool_failure',
        subagents: single(createSubagent({
          toolCalls: single(createToolCall({
            outcome: Promise.reject(new Error('subagent tool outcome failed'))
          }))
        })),
        callbacks: callbackSet
      })).rejects.toThrow('subagent tool start projection failed');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('uses the shared tool-output projector for subagent tool results', async () => {
    const events: ChatRunEvent[] = [];
    const callbackSet = callbacks(events);
    const projectedOutput = { kind: 'tool_result_artifact', preview: '[REDACTED]', truncated: true };
    callbackSet.projectToolOutput.mockReturnValue(projectedOutput);

    await projectSubagentStream({
      runId: 'run_subagent_projection',
      subagents: single(createSubagent({
        name: 'research',
        toolCalls: single(createToolCall({
          callId: 'call-subagent-output',
          name: 'web_read',
          input: { url: 'https://example.com' },
          outcome: Promise.resolve({
            status: 'finished',
            output: 'Bearer should-not-reach-the-timeline'
          })
        }))
      })),
      callbacks: callbackSet
    });

    expect(callbackSet.projectToolOutput).toHaveBeenCalledWith({
      callId: 'call-subagent-output',
      name: 'web_read',
      output: 'Bearer should-not-reach-the-timeline'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool_call',
          block: expect.objectContaining({ output: projectedOutput })
        })
      })
    );
  });

  it('projects terminal subagent tool status as an error', async () => {
    const events: ChatRunEvent[] = [];
    const callbackSet = callbacks(events);

    await projectSubagentStream({
      runId: 'run_subagent_tool_error',
      subagents: single(createSubagent({
        toolCalls: single(createToolCall({
          callId: 'call-subagent-error',
          outcome: Promise.resolve({ status: 'error', error: 'Bearer subagent-secret' })
        }))
      })),
      callbacks: callbackSet
    });

    expect(callbackSet.projectToolOutput).toHaveBeenCalledWith({
      callId: 'call-subagent-error',
      name: 'web_read',
      output: '[REDACTED]'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool_call',
          block: expect.objectContaining({
            callId: 'call-subagent-error',
            phase: 'error',
            error: '[REDACTED]'
          })
        })
      })
    );
    expect(callbackSet.recordSessionToolCall).toHaveBeenCalledWith(
      'web_read',
      { url: 'https://example.com' },
      { error: '[REDACTED]' }
    );
  });

  it('streams nested subagent messages and tool calls with stable identity', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_nested',
      subagents: single(createSubagent({
        name: 'research',
        messages: single(createMessage({
          usageKey: 'run/subagents/0/messages/0',
          text: single('子代理正文')
        })),
        toolCalls: single(createToolCall({
          callId: 'call-web',
          name: 'web_read',
          input: { url: 'https://example.com' },
          outcome: Promise.resolve({ status: 'finished', output: 'ok' })
        })),
        subagents: single(createSubagent({ name: 'quote-check' }))
      })),
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
    expect(events.map((event) => (event.type === 'subagent_event' ? event.sequence : 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7
    ]);
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
        taskInput: null
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
      event: { kind: 'completed', summary: null }
    });
  });

  it('keeps partial transcript when output rejects', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_failed_output',
      subagents: single(createSubagent({
        name: 'research',
        messages: single(createMessage({ text: single('partial') })),
        output: Promise.reject(new Error('remote failed'))
      })),
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

  it('projects native named-subagent identity without legacy task fields', async () => {
    const events: ChatRunEvent[] = [];
    await projectSubagentStream({
      runId: 'run_native',
      subagents: single(createSubagent({
        name: 'research',
        cause: { type: 'toolCall', toolCallId: 'call-research' }
      })),
      callbacks: callbacks(events)
    });

    expect(events[0]).toMatchObject({
      runId: 'run_native',
      sequence: 1,
      identity: {
        subagentId: 'subagent-run_native-0',
        name: 'research',
        execution: 'sync',
        taskInput: null
      },
      event: { kind: 'started' }
    });
    expect(events.at(-1)).toMatchObject({
      sequence: 2,
      identity: { subagentId: 'subagent-run_native-0' },
      event: { kind: 'completed', summary: null }
    });
  });

  it('propagates adapter contract failures instead of emitting ordinary subagent failure', async () => {
    const events: ChatRunEvent[] = [];

    await expect(projectSubagentStream({
      runId: 'run_contract_failure',
      subagents: single(createSubagent({
        output: Promise.reject(
          new DeepAgents110V3ContractError('deep_agents_1_10_v3_subagent_output_messages_missing')
        )
      })),
      callbacks: callbacks(events)
    })).rejects.toThrow('deep_agents_1_10_v3_subagent_output_messages_missing');

    expect(events.at(-1)).not.toMatchObject({ event: { kind: 'failed' } });
  });
});

function createSubagent(overrides: Partial<DeepAgents110V3Subagent> = {}): DeepAgents110V3Subagent {
  return {
    name: 'research',
    cause: { type: 'toolCall', toolCallId: 'call-subagent' },
    output: Promise.resolve({ finalAssistantText: null }),
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    ...overrides
  };
}

function createMessage(overrides: Partial<DeepAgents110V3Message> = {}): DeepAgents110V3Message {
  return {
    usageKey: 'run/subagents/0/messages/0',
    namespace: ['tools:fixture', 'model_request:fixture'],
    node: 'model_request',
    text: empty(),
    reasoning: empty(),
    trailingReasoning: Promise.resolve(null),
    usage: empty(),
    ...overrides
  };
}

function createToolCall(overrides: Partial<DeepAgents110V3ToolCall> = {}): DeepAgents110V3ToolCall {
  return {
    name: 'web_read',
    callId: 'call-subagent-tool',
    input: { url: 'https://example.com' },
    outcome: Promise.resolve({ status: 'finished', output: 'ok' }),
    ...overrides
  };
}

function callbacks(events: ChatRunEvent[]) {
  return {
    emitRuntimeEvent: vi.fn((event: ChatRunEvent) => events.push(event)),
    emitTodoEvent: vi.fn(),
    markVisibleOutput: vi.fn(),
    observeMessageUsage: vi.fn(),
    projectToolOutput: vi.fn(({ output }: { output: unknown }) => output),
    recordSessionToolCall: vi.fn()
  };
}

async function* single<T>(value: T): AsyncGenerator<T> {
  yield value;
}

async function* empty<T>(): AsyncGenerator<T> {}
