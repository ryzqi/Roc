import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

let db: Database.Database;
let events: RocEventEnvelope[];

const workspacePath = 'F:\\Code\\Roc';

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
  mode: 'chat',
  taskSource: 'workbench',
  workspacePath
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

describe('AgentPluginRuntime lifecycle hooks', () => {
  it('emits SessionEnd on completed runs', async () => {
    const repository = new AgentSessionRepository(db);
    const lifecycleHooks = {
      emitSessionEnd: vi.fn(async () => undefined)
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('done'),
      eventBus,
      lifecycleHooks,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(lifecycleHooks.emitSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        threadId: result.threadId,
        request: expect.objectContaining({
          input: 'Summarize this workspace',
          workspacePath
        }),
        status: 'completed',
        error: null
      })
    );
  });

  it('keeps failed run publication best-effort when SessionEnd rejects', async () => {
    const repository = new AgentSessionRepository(db);
    const lifecycleHooks = {
      emitSessionEnd: vi.fn(async () => {
        throw new Error('session_end_failed');
      })
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createFailingDeepAgentExecutor(),
      eventBus,
      lifecycleHooks,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_failed')
    );

    expect(lifecycleHooks.emitSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        threadId: result.threadId,
        status: 'failed',
        error: 'executor_failed'
      })
    );
  });

  it('emits SessionEnd for cancelled runs without changing the cancellation result', async () => {
    const repository = new AgentSessionRepository(db);
    const lifecycleHooks = {
      emitSessionEnd: vi.fn(async () => undefined)
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('done'),
      eventBus,
      lifecycleHooks,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);

    expect(runtime.cancelRun({ runId: result.runId })).toEqual({
      runId: result.runId,
      cancelled: true
    });
    await waitForEvent(() => lifecycleHooks.emitSessionEnd.mock.calls.length > 0);

    expect(lifecycleHooks.emitSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        threadId: result.threadId,
        status: 'cancelled',
        error: null
      })
    );
  });

  it('records hook runtime events as task events for persisted transcripts', async () => {
    const hookContext = '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>';
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'hook_started',
            runId: input.run.id,
            hook: {
              runId: 'hook-run-1',
              handlerId: 'PreToolUse:0:0',
              event: 'PreToolUse',
              status: 'running',
              durationMs: null,
              message: 'Checking shell command',
              additionalContext: null,
              requestContinue: null,
              commandDisplay: 'node hook.js'
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'text',
              blockId: `text-${input.run.id}`,
              phase: 'delta',
              text: `${hookContext}\n\ndone`
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'hook_completed',
            runId: input.run.id,
            hook: {
              runId: 'hook-run-1',
              handlerId: 'PreToolUse:0:0',
              event: 'PreToolUse',
              status: 'completed',
              durationMs: 12,
              message: 'Hook completed',
              additionalContext: hookContext,
              requestContinue: null,
              commandDisplay: 'node hook.js'
            }
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: {
          runId: result.runId,
          threadId: result.threadId,
          type: 'hook_completed',
          payload: {
            runId: 'hook-run-1',
            handlerId: 'PreToolUse:0:0',
            event: 'PreToolUse',
            status: 'completed',
            durationMs: 12,
            message: 'Hook completed',
            additionalContext: hookContext,
            requestContinue: null,
            commandDisplay: 'node hook.js'
          }
        }
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed',
          assistantMessage: 'done'
        })
      })
    );
  });

  it('completes hook-only responses after stripping echoed hook context', async () => {
    const hookContext = '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>';
    const repository = new AgentSessionRepository(db);
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'text',
              blockId: `text-${input.run.id}`,
              phase: 'delta',
              text: hookContext
            }
          } satisfies ChatRunEvent;
          yield {
            type: 'hook_completed',
            runId: input.run.id,
            hook: {
              runId: 'hook-run-1',
              handlerId: 'SessionStart:0:0',
              event: 'SessionStart',
              status: 'completed',
              durationMs: 8,
              message: 'Superpowers loaded',
              additionalContext: hookContext,
              requestContinue: null,
              commandDisplay: 'node session-start.js'
            }
          } satisfies ChatRunEvent;
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.chat.run-event',
        payload: expect.objectContaining({
          type: 'run_completed',
          assistantMessage: ''
        })
      })
    );
    expect(repository.getRun(result.runId)?.status).toBe('completed');
  });
});

function createTextDeepAgentExecutor(text: string): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute: async function* (input) {
      yield {
        type: 'assistant_block',
        runId: input.run.id,
        block: {
          kind: 'text',
          blockId: `text-${input.run.id}`,
          phase: 'delta',
          text
        }
      };
    }
  };
}

function createFailingDeepAgentExecutor(): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute: async function* () {
      throw new Error('executor_failed');
    }
  };
}

async function waitForEvent(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
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
