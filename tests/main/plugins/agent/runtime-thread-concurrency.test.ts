import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RocEventBus } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
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

const eventBus: RocEventBus = {
  publish: async () => {},
  subscribe: () => () => {}
};

const startRequest: ChatStartRunRequest = {
  enabledCapabilities: {
    mcpServers: [],
    skills: []
  },
  input: 'Inspect the workspace',
  mode: 'task',
  threadId: 'thread_shared'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('AgentPluginRuntime thread concurrency characterization', () => {
  it('allows two started runs for the same thread to execute concurrently', async () => {
    const repository = new AgentSessionRepository(db);
    const releaseExecutors = deferred<void>();
    const bothExecutorsStarted = deferred<void>();
    const executorRunIds: string[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          executorRunIds.push(input.run.id);
          if (executorRunIds.length === 2) {
            bothExecutorsStarted.resolve();
          }
          await releaseExecutors.promise;
          yield textBlock(input.run.id);
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const first = await runtime.startRun(startRequest);
    const second = await runtime.startRun({
      ...startRequest,
      input: 'Inspect the second workspace state'
    });

    expect(first.threadId).toBe('thread_shared');
    expect(second.threadId).toBe('thread_shared');
    expect(first.runId).not.toBe(second.runId);

    await vi.runAllTimersAsync();
    await bothExecutorsStarted.promise;

    expect(executorRunIds).toEqual([first.runId, second.runId]);
    expect(repository.getRun(first.runId).status).toBe('waiting_next_turn');
    expect(repository.getRun(second.runId).status).toBe('waiting_next_turn');

    releaseExecutors.resolve();
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
      text: 'done'
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
