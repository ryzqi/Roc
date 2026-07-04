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
              payload: approvalPayload()
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
      kind: 'approval',
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

  it('resumes an interrupted run after rebuilding the runtime from persisted state', async () => {
    const repository = new AgentSessionRepository(db);
    const firstRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'run_interrupted',
            runId: input.run.id,
            threadId: input.run.threadId,
            interruptId: 'interrupt_rebuilt_runtime',
            payload: approvalPayload()
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await firstRuntime.startRun({
      input: 'Review a shell command.',
      mode: 'plan',
      enabledCapabilities: { mcpServers: ['filesystem'], skills: ['typescript'] },
      threadId: null,
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\Code\\Roc',
      explicitSkillIds: ['typescript']
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );
    expect(repository.getRun(started.runId).status).toBe('waiting_user');

    const rebuiltRepository = new AgentSessionRepository(db);
    const resumedRequests: ChatStartRunRequest[] = [];
    const resumePayloads: unknown[] = [];
    const rebuiltRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          resumedRequests.push(input.request);
          resumePayloads.push(input.resumePayload);
          yield createTextBlock(input.run.id, 'Rebuilt runtime approved.');
        }
      },
      eventBus,
      modelFactory,
      repository: rebuiltRepository
    });

    await rebuiltRuntime.resumeRun({
      kind: 'approval',
      runId: started.runId,
      threadId: started.threadId!,
      interruptId: 'interrupt_rebuilt_runtime',
      decisions: [{ type: 'approve' }]
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(resumedRequests).toEqual([
      expect.objectContaining({
        input: 'Review a shell command.',
        mode: 'plan',
        enabledCapabilities: { mcpServers: ['filesystem'], skills: ['typescript'] },
        threadId: started.threadId,
        workflowHint: 'propose_background_task',
        taskSource: 'workbench',
        workspacePath: 'F:\\Code\\Roc',
        explicitSkillIds: ['typescript']
      })
    ]);
    expect(resumePayloads).toEqual([
      {
        decisions: [{ type: 'approve' }]
      }
    ]);
    expect(rebuiltRepository.getRun(started.runId).status).toBe('completed');
  });

  it('rejects a persisted interrupt when the run is no longer waiting for the user', async () => {
    const repository = new AgentSessionRepository(db);
    const firstRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'run_interrupted',
            runId: input.run.id,
            threadId: input.run.threadId,
            interruptId: 'interrupt_stale_runtime',
            payload: approvalPayload()
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await firstRuntime.startRun({
      ...startRequest,
      input: 'Review a stale approval.',
      mode: 'plan'
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );
    repository.updateRunStatus({
      runId: started.runId,
      status: 'completed'
    });

    const rebuiltRepository = new AgentSessionRepository(db);
    let resumed = false;
    const rebuiltRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* () {
          resumed = true;
          yield createTextBlock(started.runId, 'Should not resume.');
        }
      },
      eventBus,
      modelFactory,
      repository: rebuiltRepository
    });

    await expect(
      rebuiltRuntime.resumeRun({
        kind: 'approval',
        runId: started.runId,
        threadId: started.threadId!,
        interruptId: 'interrupt_stale_runtime',
        decisions: [{ type: 'approve' }]
      })
    ).rejects.toThrow('chat_resume_run_not_waiting_user');
    expect(resumed).toBe(false);
  });

  it('resumes plan approval interrupts with the original plan mode', async () => {
    const repository = new AgentSessionRepository(db);
    const executedModes: Array<ChatStartRunRequest['mode']> = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          executedModes.push(input.request.mode);
          if (input.resumePayload === undefined) {
            yield {
              type: 'run_interrupted',
              runId: input.run.id,
              threadId: input.run.threadId,
              interruptId: 'interrupt-plan-approval',
              payload: approvalPayload()
            } satisfies ChatRunEvent;
            return;
          }
          yield createTextBlock(input.run.id, 'done');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const start = await runtime.startRun({
      input: 'Plan risky work',
      mode: 'plan',
      enabledCapabilities: { mcpServers: [], skills: [] },
      threadId: null
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );
    await expect(
      runtime.resumeRun({
        kind: 'question',
        runId: start.runId,
        threadId: start.threadId!,
        interruptId: 'interrupt-plan-approval',
        answer: 'Use Roc.'
      })
    ).rejects.toThrow('chat_resume_interrupt_kind_mismatch');
    await runtime.resumeRun({
      kind: 'approval',
      runId: start.runId,
      threadId: start.threadId!,
      interruptId: 'interrupt-plan-approval',
      decisions: [{ type: 'approve' }]
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(executedModes).toEqual(['plan', 'plan']);
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

function approvalPayload(): Extract<ChatRunEvent, { type: 'run_interrupted' }>['payload'] {
  return {
    kind: 'approval',
    request: {
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

