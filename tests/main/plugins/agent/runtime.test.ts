import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import { buildWorkspaceHash } from '../../../../src/main/services/paths';
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

    const thread = db.prepare('SELECT kind FROM task_threads WHERE id = ?').get(result.threadId) as { kind: string } | undefined;
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
    const run = repository.createTaskRun({
      enabledCapabilities: startRequest.enabledCapabilities,
      modelId: 'openai:gpt-4.1',
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
