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
  it('resumes an interrupted DeepAgent run through the executor and records approval decision', async () => {
    const repository = new AgentSessionRepository(db);
    let resumePayload: unknown = null;
    let resumedTaskSource: unknown = null;
    let resumedWorkflowHint: unknown = null;
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
                    name: 'run_shell_command',
                    args: {
                      command: 'git status'
                    }
                  }
                ],
                reviewConfigs: [
                  {
                    actionName: 'run_shell_command',
                    allowedDecisions: ['approve', 'reject']
                  }
                ]
              }
            } satisfies ChatRunEvent;
            return;
          }
          resumePayload = input.resumePayload;
          resumedTaskSource = input.request.taskSource;
          resumedWorkflowHint = input.request.workflowHint;
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
      mode: 'task',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
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
    expect(resumedTaskSource).toBe('workbench');
    expect(resumedWorkflowHint).toBe('propose_background_task');
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

