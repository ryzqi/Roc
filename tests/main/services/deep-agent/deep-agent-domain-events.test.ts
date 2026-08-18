import { describe, expect, it, vi } from 'vitest';

import {
  adaptDeepAgentRun,
  type DeepAgentDomainEvent
} from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';

describe('adaptDeepAgentRun domain translation', () => {
  it('translates vendor streams into domain events without exposing vendor handles', async () => {
    const projectToolOutput = vi.fn(({ output }: { output: unknown }) => ({ projected: output }));
    const rawRun = createRawRun({
      interrupted: true,
      interrupts: [{
        interruptId: 'interrupt-1',
        payload: { kind: 'question', question: 'Continue?' }
      }],
      messages: single(createRawMessage({
        text: strings('answer'),
        reasoning: strings('reason'),
        usage: single({
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
          input_token_details: { cache_read: 1, cache_creation: 0 }
        })
      })),
      toolCalls: single(createRawToolCall())
    });

    const run = adaptDeepAgentRun(rawRun, { projectToolOutput });
    const events = await collect(run.events);

    expect(events).toEqual(expect.arrayContaining<DeepAgentDomainEvent>([
      {
        type: 'assistant_delta',
        scope: null,
        kind: 'reasoning',
        text: 'reason'
      },
      {
        type: 'assistant_delta',
        scope: null,
        kind: 'text',
        text: 'answer'
      },
      {
        type: 'usage',
        usageKey: 'run/messages/0',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          cacheReadTokens: 1,
          cacheCreationTokens: 0
        }
      },
      {
        type: 'tool_call_started',
        scope: null,
        callId: 'call-1',
        name: 'inspect',
        input: { value: 'fixture' }
      },
      {
        type: 'tool_call_completed',
        scope: null,
        callId: 'call-1',
        name: 'inspect',
        input: { value: 'fixture' },
        output: { projected: 'observed' }
      },
      {
        type: 'run_interrupted',
        interrupts: [{
          interruptId: 'interrupt-1',
          payload: { kind: 'question', question: 'Continue?' }
        }]
      }
    ]));
    expect(projectToolOutput).toHaveBeenCalledWith({
      callId: 'call-1',
      name: 'inspect',
      output: 'observed'
    });
    await expect(run.output).resolves.toBe('final answer');
  });

  it('preserves an undefined rejection from a vendor stream', async () => {
    const run = adaptDeepAgentRun(createRawRun({
      messages: rejectWithUndefined()
    }), {
      projectToolOutput: ({ output }) => output
    });
    let rejected = false;
    let rejectionReason: unknown = Symbol('not rejected');

    try {
      await collect(run.events);
    } catch (error) {
      rejected = true;
      rejectionReason = error;
    }

    expect(rejected).toBe(true);
    expect(rejectionReason).toBeUndefined();
  });

  it('reads interrupt state only after vendor streams reach their terminal state', async () => {
    let terminal = false;
    const rawRun = createRawRun({
      messages: markTerminal(() => {
        terminal = true;
      })
    });
    Object.defineProperties(rawRun, {
      interrupted: {
        enumerable: true,
        get: () => {
          if (!terminal) {
            throw new Error('interrupt state read before terminal');
          }
          return true;
        }
      },
      interrupts: {
        enumerable: true,
        get: () => {
          if (!terminal) {
            throw new Error('interrupt payload read before terminal');
          }
          return [{ interruptId: 'interrupt-terminal', payload: { kind: 'terminal' } }];
        }
      }
    });

    const run = adaptDeepAgentRun(rawRun, {
      projectToolOutput: ({ output }) => output
    });

    await expect(collect(run.events)).resolves.toContainEqual({
      type: 'run_interrupted',
      interrupts: [{ interruptId: 'interrupt-terminal', payload: { kind: 'terminal' } }]
    });
  });
});

function createRawRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [{ role: 'assistant', content: 'final answer' }]
    }),
    interrupted: false,
    interrupts: [],
    ...overrides
  };
}

function createRawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: ['model_request:fixture'],
    node: 'model_request',
    text: empty(),
    toolCalls: empty(),
    reasoning: empty(),
    usage: empty(),
    output: Promise.resolve({ content: [] }),
    ...overrides
  };
}

function createRawToolCall(): Record<string, unknown> {
  return {
    name: 'inspect',
    callId: 'call-1',
    input: { value: 'fixture' },
    output: Promise.resolve('observed'),
    status: Promise.resolve('finished'),
    error: Promise.resolve(undefined)
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

async function* single<T>(value: T): AsyncGenerator<T> {
  yield value;
}

async function* strings(...values: string[]): AsyncGenerator<string> {
  yield* values;
}

async function* empty<T>(): AsyncGenerator<T> {}

async function* rejectWithUndefined(): AsyncGenerator<never> {
  throw undefined;
}

async function* markTerminal(onTerminal: () => void): AsyncGenerator<never> {
  onTerminal();
}
