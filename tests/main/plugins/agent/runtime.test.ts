import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { createChatStartRunRequestFromSnapshot } from '../../../../src/main/plugins/agent/run-execution-snapshot';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { agentRunEventLogMaxEvents, AgentRunEventLog } from '../../../../src/main/plugins/agent/run-event-log';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { buildWorkspaceHash } from '../../../../src/main/services/paths';
import type { AgentCapabilityPreview, ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

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

  it('publishes the mode-aware capability preview with the run-start projection', async () => {
    const repository = new AgentSessionRepository(db);
    const previewRequests: Array<{ mode: ChatStartRunRequest['mode']; requestedCapabilities: ChatStartRunRequest['enabledCapabilities'] }> = [];
    const runtime = new AgentPluginRuntime({
      capabilityPreviewProvider: async (input) => {
        previewRequests.push({
          mode: input.mode,
          requestedCapabilities: input.requestedCapabilities
        });
        return capabilityPreview(input.requestedCapabilities);
      },
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      enabledCapabilities: {
        mcpServers: ['docs'],
        skills: ['research']
      },
      input: 'Plan the migration',
      mode: 'plan'
    });

    expect(previewRequests).toEqual([
      {
        mode: 'plan',
        requestedCapabilities: {
          mcpServers: ['docs'],
          skills: ['research']
        }
      }
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          runId: result.runId,
          capabilityPreview: expect.objectContaining({
            requestedCapabilities: {
              mcpServers: ['docs'],
              skills: ['research']
            }
          })
        }),
        type: 'agent.run.started'
      })
    );
    await waitForEvent(() =>
      events.some(
        (event) =>
          event.type === 'agent.chat.run-event' &&
          readChatRunEvent(event.payload)?.runId === result.runId &&
          readChatRunEvent(event.payload)?.type === 'run_completed'
      )
    );
  });

  it('freezes explicit skills without changing resolved capabilities', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      capabilityPreviewProvider: async (input) => capabilityPreview(input.requestedCapabilities, input.explicitSkillIds),
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      enabledCapabilities: {
        mcpServers: [],
        skills: ['typescript']
      },
      explicitSkillIds: ['python-expert'],
      input: 'Review this Python migration.',
      mode: 'chat'
    });
    const snapshot = repository.getRunExecutionSnapshot(result.runId);

    expect(snapshot.explicitSkillIds).toEqual(['python-expert']);
    expect(snapshot.capabilityManifest.resolvedCapabilities.skills).toEqual(['typescript']);
    expect(snapshot.capabilityManifest.skills.map((skill) => skill.canonicalIdentity)).toEqual([
      'skill:typescript',
      'skill:python-expert'
    ]);
    expect(repository.listThreadEvents(snapshot.threadId)).toContainEqual(
      expect.objectContaining({
        type: 'context_manifest',
        payload: expect.objectContaining({
          skillCards: [
            expect.objectContaining({ id: 'skill:typescript' }),
            expect.objectContaining({ id: 'skill:python-expert' })
          ]
        })
      })
    );
    await waitForEvent(() =>
      events.some(
        (event) =>
          event.type === 'agent.chat.run-event' &&
          readChatRunEvent(event.payload)?.runId === result.runId &&
          readChatRunEvent(event.payload)?.type === 'run_completed'
      )
    );
  });

  it('rejects a background-task workflow hint without workbench provenance', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    await expect(
      runtime.startRun({
        ...startRequest,
        taskSource: null,
        workflowHint: 'propose_background_task'
      })
    ).rejects.toThrow('agent_workflow_hint_source_invalid');
  });

  it('freezes scheduled task runs with their scheduler provenance', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      taskSource: 'background_schedule',
      workspacePath: 'F:\\Code\\Roc'
    });
    const run = repository.getRun(result.runId);
    const snapshot = repository.getRunExecutionSnapshot(result.runId);

    expect(snapshot.runOrigin).toBe('background_schedule');
    expect(createChatStartRunRequestFromSnapshot(snapshot, run).taskSource).toBe('background_schedule');
    expect(db.prepare('SELECT kind FROM agent_threads WHERE id = ?').get(result.threadId)).toEqual({ kind: 'background' });
    await waitForEvent(() =>
      events.some(
        (event) =>
          event.type === 'agent.chat.run-event' &&
          readChatRunEvent(event.payload)?.runId === result.runId &&
          readChatRunEvent(event.payload)?.type === 'run_completed'
      )
    );
  });

  it('returns the same run for a duplicate scheduled occurrence dispatch key', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });
    const request = {
      ...startRequest,
      dispatchKey: 'background_1:2026-07-17T00:00:00.000Z:1',
      taskSource: 'background_schedule' as const,
      workspacePath: 'F:\\Code\\Roc'
    };

    const first = await runtime.startRun(request);
    const second = await runtime.startRun(request);

    expect(second).toEqual(first);
    expect(repository.getRunExecutionSnapshot(first.runId).dispatchKey).toBe(request.dispatchKey);
    expect(db.prepare('SELECT COUNT(*) AS total FROM agent_runs').get()).toEqual({ total: 1 });
    await waitForEvent(() =>
      events.some(
        (event) =>
          event.type === 'agent.chat.run-event' &&
          readChatRunEvent(event.payload)?.runId === first.runId &&
          readChatRunEvent(event.payload)?.type === 'run_completed'
      )
    );
  });


  it('stores workbench background task proposal runs outside chat history', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(),
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      taskSource: 'workbench',
      workflowHint: 'propose_background_task'
    });

    const thread = db.prepare('SELECT kind FROM agent_threads WHERE id = ?').get(result.threadId) as { kind: string } | undefined;
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.runId === result.runId && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(thread).toEqual({ kind: 'background' });
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

  it('records assistant session messages with workspace hash on completion', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      eventBus,
      modelFactory,
      repository
    });
    const preview = capabilityPreview(startRequest.enabledCapabilities);
    const run = repository.createTaskRun({
      capabilityPreview: preview,
      snapshot: runSnapshot(preview, 'openai:gpt-4.1'),
      threadKind: 'chat',
      userInput: 'Summarize'
    });

    const result = await runtime.completeRun({
      runId: run.id,
      assistantMessage: 'Done',
      summary: 'Done',
      durationMs: 10,
      providerId: 'openai',
      modelId: 'gpt-4.1',
      workspacePath: 'F:\\Code\\Roc'
    });

    expect(result.message.workspaceHash).toBe(buildWorkspaceHash('F:\\Code\\Roc'));
    expect(repository.listThreadEvents(run.threadId)).toContainEqual(
      expect.objectContaining({
        runId: run.id,
        type: 'agent_update',
        payload: {
          providerId: 'openai',
          modelId: 'gpt-4.1',
          finishReason: 'stop',
          durationMs: 10,
          summary: 'Done'
        }
      })
    );
  });

  it('publishes deterministic completion summary instead of slicing assistant text at 120 characters', async () => {
    const assistantMessage = [
      'Implemented workspace scoped session search and verified focused tests.',
      'Production prompt markers now flow through the context harness.',
      'Memory promotion remains scoped to MEMORY.md only.'
    ].join(' ');
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor(assistantMessage),
      eventBus,
      modelFactory,
      repository
    });

    await runtime.startRun({
      ...startRequest,
      mode: 'chat'
    });
    await waitForEvent(() => events.some((event) => event.type === 'agent.run.completed'));

    const completedEvent = events.find((event) => event.type === 'agent.run.completed');
    const completedPayload = completedEvent?.payload as { summary: string } | undefined;
    expect(completedPayload?.summary).toBe(assistantMessage);
  });

  it('keeps execution successful when streamed replay reaches its reserved capacity', async () => {
    const repository = new AgentSessionRepository(db);
    const releaseExecution = createDeferred<void>();
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          await releaseExecution.promise;
          yield createTextBlock(input.run.id, 'Live event after replay capacity.');
        }
      },
      eventBus,
      modelFactory,
      repository,
      runEventLog: new AgentRunEventLog(db)
    });

    const result = await runtime.startRun(startRequest);
    const log = new AgentRunEventLog(db);
    for (let index = 0; index < agentRunEventLogMaxEvents - 2; index += 1) {
      log.recordRunEvent({
        type: 'assistant_block',
        runId: result.runId,
        block: {
          kind: 'text',
          blockId: `text-replay-${index}`,
          phase: 'delta',
          text: String(index)
        }
      });
    }

    releaseExecution.resolve(undefined);
    await waitForEvent(() => repository.getRun(result.runId).status === 'completed');

    expect(
      db.prepare('SELECT failure_count FROM agent_notification_metrics WHERE code = ?').get('agent_run_event_replay_persist_failed')
    ).toEqual({ failure_count: 1 });
    expect(
      db.prepare('SELECT sequence, event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(result.runId)
    ).toEqual({
      sequence: agentRunEventLogMaxEvents,
      event_json: expect.stringContaining('run_completed')
    });
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
        createModelHandleByProviderAndModel: modelFactory.createModelHandleByProviderAndModel
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
    expect(
      db.prepare('SELECT event_json FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC').all(result.runId)
    ).toContainEqual({ event_json: expect.stringContaining('run_cancelled') });
    expect(
      db.prepare("SELECT event_type, payload_json FROM agent_outbox WHERE run_id = ?").get(result.runId)
    ).toEqual({ event_type: 'run_cancelled', payload_json: expect.stringContaining('user_cancelled') });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({ runId: result.runId, type: 'run_cancelled' })
      })
    );
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
        createModelHandleByProviderAndModel: modelFactory.createModelHandleByProviderAndModel
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
          code: 'provider_execution_failed',
          message: 'provider_unavailable',
          retryable: true
        }
      })
    );
  });

  it('persists diagnostic and suggestion fields identically to the live terminal failure event', async () => {
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* () {
          throw new Error(
            "Error invoking tool 'propose_background_task': Received tool input did not match expected schema kwargs {'goal':'daily review','forbiddenActions':[]} with error: Invalid input"
          );
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

    const live = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload))
      .find((event): event is Extract<ChatRunEvent, { type: 'run_failed' }> => event?.type === 'run_failed');
    const replay = new AgentRunEventLog(db).listRunEvents({ afterSequence: 0, runId: result.runId }).at(-1)?.event;

    expect(live).toMatchObject({
      code: 'tool_input_schema_invalid',
      diagnostic: expect.objectContaining({ toolName: 'propose_background_task' }),
      suggestion: expect.stringContaining('propose_background_task')
    });
    expect(replay).toEqual(live);
  });

  it('recovers transient provider connection errors before publishing final failure', async () => {
    const repository = new AgentSessionRepository(db);
    let calls = 0;
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          calls += 1;
          if (calls === 1) {
            yield createTextBlock(input.run.id, 'partial ');
            throw new Error('Connection error.');
          }
          yield createTextBlock(input.run.id, 'done');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);

    await waitForEvent(
      () =>
        events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed'),
      1500
    );

    const chatEvents = events
      .filter((event) => event.type === 'agent.chat.run-event')
      .map((event) => readChatRunEvent(event.payload));

    expect(chatEvents.map((event) => event?.type)).toContain('run_recovering');
    expect(chatEvents.map((event) => event?.type)).toContain('run_recovered');
    expect(repository.getRun(result.runId).status).toBe('completed');
    expect(repository.getRunTransitionState(result.runId).stateVersion).toBe(6);
    expect(calls).toBe(2);
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

async function waitForEvent(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_event_not_published');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function capabilityPreview(
  selectedCapabilities: ChatStartRunRequest['enabledCapabilities'],
  explicitSkillIds: ChatStartRunRequest['explicitSkillIds'] = []
): AgentCapabilityPreview {
  const manifestSkillIds = [...selectedCapabilities.skills];
  for (const skillId of explicitSkillIds) {
    if (!manifestSkillIds.includes(skillId)) {
      manifestSkillIds.push(skillId);
    }
  }
  const compiled = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    explicitSkillIds,
    mcpApprovalMode: 'fully_automatic',
    mcpServers: selectedCapabilities.mcpServers.map((id) => ({
      id,
      name: id,
      enabled: true,
      transport: 'http' as const,
      status: 'ready' as const,
      tools: 0,
      allowedTools: []
    })),
    mode: 'chat',
    workflowHint: null,
    requestedCapabilities: selectedCapabilities,
    skills: manifestSkillIds.map((id) => ({
      id,
      name: id,
      enabled: true,
      path: `F:\\skills\\${id}`,
      description: `${id} skill`,
      status: 'ready' as const
    }))
  });
  return {
    runnable: false,
    modelId: 'openai:gpt-4.1',
    builtInTools: [],
    selectedCapabilities: compiled.manifest.resolvedCapabilities,
    requestedCapabilities: compiled.manifest.requestedCapabilities,
    skippedCapabilities: compiled.manifest.skippedCapabilities,
    toolCards: compiled.toolCards,
    skillCards: compiled.skillCards,
    subagents: compiled.subagents,
    interruptOn: compiled.interruptOn,
    manifest: compiled.manifest,
    untrustedContextPolicy: 'external_content_reference_only',
    reason: 'test'
  };
}

function runSnapshot(preview: AgentCapabilityPreview, modelId: string) {
  return {
    schemaVersion: 1 as const,
    runOrigin: 'chat' as const,
    model: {
      providerId: 'openai',
      modelId
    },
    mode: 'run' as const,
    workspace: null,
    capabilityManifest: preview.manifest,
    budget: {
      contextBudgetTokens: null
    },
    workflowHint: null,
    explicitSkillIds: [],
    dispatchKey: null
  };
}

function readChatRunEvent(payload: unknown): ChatRunEvent | null {
  if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
    return null;
  }
  return payload as ChatRunEvent;
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
