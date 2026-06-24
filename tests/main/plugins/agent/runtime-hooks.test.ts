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
  mode: 'chat',
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
