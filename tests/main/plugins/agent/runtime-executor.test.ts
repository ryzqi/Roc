import { completedTestOutcome, createTestAgentExecution, interruptedTestOutcome, readPendingInterrupts } from './test-execution';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { createAgentDeepAgentExecution } from '../../../../src/main/plugins/agent/agent-execution';
import { createChatStartRunRequestFromSnapshot } from '../../../../src/main/plugins/agent/run-execution-snapshot';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { ProviderStreamTerminatedError } from '../../../../src/main/services/provider-request-retry';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';
import { createTestCapabilityPreviewProvider } from './runtime-capability-preview-test-helpers';

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
  it('uses the plugin-owned DeepAgent executor instead of raw model streaming for normal runs', async () => {
    const repository = new AgentSessionRepository(db);
    let executorCalledWith: ChatStartRunRequest | null = null;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          executorCalledWith = createChatStartRunRequestFromSnapshot(input.snapshot, input.run);
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
        })(), completedTestOutcome({ finalMessage: 'DeepAgent executor response.' }));
}
      },
      eventBus,
      modelFactory: {
        createDefaultModelHandle: async () => ({
          modelId: 'openai:gpt-4.1',
          providerId: 'openai'
        }),
        createModelHandleByProviderAndModel: modelFactory.createModelHandleByProviderAndModel
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
    expect(repository.listThreadEvents(result.threadId!)).toContainEqual(
      expect.objectContaining({
        runId: result.runId,
        type: 'assistant_block',
        payload: {
          kind: 'tool_call',
          blockId: 'tool-call-web-read',
          callId: 'call-web-read',
          name: 'web_read',
          phase: 'start',
          input: {
            url: 'https://example.test'
          }
        }
      })
    );
  });

  it('persists a redacted per-run telemetry summary at completion', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-secret-call',
            callId: 'call-secret',
            name: 'web_read',
            phase: 'start',
            input: { url: 'https://secret.example.test' }
          });
          yield createToolBlock(input.run.id, {
            kind: 'tool_call',
            blockId: 'tool-secret-call',
            callId: 'call-secret',
            name: 'web_read',
            phase: 'error',
            error: 'secret-tool-error'
          });
          yield {
            type: 'subagent_event',
            runId: input.run.id,
            sequence: 1,
            identity: {
              subagentId: 'subagent-secret',
              parentSubagentId: null,
              name: 'research',
              depth: 1,
              path: ['research#0'],
              execution: 'sync',
              taskInput: 'secret-subagent-task'
            },
            event: { kind: 'started' }
          } satisfies ChatRunEvent;
          yield {
            type: 'subagent_event',
            runId: input.run.id,
            sequence: 2,
            identity: {
              subagentId: 'subagent-secret',
              parentSubagentId: null,
              name: 'research',
              depth: 1,
              path: ['research#0'],
              execution: 'sync',
              taskInput: 'secret-subagent-task'
            },
            event: { kind: 'failed', error: 'secret-subagent-error' }
          } satisfies ChatRunEvent;
          yield {
            type: 'context_maintenance',
            runId: input.run.id,
            threadId: input.run.threadId,
            event: 'context_compaction_started',
            mode: 'task',
            stage: 'deterministic',
            inputTokens: 7000,
            budgetTokens: 7168,
            estimated: true
          } satisfies ChatRunEvent;
          yield {
            type: 'context_maintenance',
            runId: input.run.id,
            threadId: input.run.threadId,
            event: 'context_summary_completed',
            mode: 'task',
            stage: 'summary',
            removedChars: 4000
          } satisfies ChatRunEvent;
          yield {
            type: 'context_maintenance',
            runId: input.run.id,
            threadId: input.run.threadId,
            event: 'context_tool_result_persisted',
            mode: 'task',
            stage: 'persist',
            persistedChars: 2000
          } satisfies ChatRunEvent;
          yield createTextBlock(input.run.id, 'Telemetry response.');
        })(), completedTestOutcome({
          finalMessage: 'Telemetry response.',
          usage: {
            callCount: 2,
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            cacheReadTokens: 40,
            cacheCreationTokens: 10
          }
        }));
}
      },
      capabilityPreviewProvider: createTestCapabilityPreviewProvider(),
      eventBus,
      modelFactory,
      repository,
      workspaceProvider: async () => ({
        id: 'workspace-secret',
        path: 'F:\\private\\workspace',
        displayName: 'Secret workspace',
        lastOpenedAt: '2026-07-26T00:00:00.000Z',
        trustState: 'trusted'
      })
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: 'secret-user-input',
      taskSource: 'workbench',
      workspacePath: 'F:\\private\\workspace'
    });

    await waitForEvent(() => repository.getRun(result.runId).status === 'completed');

    expect(repository.getRunTelemetry(result.runId)).toMatchObject({
      schemaVersion: 1,
      correlation: {
        runId: result.runId,
        threadId: result.threadId,
        runOrigin: 'manual_task_run',
        dispatchKey: null,
        snapshotVersion: 2,
        manifestHash: expect.any(String),
        providerId: 'openai',
        modelId: 'openai:gpt-4.1'
      },
      model: {
        callCount: 2,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 40,
        cacheCreationTokens: 10,
        reportedCostUsd: null
      },
      tool: { callCount: 1, errorCount: 1 },
      subagent: { count: 1, failedCount: 1, maxDepth: 1 },
      context: {
        compactionCount: 1,
        summaryCount: 1,
        artifactCount: 1,
        failureCount: 0,
        estimatedCount: 1,
        inputTokens: 7000,
        budgetTokens: 7168,
        removedChars: 4000,
        persistedChars: 2000
      },
      runtime: {
        firstOutputMs: expect.any(Number),
        totalDurationMs: expect.any(Number),
        recoveryCount: 0
      },
      terminal: {
        status: 'completed',
        errorCode: null,
        retryable: null,
        cancelSource: null
      }
    });
    const telemetryJson = db
      .prepare('SELECT telemetry_json FROM agent_run_telemetry WHERE run_id = ?')
      .pluck()
      .get(result.runId) as string;
    expect(telemetryJson).not.toContain('secret-user-input');
    expect(telemetryJson).not.toContain('F:\\private\\workspace');
    expect(telemetryJson).not.toContain('secret-tool-error');
    expect(telemetryJson).not.toContain('secret-subagent-task');
    expect(telemetryJson).not.toContain('secret-subagent-error');
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
        createModelHandleByProviderAndModel: modelFactory.createModelHandleByProviderAndModel
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
          code: 'provider_execution_failed',
          message: 'agent_deep_agent_executor_missing',
          retryable: false
        }
      })
    );
  });

  it('publishes the request workspacePath on completed run events', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('Workspace-bound response.'),
      capabilityPreviewProvider: createTestCapabilityPreviewProvider(),
      eventBus,
      modelFactory,
      repository,
      workspaceProvider: async () => ({
        id: 'workspace-roc',
        path: 'F:\\Code\\Roc',
        displayName: 'Roc',
        lastOpenedAt: '2026-07-15T00:00:00.000Z',
        trustState: 'trusted'
      })
    });

    const result = await runtime.startRun({
      ...startRequest,
      taskSource: 'workbench',
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
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          validatedAttachments = Reflect.get(input, 'validatedAttachments');
          yield createTextBlock(input.run.id, '图片里有图表。');
        })(), completedTestOutcome({ finalMessage: '图片里有图表。' }));
}
      },
      capabilityPreviewProvider: createTestCapabilityPreviewProvider(),
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
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield {
            type: 'run_interrupted',
            runId: input.run.id,
            threadId: input.run.threadId,
            interruptId: 'interrupt_approval_1',
            payload: approvalPayload()
          } satisfies ChatRunEvent;
        })(), interruptedTestOutcome({
          interrupts: [{ interruptId: 'interrupt_approval_1', payload: approvalPayload() }]
        }));
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
    expect(repository.getRunTelemetry(result.runId)?.terminal).toEqual({
      status: null,
      errorCode: null,
      retryable: null,
      cancelSource: null
    });
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

  it('uses the structured execution outcome instead of inferring interruption from events', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
          return createAgentDeepAgentExecution({
            events: (async function* () {
              yield {
                type: 'run_interrupted',
                runId: input.run.id,
                threadId: input.run.threadId,
                interruptId: 'event_only_interrupt',
                payload: {
                  kind: 'question',
                  question: 'This event must not control the run outcome.'
                }
              } satisfies ChatRunEvent;
              yield createTextBlock(input.run.id, 'Completed despite the event.');
            })(),
            outcome: completedTestOutcome({ finalMessage: 'Completed despite the event.' })
          });
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: 'Complete this run.',
      mode: 'task'
    });

    await waitForEvent(() => repository.getRun(result.runId).status === 'completed');

    expect(repository.getRun(result.runId).status).toBe('completed');
    expect(repository.listSessionMessages({ threadId: result.threadId! })).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Completed despite the event.'
      })
    );
    expect(readPendingInterrupts(repository, result.runId).interrupts).toEqual([]);
    expect(events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')).toBe(false);
  });

  it('rejects resume after restart when the required telemetry row is missing', async () => {
    const repository = new AgentSessionRepository(db);
    const deepAgentExecutor: NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> = {
      execute(input) {
        const outcome = input.resumePayload === undefined
          ? interruptedTestOutcome({
              interrupts: [
                {
                  interruptId: 'interrupt_missing_telemetry',
                  payload: { kind: 'question', question: 'Resume after restart?' }
                }
              ]
            })
          : completedTestOutcome({ finalMessage: 'resumed' });
  return createTestAgentExecution(() => (async function* () {
        if (input.resumePayload === undefined) {
          yield {
            type: 'run_interrupted',
            runId: input.run.id,
            threadId: input.run.threadId,
            interruptId: 'interrupt_missing_telemetry',
            payload: {
              kind: 'question',
              question: 'Resume after restart?'
            }
          } satisfies ChatRunEvent;
          return;
        }
        yield createTextBlock(input.run.id, 'resumed');
      })(), outcome);
}
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor,
      eventBus,
      modelFactory,
      repository
    });
    const started = await runtime.startRun(startRequest);
    await waitForEvent(() => repository.getRun(started.runId).status === 'waiting_user');
    if (started.threadId === null) {
      throw new Error('test_started_thread_missing');
    }
    db.prepare('DELETE FROM agent_run_telemetry WHERE run_id = ?').run(started.runId);
    const restartedRuntime = new AgentPluginRuntime({
      deepAgentExecutor,
      eventBus,
      modelFactory,
      repository
    });

    await expect(
      restartedRuntime.resumeRun({
        answer: 'Continue.',
        interruptId: 'interrupt_missing_telemetry',
        kind: 'question',
        runId: started.runId,
        threadId: started.threadId
      })
    ).rejects.toThrow('agent_run_telemetry_missing');
    expect(repository.getRun(started.runId).status).toBe('waiting_user');
    expect(readPendingInterrupts(repository, started.runId).interrupts).toEqual([
      expect.objectContaining({ interruptId: 'interrupt_missing_telemetry' })
    ]);
  });

  it('resumes question interrupts with answer payload and preserves run context', async () => {
    const repository = new AgentSessionRepository(db);
    const requests: ChatStartRunRequest[] = [];
    const resumePayloads: unknown[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  const outcome = input.resumePayload === undefined
    ? interruptedTestOutcome({
        interrupts: [
          {
            interruptId: 'interrupt-question',
            payload: {
              kind: 'question',
              question: 'Which path should I inspect?',
              context: 'Two paths match.'
            }
          }
        ],
        usage: {
          callCount: 1,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cacheReadTokens: null,
          cacheCreationTokens: null
        }
      })
    : completedTestOutcome({
        finalMessage: 'continued',
        usage: {
          callCount: 2,
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          cacheReadTokens: 5,
          cacheCreationTokens: 1
        }
      });
  return createTestAgentExecution(() => (async function* () {
          requests.push(createChatStartRunRequestFromSnapshot(input.snapshot, input.run));
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
        })(), outcome);
}
      },
      capabilityPreviewProvider: createTestCapabilityPreviewProvider(),
      eventBus,
      modelFactory,
      repository,
      workspaceProvider: async () => ({
        id: 'workspace-roc',
        path: 'F:\\Code\\Roc',
        displayName: 'Roc',
        lastOpenedAt: '2026-07-15T00:00:00.000Z',
        trustState: 'trusted'
      })
    });

    const start = await runtime.startRun({
      input: 'Investigate',
      mode: 'plan',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      threadId: null,
      workflowHint: null,
      taskSource: null,
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
      workspacePath: 'F:\\Code\\Roc',
      explicitSkillIds: ['typescript']
    });
    expect(resumePayloads[1]).toEqual({
      'interrupt-question': {
        answer: 'Use F:\\Code\\Roc.'
      }
    });
    expect(repository.getRunTelemetry(start.runId)?.model).toEqual({
      callCount: 3,
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
      reportedCostUsd: null
    });
  });

  it('consumes a resume payload once before checkpoint recovery retries', async () => {
    const repository = new AgentSessionRepository(db);
    const resumePayloads: unknown[] = [];
    const checkpointFlags: boolean[] = [];
    let calls = 0;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
          const attempt = ++calls;
          resumePayloads.push(input.resumePayload);
          checkpointFlags.push(input.resumeFromCheckpoint === true);
          if (attempt === 1) {
            return createTestAgentExecution(() => (async function* () {
              yield {
                type: 'run_interrupted',
                runId: input.run.id,
                threadId: input.run.threadId,
                interruptId: 'interrupt-resume-recovery',
                payload: {
                  kind: 'question',
                  question: 'Continue after stream failure?'
                }
              } satisfies ChatRunEvent;
            })(), interruptedTestOutcome({
              interrupts: [{
                interruptId: 'interrupt-resume-recovery',
                payload: { kind: 'question', question: 'Continue after stream failure?' }
              }]
            }));
          }
          if (attempt === 2) {
            const failure = new ProviderStreamTerminatedError();
            return createTestAgentExecution(() => (async function* () {
              yield createTextBlock(input.run.id, 'partial response');
              throw failure;
            })(), Promise.reject(failure));
          }
          return createTestAgentExecution(() => (async function* () {
            yield createTextBlock(input.run.id, 'recovered response');
          })(), completedTestOutcome({ finalMessage: 'recovered response' }));
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const start = await runtime.startRun(startRequest);
    await waitForEvent(
      () => events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_interrupted')
    );

    await runtime.resumeRun({
      kind: 'question',
      runId: start.runId,
      threadId: start.threadId!,
      interruptId: 'interrupt-resume-recovery',
      answer: 'Continue.'
    });
    await waitForEvent(
      () => events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed'),
      1500
    );

    expect(resumePayloads).toHaveLength(3);
    expect(resumePayloads[1]).toEqual({
      'interrupt-resume-recovery': { answer: 'Continue.' }
    });
    expect(resumePayloads[2]).toBeUndefined();
    expect(checkpointFlags).toEqual([false, false, true]);
  });

});

function createTextDeepAgentExecutor(text = 'Static agent response.'): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute(input) {
  return createTestAgentExecution(() => (async function* () {
      yield createTextBlock(input.run.id, text);
    })(), completedTestOutcome({ finalMessage: text }));
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

async function waitForEvent(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

