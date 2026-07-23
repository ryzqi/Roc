import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';

import { applyAgentPluginSchema } from '../../../../../src/main/plugins/agent/schema';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import { createRocContextCompactionMiddleware } from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { RocSqliteCheckpointer } from '../../../../../src/main/services/deep-agent/sqlite-checkpointer';

let db: Database.Database;
let databasePath: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-context-checkpoint-'));
  databasePath = join(tempDir, 'agent.db');
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  seedAgentThread(db, 'thread_context_checkpoint');
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { force: true, recursive: true });
});

describe('Roc context compaction checkpoint integration', () => {
  it('persists reducer compaction and restores it after rebuilding the graph', async () => {
    const threadId = 'thread_context_checkpoint';
    const config = { configurable: { thread_id: threadId } };
    const firstMessages = createMessages();
    const firstGraph = createCompactionGraph(db);

    const firstResult = await firstGraph.invoke({ messages: firstMessages }, config);
    const firstState = firstResult.messages as BaseMessage[];
    expect(firstState).toHaveLength(3);
    expect(String(firstState[2]?.content)).toContain('<roc_context_artifact>');

    db.close();
    db = new Database(databasePath);
    const restartedGraph = createCompactionGraph(db);
    const restartedState = await restartedGraph.getState(config);
    const restoredMessages = restartedState.values.messages as BaseMessage[];

    expect(restoredMessages).toHaveLength(3);
    expect(String(restoredMessages[2]?.content)).toContain('<roc_context_artifact>');
    expect(restoredMessages.map((message) => message.id)).toEqual(firstState.map((message) => message.id));
  });
});

function createCompactionGraph(connection: Database.Database) {
  const middleware = createRocContextCompactionMiddleware({
    artifactStore: new ContextArtifactStore(connection),
    budgetProfile: {
      contextWindowTokens: 1000,
      modelInputTokens: 1000,
      reservedOutputTokens: 0,
      systemToolOverheadTokens: 0,
      summaryInputTokens: 1000,
      safetyMarginTokens: 0
    },
    emitEvent: () => {},
    mode: 'chat',
    model: {} as never,
    runId: 'run_context_checkpoint',
    threadId: 'thread_context_checkpoint',
    tokenCounter: {
      countMessages: async () => ({ estimated: false, tokens: 100 }),
      countText: async () => ({ estimated: false, tokens: 100 }),
      wasEstimated: () => false
    },
    workspaceHash: 'workspace_hash_context_checkpoint',
    workspacePath: 'F:\\Code\\Roc'
  });
  const beforeModel = middleware.beforeModel;
  if (typeof beforeModel !== 'function') {
    throw new Error('context_compaction_before_model_missing');
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('compact', async (state) => {
      return await beforeModel(state as never, {} as never) as { messages: BaseMessage[] };
    })
    .addEdge(START, 'compact')
    .addEdge('compact', END)
    .compile({ checkpointer: new RocSqliteCheckpointer(connection) });
}

function createMessages(): BaseMessage[] {
  return [
    new HumanMessage({ id: 'context-user', content: 'Inspect the file.' }),
    new AIMessage({
      id: 'context-ai-tool',
      content: '',
      tool_calls: [{ id: 'context-call', name: 'read_file', args: { file_path: '/workspace/a.ts' }, type: 'tool_call' }]
    }),
    new ToolMessage({
      id: 'context-tool-result',
      tool_call_id: 'context-call',
      name: 'read_file',
      content: 'x'.repeat(40_000),
      status: 'success'
    })
  ];
}

function seedAgentThread(connection: Database.Database, threadId: string): void {
  connection.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    threadId,
    'chat',
    threadId,
    threadId,
    'running',
    '2026-06-24T00:00:00.000Z',
    '2026-06-24T00:00:00.000Z'
  );
}
