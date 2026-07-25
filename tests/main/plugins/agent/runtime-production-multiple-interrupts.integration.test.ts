import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';

import type { RocCapabilityRegistry, RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import { createAgentDeepAgentExecutor } from '../../../../src/main/plugins/agent/deep-agent-executor';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import type { AgentModelFactoryAdapter, AgentModelHandle } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { ContextArtifactStore } from '../../../../src/main/services/deep-agent/context/context-artifact-store';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';
import { RocPaths } from '../../../../src/main/services/paths';
import { createTestCapabilityPreviewProvider } from './runtime-capability-preview-test-helpers';
import type { ChatRunEvent } from '../../../../src/shared/types';

const toolCalls = [
  [
    {
      name: 'ask_user',
      args: { question: 'Primary workspace?' },
      id: 'call_primary_workspace'
    },
    {
      name: 'ask_user',
      args: { question: 'Fallback workspace?' },
      id: 'call_fallback_workspace'
    }
  ],
  []
];

let db: Database.Database;
let tempDir: string;
let events: RocEventEnvelope[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-runtime-multiple-interrupts-'));
  db = new Database(join(tempDir, 'agent.db'));
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { force: true, recursive: true });
});

describe('AgentPluginRuntime production multiple interrupts', () => {
  it('reconstructs runtime and saver between partial resumes while consuming both answers', async () => {
    const first = createRuntime(db, 0);
    const started = await first.runtime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Ask for both workspace choices.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => readChatEvents('run_interrupted').length === 2);

    const firstPending = first.repository.getPendingInterrupts(started.runId).interrupts;
    expect(firstPending.map((interrupt) => interrupt.payload)).toEqual([
      {
        kind: 'question',
        question: 'Primary workspace?'
      },
      {
        kind: 'question',
        question: 'Fallback workspace?'
      }
    ]);
    const firstInterruptId = firstPending[0]?.interruptId;
    const secondInterruptId = firstPending[1]?.interruptId;
    if (firstInterruptId === undefined || secondInterruptId === undefined) {
      throw new Error('expected_two_pending_interrupts');
    }
    await first.runtime.shutdown();
    db.close();
    db = new Database(join(tempDir, 'agent.db'));
    db.pragma('foreign_keys = ON');

    const restarted = createRuntime(db, 1);
    restarted.repository.reconcileStartupRuns();
    expect(restarted.repository.getPendingInterrupts(started.runId).interrupts).toHaveLength(2);

    await restarted.runtime.resumeRun({
      kind: 'question',
      runId: started.runId,
      threadId,
      interruptId: firstInterruptId,
      answer: 'F:\\Code\\Roc'
    });
    await waitFor(() => readChatEvents('run_interrupted').length === 3);
    expect(restarted.repository.getRun(started.runId).status).toBe('waiting_user');
    expect(restarted.repository.getPendingInterrupts(started.runId).interrupts).toEqual([
      expect.objectContaining({ interruptId: secondInterruptId })
    ]);

    await restarted.runtime.shutdown();
    db.close();
    db = new Database(join(tempDir, 'agent.db'));
    db.pragma('foreign_keys = ON');
    const restartedAfterPartialResume = createRuntime(db, 1);
    restartedAfterPartialResume.repository.reconcileStartupRuns();
    expect(restartedAfterPartialResume.repository.getPendingInterrupts(started.runId).interrupts).toEqual([
      expect.objectContaining({ interruptId: secondInterruptId })
    ]);

    await restartedAfterPartialResume.runtime.resumeRun({
      kind: 'question',
      runId: started.runId,
      threadId,
      interruptId: secondInterruptId,
      answer: 'F:\\Code\\Fallback'
    });
    await waitFor(() => readChatEvents('run_completed').length === 1);

    expect(restartedAfterPartialResume.repository.getRun(started.runId).status).toBe('completed');
    expect(restartedAfterPartialResume.repository.getPendingInterrupts(started.runId).interrupts).toEqual([]);
    const assistantText = restartedAfterPartialResume.repository
      .listSessionMessages({ threadId })
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n');
    expect(assistantText).toContain('F:\\Code\\Roc');
    expect(assistantText).toContain('F:\\Code\\Fallback');
  });
});

function createRuntime(connection: Database.Database, modelIndex: number): {
  repository: AgentSessionRepository;
  runtime: AgentPluginRuntime;
} {
  const paths = new RocPaths(join(tempDir, 'paths'));
  paths.ensureTree();
  const capabilities = createCapabilities();
  const executor = createAgentDeepAgentExecutor({
    capabilities,
    checkpointer: new RocSqliteCheckpointer(connection),
    contextArtifactStore: new ContextArtifactStore(connection),
    paths,
    store: new InMemoryStore(),
    toolEffectStore: new AgentToolEffectStore(connection)
  });
  const modelFactory: AgentModelFactoryAdapter = {
    createDefaultModelHandle: async () => createModelHandle(modelIndex),
    createModelHandleByProviderAndModel: async () => createModelHandle(modelIndex)
  };
  const repository = new AgentSessionRepository(connection);
  return {
    repository,
    runtime: new AgentPluginRuntime({
      capabilityPreviewProvider: createTestCapabilityPreviewProvider(),
      deepAgentExecutor: executor,
      eventBus: createEventBus(),
      modelFactory,
      repository
    })
  };
}

function createModelHandle(index: number): AgentModelHandle {
  const model = new FakeToolCallingModel({ index, toolCalls });
  return {
    modelId: 'test-model',
    providerId: 'test-provider',
    langChainHandle: {
      model,
      modelId: 'test-model',
      provider: {
        id: 'test-provider',
        name: 'Test Provider',
        type: 'openai_compatible',
        endpoint: 'https://example.test',
        credentialRef: null,
        enabled: true,
        models: []
      },
      runtime: {
        providerType: 'openai_compatible',
        baseUrl: null,
        streaming: false,
        modelKwargs: {},
        contextBudgetTokens: 128_000
      }
    }
  };
}

function createEventBus(): RocEventBus {
  return {
    publish: async (event) => {
      events.push(event);
    },
    subscribe: () => () => {}
  };
}

function createCapabilities(): RocCapabilityRegistry {
  return {
    declare: () => {},
    register: () => {},
    list: () => [],
    invoke: async <TOutput>(name: string): Promise<TOutput> => {
      if (name === 'workspace.getCurrent') {
        return null as TOutput;
      }
      if (name === 'mcp.tools.get') {
        return [] as TOutput;
      }
      if (name === 'skills.list') {
        return [] as TOutput;
      }
      if (name === 'agent.sessions.search') {
        return { items: [], nextCursor: null } as TOutput;
      }
      throw new Error(`unexpected_capability:${name}`);
    }
  };
}

function readChatEvents(type: ChatRunEvent['type']): ChatRunEvent[] {
  return events
    .filter((event) => event.type === 'agent.chat.run-event')
    .map((event) => event.payload)
    .filter((payload): payload is ChatRunEvent => {
      return typeof payload === 'object' && payload !== null && Reflect.get(payload, 'type') === type;
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_runtime_state_not_reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function requireThreadId(threadId: string | null): string {
  if (threadId === null) {
    throw new Error('expected_thread_id');
  }
  return threadId;
}
