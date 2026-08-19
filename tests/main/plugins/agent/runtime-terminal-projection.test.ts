import { completedTestOutcome, createTestAgentExecution } from './test-execution';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import { RocDomainError } from '../../../../src/main/services/errors';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

let db: Database.Database;

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

const startRequest: ChatStartRunRequest = {
  enabledCapabilities: {
    mcpServers: [],
    skills: []
  },
  input: 'Finish this run',
  mode: 'task'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(db);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('AgentPluginRuntime terminal projection characterization', () => {
  it('keeps a completed run terminal when a completed subscriber rejects', async () => {
    const repository = new AgentSessionRepository(db);
    const completedSubscriberRejected = deferred<void>();
    const published: RocEventEnvelope[] = [];
    const eventBus: RocEventBus = {
      publish: async (event) => {
        published.push(event);
        if (event.type === 'agent.run.completed') {
          completedSubscriberRejected.resolve();
          throw new RocDomainError({
            code: 'task_projection_failed',
            message: 'task_projection_failed',
            category: 'internal',
            retryable: false
          });
        }
      },
      subscribe: () => () => {}
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield textBlock(input.run.id);
        })(), completedTestOutcome({ finalMessage: 'completed before projection failure' }));
}
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await runtime.startRun(startRequest);

    await vi.runAllTimersAsync();
    await completedSubscriberRejected.promise;
    await Promise.resolve();

    expect(published.map((event) => event.type)).toContain('agent.run.completed');
    expect(published.map((event) => event.type)).not.toContain('agent.run.failed');
    expect(repository.getRun(started.runId).status).toBe('completed');

    await runtime.shutdown();
  });

  it('continues execution when a started subscriber rejects', async () => {
    const repository = new AgentSessionRepository(db);
    const eventBus: RocEventBus = {
      publish: async (event) => {
        if (event.type === 'agent.run.started') {
          throw new RocDomainError({
            code: 'task_projection_failed',
            message: 'task_projection_failed',
            category: 'internal',
            retryable: false
          });
        }
      },
      subscribe: () => () => {}
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute(input) {
  return createTestAgentExecution(() => (async function* () {
          yield textBlock(input.run.id);
        })(), completedTestOutcome({ finalMessage: 'completed before projection failure' }));
}
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await runtime.startRun(startRequest);

    await vi.runAllTimersAsync();

    expect(repository.getRun(started.runId).status).toBe('completed');

    await runtime.shutdown();
  });
});

function textBlock(runId: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'text',
      blockId: `text-${runId}`,
      phase: 'delta',
      text: 'completed before projection failure'
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value) => resolve(value)
  };
}
