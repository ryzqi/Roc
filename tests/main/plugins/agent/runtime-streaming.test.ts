import { completedTestOutcome, createTestAgentExecution } from './test-execution';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { createChatStartRunRequestFromSnapshot } from '../../../../src/main/plugins/agent/run-execution-snapshot';
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
  createModelHandleByProviderAndModel: async ({ providerId, modelId }) => ({
    modelId,
    providerId
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
  applyAgentDatabaseSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
});


describe('AgentPluginRuntime', () => {
  it('runs workbench proposal requests through DeepAgents instead of completing before execution', async () => {
    const repository = new AgentSessionRepository(db);
    const seenInputs: ChatStartRunRequest[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          seenInputs.push(createChatStartRunRequestFromSnapshot(input.snapshot, input.run));
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-propose',
              callId: 'call-propose',
              name: 'propose_background_task',
              phase: 'start',
              input: {
                goal: '每天晚上9点创建 docx 文件，里面写你好世界',
                trigger: {
                  type: 'cron',
                  description: '每天 21:00',
                  cronExpression: '0 21 * * *',
                  nextRunAt: '2026-06-16T13:00:00.000Z'
                },
                workspacePath: 'F:\\Code\\Roc'
              }
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-schedule',
              callId: 'call-schedule',
              name: 'schedule_background_task',
              phase: 'end',
              output: {
                ok: true,
                taskId: 'background-1'
              }
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'text',
              blockId: 'text-final',
              phase: 'delta',
              text: '后台任务已创建。'
            }
          } satisfies ChatRunEvent;
        })(), completedTestOutcome({
          finalMessage: '后台任务已创建。',
          successfulToolNames: ['schedule_background_task']
        }));
}
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '每天晚上9点创建 docx 文件，里面写你好世界',
      mode: 'task',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: expect.objectContaining({
          runId: result.runId,
          type: 'tool_call',
          payload: expect.objectContaining({
            name: 'propose_background_task',
            status: 'start'
          })
        })
      })
    );
  });


  it('does not complete when a later tool error overrides an earlier tool end without final assistant text', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
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
        })(), Promise.reject(new Error('agent_model_response_empty')));
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
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield createReasoningBlock(input.run.id, '先判断用户意图。');
          yield createTextBlock(input.run.id, '可以，先从今天金价开始。');
        })(), completedTestOutcome({ finalMessage: '可以，先从今天金价开始。' }));
}
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'nvidia:test-model',
          providerId: 'nvidia'
        }),
        createModelHandleByProviderAndModel: async ({ providerId, modelId }) => ({
          modelId,
          providerId
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

  it('persists structured subagent events without old started/completed task types', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield {
            type: 'subagent_event',
            runId: input.run.id,
            sequence: 1,
            identity: {
              subagentId: 'subagent-runtime-0',
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
          } satisfies ChatRunEvent;
          yield createTextBlock(input.run.id, '研究完成。');
        })(), completedTestOutcome({ finalMessage: '研究完成。' }));
}
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '先研究文档，再总结。',
      mode: 'task'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'subagent_event',
          payload: {
            sequence: 1,
            identity: {
              subagentId: 'subagent-runtime-0',
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
          }
        }
      })
    );
    const persistedSubagentEventTypes = events
      .filter((event) => event.type === 'agent.run.task-event')
      .map((event) => (typeof event.payload === 'object' && event.payload !== null ? Reflect.get(event.payload, 'type') : null))
      .filter((type) => typeof type === 'string' && type.startsWith('subagent'));
    expect(persistedSubagentEventTypes).toEqual(['subagent_event']);
  });

});

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

