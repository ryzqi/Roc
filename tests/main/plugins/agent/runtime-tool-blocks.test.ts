import { completedTestOutcome, createTestAgentExecution } from './test-execution';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
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
  applyAgentPluginSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
});


describe('AgentPluginRuntime', () => {
  it('fails loudly with agent_model_response_empty when the DeepAgent executor returns no visible text', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute() {
  return createTestAgentExecution(() => (async function* () {
          return;
        })(), Promise.reject(new Error('agent_model_response_empty')));
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
          code: 'provider_execution_failed',
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
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
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
        })(), completedTestOutcome({ finalMessage: '', successfulToolNames: ['write_file'] }));
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


  it('records background task tool blocks as task tool_call events', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-call-schedule',
            callId: 'call-schedule',
            name: 'schedule_background_task',
            phase: 'start',
            input: {
              previewId: 'preview-1'
            }
          });
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-call-schedule',
            callId: 'call-schedule',
            name: 'schedule_background_task',
            phase: 'end',
            output: {
              ok: true,
              taskId: 'background-1'
            }
          });
        })(), completedTestOutcome({ finalMessage: '', successfulToolNames: ['schedule_background_task'] }));
}
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '每天 09:00 检查测试',
      mode: 'task',
      taskSource: 'workbench',
      workflowHint: 'propose_background_task'
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
          type: 'tool_call',
          payload: {
            name: 'schedule_background_task',
            status: 'start',
            input: {
              previewId: 'preview-1'
            }
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
          type: 'tool_call',
          payload: {
            name: 'schedule_background_task',
            status: 'end',
            output: {
              ok: true,
              taskId: 'background-1'
            }
          }
        }
      })
    );
  });

});

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

