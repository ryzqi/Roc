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

  it('publishes the request workspacePath on completed run events', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('Workspace-bound response.'),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      workspacePath: 'F:\\Code\\ScheduledTask'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.run.completed' && readPayloadRunId(event.payload) === result.runId)
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.completed',
        payload: expect.objectContaining({
          runId: result.runId,
          workspacePath: 'F:\\Code\\ScheduledTask'
        })
      })
    );
  });

  it('validates image attachments before invoking the DeepAgent executor', async () => {
    const repository = new AgentSessionRepository(db);
    let validatedAttachments: unknown = null;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          validatedAttachments = Reflect.get(input, 'validatedAttachments');
          yield createTextBlock(input.run.id, '图片里有图表。');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      input: '描述图片',
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: [] },
      attachments: [
        {
          kind: 'image',
          source: 'clipboard',
          name: 'chart.png',
          mediaType: 'image/png',
          sizeBytes: 3,
          data: Buffer.from([1, 2, 3]).toString('base64')
        }
      ]
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(validatedAttachments).toEqual([
      {
        kind: 'image',
        name: 'chart.png',
        mediaType: 'image/png',
        sizeBytes: 3,
        base64: Buffer.from([1, 2, 3]).toString('base64')
      }
    ]);
    expect(repository.listThreadEvents(result.threadId!)[0]?.payload).toMatchObject({
      role: 'user',
      content: '描述图片',
      attachments: [
        {
          kind: 'image',
          name: 'chart.png',
          mediaType: 'image/png',
          sizeBytes: 3
        }
      ]
    });
    expect(JSON.stringify(repository.listThreadEvents(result.threadId!)[0]?.payload)).not.toContain('AQID');
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
            payload: approvalPayload()
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
        }
      })
    );
    expect(events.some((event) => event.type === 'agent.run.completed' && readPayloadRunId(event.payload) === result.runId)).toBe(false);
    expect(events.some((event) => event.type === 'agent.run.failed' && readPayloadRunId(event.payload) === result.runId)).toBe(false);
  });

  it('resumes question interrupts with answer payload and preserves run context', async () => {
    const repository = new AgentSessionRepository(db);
    const requests: ChatStartRunRequest[] = [];
    const resumePayloads: unknown[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          requests.push(input.request);
          resumePayloads.push(input.resumePayload);
          if (input.resumePayload === undefined) {
            yield {
              type: 'run_interrupted',
              runId: input.run.id,
              threadId: input.run.threadId,
              interruptId: 'interrupt-question',
              payload: {
                kind: 'question',
                question: 'Which path should I inspect?',
                context: 'Two paths match.'
              }
            } satisfies ChatRunEvent;
            return;
          }
          yield createTextBlock(input.run.id, 'continued');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const start = await runtime.startRun({
      input: 'Investigate',
      mode: 'plan',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      threadId: null,
      workflowHint: null,
      taskSource: null,
      workspacePath: 'F:\\Code\\Roc',
      explicitSkillIds: ['typescript']
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );

    await runtime.resumeRun({
      kind: 'question',
      runId: start.runId,
      threadId: start.threadId!,
      interruptId: 'interrupt-question',
      answer: 'Use F:\\Code\\Roc.'
    });
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(requests.map((request) => request.mode)).toEqual(['plan', 'plan']);
    expect(requests[1]).toMatchObject({
      workflowHint: null,
      taskSource: null,
      workspacePath: 'F:\\Code\\Roc',
      explicitSkillIds: ['typescript']
    });
    expect(resumePayloads[1]).toEqual({ answer: 'Use F:\\Code\\Roc.' });
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

function createToolBlock(runId: string, block: Extract<ChatRunEvent, { type: 'assistant_block' }>['block']): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block
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

function readPayloadRunId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  return typeof runId === 'string' ? runId : null;
}

