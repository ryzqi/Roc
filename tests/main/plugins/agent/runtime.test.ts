import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

let db: Database.Database;
let events: RocEventEnvelope[];

const modelFactory: AgentModelFactoryAdapter = {
  createDefaultModelHandle: async () => ({
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  }),
  createModelHandleByModelId: async (modelId) => ({
    modelId,
    providerId: 'openai'
  })
};

const eventBus: RocEventBus = {
  publish: async (event) => {
    events.push(event);
  },
  subscribe: () => () => {}
};

const startRequest: ChatStartRunRequest = {
  enabledCapabilities: {
    mcpServers: [],
    skills: []
  },
  input: 'Summarize this workspace',
  mode: 'task'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
});

describe('AgentPluginRuntime', () => {
  it('starts a task run through the plugin repository and publishes the run event', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);

    expect(result).toMatchObject({
      mode: 'task',
      modelId: 'openai:gpt-4.1',
      providerId: 'openai'
    });
    expect(repository.getRun(result.runId)).toMatchObject({
      id: result.runId,
      modelId: 'openai:gpt-4.1',
      threadId: result.threadId,
      userInput: 'Summarize this workspace'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          runId: result.runId,
          threadId: result.threadId
        }),
        source: '@roc/plugin-agent',
        type: 'agent.run.started'
      })
    );
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );
  });

  it('publishes chat run events for renderer subscribers when a plugin run starts and completes', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      mode: 'chat'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    const chatEvents = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload));

    expect(chatEvents).toEqual([
      {
        type: 'run_started',
        runId: result.runId,
        mode: 'chat',
        threadId: result.threadId,
        providerId: 'openai',
        modelId: 'openai:gpt-4.1',
        createdAt: result.createdAt
      },
      {
        type: 'assistant_block',
        runId: result.runId,
        block: {
          kind: 'text',
          blockId: `text-${result.runId}`,
          phase: 'delta',
          text: 'Static agent response.'
        }
      },
      {
        type: 'run_completed',
        runId: result.runId,
        threadId: result.threadId,
        providerId: 'openai',
        modelId: 'openai:gpt-4.1',
        createdAt: result.createdAt,
        durationMs: expect.any(Number),
        summary: 'Static agent response.',
        assistantMessage: 'Static agent response.'
      }
    ]);
  });

  it('cancels only active plugin runs', async () => {
    const repository = new AgentSessionRepository(db);
    const deferred = createDeferred<string>();
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield createTextBlock(input.run.id, await deferred.promise);
        }
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });
    const result = await runtime.startRun(startRequest);

    expect(runtime.cancelRun({ runId: result.runId })).toEqual({
      cancelled: true,
      runId: result.runId
    });
    expect(runtime.cancelRun({ runId: result.runId })).toEqual({
      cancelled: false,
      runId: result.runId
    });
    deferred.resolve('Response after cancel.');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repository.getRun(result.runId).status).toBe('cancelled');
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          runId: result.runId,
          type: 'run_completed'
        })
      })
    );
  });

  it('publishes renderer failure events and marks the run failed when the DeepAgent executor fails', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* () {
          throw new Error('provider_unavailable');
        }
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });

    const result = await runtime.startRun(startRequest);

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(repository.getRun(result.runId).status).toBe('failed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: {
          type: 'run_failed',
          runId: result.runId,
          threadId: result.threadId,
          code: 'agent_run_failed',
          message: 'provider_unavailable',
          retryable: true
        }
      })
    );
  });

  it('fails loudly with agent_model_response_empty when the DeepAgent executor returns no visible text', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* () {
          return;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(repository.getRun(result.runId).status).toBe('failed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: {
          type: 'run_failed',
          runId: result.runId,
          threadId: result.threadId,
          code: 'agent_run_failed',
          message: 'agent_model_response_empty',
          retryable: true
        }
      })
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed'
        })
      })
    );
    expect(repository.listSessionMessages({ threadId: result.threadId! })).toEqual([]);
  });

  it('completes a run when a tool block succeeds without final assistant text', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-write',
              callId: 'call-write',
              name: 'write_file',
              phase: 'start',
              input: {
                file_path: '/workspace/hello.txt'
              }
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-write',
              callId: 'call-write',
              name: 'write_file',
              phase: 'end',
              output: 'Successfully wrote to /workspace/hello.txt'
            }
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '创建 hello.txt',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(repository.getRun(result.runId).status).toBe('completed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed',
          runId: result.runId,
          assistantMessage: ''
        })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'assistant_block',
          payload: {
            kind: 'tool_call',
            blockId: 'tool-call-write',
            callId: 'call-write',
            name: 'write_file',
            phase: 'end',
            output: 'Successfully wrote to /workspace/hello.txt'
          }
        }
      })
    );
  });

  it('does not complete when a later tool error overrides an earlier tool end without final assistant text', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-call-write',
            callId: 'call-write',
            name: 'write_file',
            phase: 'end',
            output: {
              command: 'internal'
            }
          });
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-call-write',
            callId: 'call-write',
            name: 'write_file',
            phase: 'error',
            error: 'Permission denied.'
          });
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '创建 hello.txt',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(repository.getRun(result.runId).status).toBe('failed');
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed'
        })
      })
    );
  });

  it('streams reasoning and assistant deltas through renderer and task-event channels before completion', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield createReasoningBlock(input.run.id, '先判断用户意图。');
          yield createTextBlock(input.run.id, '可以，先从今天金价开始。');
        }
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'nvidia:test-model',
          providerId: 'nvidia'
        }),
        createModelHandleByModelId: async (modelId) => ({
          modelId,
          providerId: 'nvidia'
        })
      },
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '每天晚上9点搜索今日金价，并记录到当前目录下的docx文件中。先思考，再执行。',
      mode: 'chat'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    const chatEvents = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload));
    expect(chatEvents).toContainEqual({
      type: 'assistant_block',
      runId: result.runId,
      block: {
        kind: 'reasoning',
        blockId: `reasoning-${result.runId}`,
        phase: 'delta',
        text: '先判断用户意图。'
      }
    });
    expect(chatEvents).toContainEqual({
      type: 'assistant_block',
      runId: result.runId,
      block: {
        kind: 'text',
        blockId: `text-${result.runId}`,
        phase: 'delta',
        text: '可以，先从今天金价开始。'
      }
    });
    expect(chatEvents).toContainEqual(
      expect.objectContaining({
        type: 'run_completed',
        runId: result.runId,
        assistantMessage: '可以，先从今天金价开始。'
      })
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'assistant_block',
          payload: {
            kind: 'reasoning',
            blockId: `reasoning-${result.runId}`,
            phase: 'delta',
            text: '先判断用户意图。'
          }
        }
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'assistant_block',
          payload: {
            kind: 'text',
            blockId: `text-${result.runId}`,
            phase: 'delta',
            text: '可以，先从今天金价开始。'
          }
        }
      })
    );
  });

  it('uses the plugin-owned DeepAgent executor instead of raw model streaming for normal runs', async () => {
    const repository = new AgentSessionRepository(db);
    let executorCalledWith: ChatStartRunRequest | null = null;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          executorCalledWith = input.request;
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-call-web-read',
            callId: 'call-web-read',
            name: 'web_read',
            phase: 'start',
            input: {
              url: 'https://example.test'
            }
          });
          yield createTextBlock(input.run.id, 'DeepAgent executor response.');
        }
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: 'Use web_read to inspect the docs.',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(executorCalledWith).toMatchObject({
      input: 'Use web_read to inspect the docs.',
      mode: 'task'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: {
          type: 'assistant_block',
          runId: result.runId,
          block: {
            kind: 'tool_call',
            blockId: 'tool-call-web-read',
            callId: 'call-web-read',
            name: 'web_read',
            phase: 'start',
            input: {
              url: 'https://example.test'
            }
          }
        }
      })
    );
    expect(repository.getRun(result.runId).status).toBe('completed');
    expect(repository.listSessionMessages({ threadId: result.threadId! })).toMatchObject([
      {
        role: 'assistant',
        content: 'DeepAgent executor response.'
      }
    ]);
  });

  it('requires the DeepAgent executor instead of using raw model streaming', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: modelFactory.createModelHandleByModelId
      },
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: 'Use the agent runtime.',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(repository.getRun(result.runId).status).toBe('failed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: {
          type: 'run_failed',
          runId: result.runId,
          threadId: result.threadId,
          code: 'agent_run_failed',
          message: 'agent_deep_agent_executor_missing',
          retryable: true
        }
      })
    );
  });

  it('keeps a DeepAgent approval interrupt waiting for user decision', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'run_interrupted',
            runId: input.run.id,
            threadId: input.run.threadId,
            interruptId: 'interrupt_approval_1',
            payload: {
              actionRequests: [
                {
                  name: 'execute',
                  args: {
                    command: 'git status'
                  }
                }
              ],
              reviewConfigs: [
                {
                  actionName: 'execute',
                  allowedDecisions: ['approve', 'reject']
                }
              ]
            }
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: 'Run git status.',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );

    expect(repository.getRun(result.runId).status).toBe('waiting_user');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'approval_requested',
          payload: {
            interruptId: 'interrupt_approval_1',
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        }
      })
    );
    expect(events.some((event) => event.type === 'agent.run.completed' && readPayloadRunId(event.payload) === result.runId)).toBe(false);
    expect(events.some((event) => event.type === 'agent.run.failed' && readPayloadRunId(event.payload) === result.runId)).toBe(false);
  });

  it('resumes an interrupted DeepAgent run through the executor and records approval decision', async () => {
    const repository = new AgentSessionRepository(db);
    let resumePayload: unknown = null;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          if (input.resumePayload === undefined) {
            yield {
              type: 'run_interrupted',
              runId: input.run.id,
              threadId: input.run.threadId,
              interruptId: 'interrupt_resume_1',
              payload: {
                actionRequests: [
                  {
                    name: 'execute',
                    args: {
                      command: 'git status'
                    }
                  }
                ],
                reviewConfigs: [
                  {
                    actionName: 'execute',
                    allowedDecisions: ['approve', 'reject']
                  }
                ]
              }
            } satisfies ChatRunEvent;
            return;
          }
          resumePayload = input.resumePayload;
          yield createTextBlock(input.run.id, 'Approved command finished.');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await runtime.startRun({
      ...startRequest,
      input: 'Run git status.',
      mode: 'task'
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );

    const resumed = await runtime.resumeRun({
      runId: started.runId,
      threadId: started.threadId!,
      interruptId: 'interrupt_resume_1',
      decisions: [
        {
          type: 'approve'
        }
      ]
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(resumed).toMatchObject({
      runId: started.runId,
      threadId: started.threadId
    });
    expect(resumePayload).toEqual({
      decisions: [
        {
          type: 'approve'
        }
      ]
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: started.runId,
          threadId: started.threadId,
          type: 'approval_decision',
          payload: {
            interruptId: 'interrupt_resume_1',
            decisions: [
              {
                type: 'approve'
              }
            ]
          }
        }
      })
    );
    expect(repository.getRun(started.runId).status).toBe('completed');
    expect(repository.listSessionMessages({ threadId: started.threadId! })).toMatchObject([
      {
        role: 'assistant',
        content: 'Approved command finished.'
      }
    ]);
  });

  it('runs through the DeepAgent executor when the model handle does not expose raw stream', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('DeepAgent response without raw stream.'),
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByModelId: async (modelId) => ({
          modelId,
          providerId: 'openai'
        })
      },
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      mode: 'chat'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(repository.getRun(result.runId).status).toBe('completed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed',
          runId: result.runId,
          assistantMessage: 'DeepAgent response without raw stream.'
        })
      })
    );
  });

  it('lists and searches session messages from the plugin repository', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });
    const result = await runtime.startRun(startRequest);
    if (result.threadId === null) {
      throw new Error('expected_task_thread');
    }
    repository.recordSessionMessage({
      content: 'Visible memory answer',
      role: 'assistant',
      threadId: result.threadId
    });

    expect(runtime.listSessionMessages({ threadId: result.threadId })).toMatchObject([
      {
        content: 'Visible memory answer',
        phase: 'visible',
        role: 'assistant'
      }
    ]);
    expect(runtime.searchSessionMessages({ query: 'memory', workspaceScope: 'all' })).toMatchObject({
      query: 'memory',
      total: 1
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );
  });

});

function createTextDeepAgentExecutor(text = 'Static agent response.'): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute: async function* (input) {
      yield createTextBlock(input.run.id, text);
    }
  };
}

function createTextBlock(runId: string, text: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'text',
      blockId: `text-${runId}`,
      phase: 'delta',
      text
    }
  };
}

function createReasoningBlock(runId: string, text: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'reasoning',
      blockId: `reasoning-${runId}`,
      phase: 'delta',
      text
    }
  };
}

function createToolBlock(runId: string, block: Extract<ChatRunEvent, { type: 'assistant_block' }>['block']): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block
  };
}

async function waitForEvent(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_event_not_published');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readChatRunEvent(payload: unknown): ChatRunEvent | null {
  if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
    return null;
  }
  return payload as ChatRunEvent;
}

function readPayloadRunId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  return typeof runId === 'string' ? runId : null;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolveValue === null) {
        throw new Error('deferred_not_initialized');
      }
      resolveValue(value);
    }
  };
}
