import Database from 'better-sqlite3';
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES, messagesStateReducer } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../../src/main/infrastructure/database-schemas';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import {
  createRocContextCompactionMiddleware,
  runContextCompaction,
  type ContextMaintenanceEvent
} from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { toRunFailure } from '../../../../../src/main/services/deep-agent/error-mapping';
import type { ContextBudgetProfile } from '../../../../../src/main/services/deep-agent/context/context-token-budget';
import { createFakePreCompactionFlushRecorder } from './pre-compaction-flush-test-helpers';
import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import { markIterationOnMessage } from '../../../../../src/main/services/forge-guardrails';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

function mark<M extends BaseMessage>(message: M, iteration: number): M {
  return markIterationOnMessage(message, iteration) as M;
}

function seedAgentThread(threadId: string, kind: 'chat' | 'plan' | 'background'): void {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    threadId,
    kind,
    threadId,
    threadId,
    'running',
    '2026-06-24T00:00:00.000Z',
    '2026-06-24T00:00:00.000Z'
  );
}

describe('RocContextCompactionPipeline', () => {
  it('returns a reducer update without mutating the input state', async () => {
    const store = new ContextArtifactStore(db);
    const originalTool = new ToolMessage({
      id: 'tool-large-state-update',
      tool_call_id: 'call-large-state-update',
      name: 'read_file',
      content: 'x'.repeat(40_000),
      status: 'success'
    });
    const state = {
      messages: [new HumanMessage({ id: 'user-state-update', content: 'inspect the file' }), originalTool]
    };
    const originalMessages = [...state.messages];
    seedAgentThread('thread_ctx_state_update', 'chat');
    const middleware = createRocContextCompactionMiddleware({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(1000),
      emitEvent: () => {},
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_state_update',
      threadId: 'thread_ctx_state_update',
      tokenCounter: {
        countMessages: async () => ({ estimated: false, tokens: 100 }),
        countText: async () => ({ estimated: false, tokens: 100 }),
        wasEstimated: () => false
      },
      workspaceHash: 'workspace_hash_state_update',
      workspacePath: 'F:\\Code\\Roc'
    });

    const beforeModel = middleware.beforeModel;
    if (typeof beforeModel !== 'function') {
      throw new Error('context_compaction_before_model_missing');
    }
    const update = await beforeModel(state as never, {} as never) as { messages: BaseMessage[] };

    expect(state.messages).toEqual(originalMessages);
    expect(originalTool.content).toHaveLength(40_000);
    expect(RemoveMessage.isInstance(update.messages[0])).toBe(true);
    expect(update.messages[0]?.id).toBe(REMOVE_ALL_MESSAGES);
    const reduced = messagesStateReducer(state.messages, update.messages);
    expect(String(reduced[1]?.content)).toContain('<roc_context_artifact>');
  });

  it('persists oversized tool results before deterministic compaction and summarization', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const summarize = vi.fn(async (_input: {
      messages: readonly BaseMessage[];
      recentMessages: readonly BaseMessage[];
    }) => ({
      goal: 'Keep context compact.',
      facts: ['Large tool output was persisted.'],
      decisions: [],
      filesTouched: [],
      toolEvidence: ['ctx artifact created'],
      verification: [],
      openQuestions: [],
      nextActions: ['Continue.']
    }));
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new ToolMessage({
          id: 'tool-large',
          tool_call_id: 'call-large',
          name: 'read_file',
          content: 'x'.repeat(5000),
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    seedAgentThread('thread_ctx_pipeline_1', 'chat');
    const originalIds = messages.map((message) => message.id);
    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: (event) => events.push(event),
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_pipeline_1',
      summarize,
      threadId: 'thread_ctx_pipeline_1',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_a',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: countBeforeAndAfterSummary
    });

    const persistedEvent = events.find((event) => event.type === 'context_tool_result_persisted');
    if (persistedEvent === undefined) {
      throw new Error('Expected context_tool_result_persisted event.');
    }
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'context_compaction_started',
      'context_tool_result_persisted',
      'context_deterministic_compacted',
      'context_summary_started',
      'context_summary_completed'
    ]));
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(compacted.some(isContextDigestMessage)).toBe(true);
    // 压缩结果只从返回值取；调用方传进来的数组一个元素都不动。
    expect(messages.map((message) => message.id)).toEqual(originalIds);
  });

  it('does not call the summarizer when deterministic stages bring context below threshold', async () => {
    const store = new ContextArtifactStore(db);
    const summarize = vi.fn();
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new ToolMessage({
          id: 'tool-small',
          tool_call_id: 'call-small',
          name: 'read_file',
          content: 'small output',
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    seedAgentThread('thread_ctx_pipeline_2', 'background');
    await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(1000),
      emitEvent: () => {},
      mode: 'task',
      model: {} as never,
      runId: 'run_ctx_pipeline_2',
      summarize,
      threadId: 'thread_ctx_pipeline_2',
      toolResultPersistChars: 1000,
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: async () => 100
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it('preserves complete tool call and tool result boundaries', async () => {
    const store = new ContextArtifactStore(db);
    const messages: BaseMessage[] = [
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new AIMessage({
          id: 'ai-tool-call',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read_file', args: { file_path: '/workspace/a.ts' }, type: 'tool_call' }]
        }),
        5
      ),
      mark(
        new ToolMessage({
          id: 'tool-result',
          tool_call_id: 'call-1',
          name: 'read_file',
          content: 'x'.repeat(5000),
          status: 'success'
        }),
        5
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    seedAgentThread('thread_ctx_pipeline_3', 'plan');
    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: () => {},
      mode: 'plan',
      model: {} as never,
      runId: 'run_ctx_pipeline_3',
      summarize: async () => ({
        goal: 'Boundary test.',
        facts: [],
        decisions: [],
        filesTouched: [],
        toolEvidence: [],
        verification: [],
        openQuestions: [],
        nextActions: []
      }),
      threadId: 'thread_ctx_pipeline_3',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_boundary',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: countBeforeAndAfterSummary
    });

    expect(compacted.some((message) => message.id === 'ai-tool-call')).toBe(true);
    expect(compacted.some((message) => message.id === 'tool-result')).toBe(true);
  });

  it('does not duplicate a paired tool result when deterministic compaction truncates it', async () => {
    const store = new ContextArtifactStore(db);
    const messages: BaseMessage[] = [
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new AIMessage({
          id: 'ai-tool-call',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read_file', args: { file_path: '/workspace/a.ts' }, type: 'tool_call' }]
        }),
        1
      ),
      mark(
        new ToolMessage({
          id: 'tool-result',
          tool_call_id: 'call-1',
          name: 'read_file',
          content: 'x'.repeat(5000),
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    seedAgentThread('thread_ctx_pipeline_4', 'chat');
    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(1000),
      emitEvent: () => {},
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_pipeline_4',
      summarize: vi.fn(),
      threadId: 'thread_ctx_pipeline_4',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_boundary',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 700
    });

    const toolResults = compacted.filter(
      (message): message is ToolMessage => ToolMessage.isInstance(message) && message.tool_call_id === 'call-1'
    );
    expect(toolResults).toHaveLength(1);
    expect(String(toolResults[0]?.content)).toContain('<roc_context_artifact>');
    expect(String(toolResults[0]?.content)).not.toContain('[Truncated');
  });

  it('removes old summarized messages after the summary stage keeps context above threshold', async () => {
    const store = new ContextArtifactStore(db);
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'summarize old work' }),
      mark(new AIMessage({ id: 'old-ai-1', content: 'old implementation details' }), 1),
      mark(new HumanMessage({ id: 'old-user-2', content: 'old correction' }), 2),
      mark(new AIMessage({ id: 'old-ai-3', content: 'old verification' }), 3),
      new HumanMessage({ id: 'recent-user', content: 'Recent constraint: must continue from here.' }),
      mark(new AIMessage({ id: 'recent-ai', content: 'current next step' }), 8)
    ];

    seedAgentThread('thread_ctx_pipeline_5', 'chat');
    const summarize = vi.fn(async (_input: {
      messages: readonly BaseMessage[];
      recentMessages: readonly BaseMessage[];
      userConstraints: readonly string[];
    }) => ({
      goal: 'summarize old work',
      facts: ['Old implementation details were summarized.'],
      decisions: [],
      filesTouched: [],
      toolEvidence: [],
      verification: [],
      openQuestions: [],
      nextActions: ['Continue from recent tail.']
    }));
    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: () => {},
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_pipeline_5',
      summarize,
      threadId: 'thread_ctx_pipeline_5',
      workspaceHash: 'workspace_hash_summary',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: countBeforeAndAfterSummary
    });

    const summaryInput = summarize.mock.calls[0]?.[0];
    expect(summaryInput?.messages.map((message) => message.id)).not.toEqual(
      expect.arrayContaining(['recent-user', 'recent-ai'])
    );
    expect(summaryInput?.recentMessages).toEqual([]);
    expect(summaryInput?.userConstraints).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Recent constraint')])
    );
    expect(compacted.some(isContextDigestMessage)).toBe(true);
    expect(compacted[2] === undefined ? false : isContextDigestMessage(compacted[2])).toBe(true);
    expect(compacted.map((message) => message.id)).toEqual(['system', 'user', 'roc-context-digest', 'recent-user', 'recent-ai']);
    expect(compacted.some((message) => message.id === 'old-ai-1')).toBe(false);
    expect(compacted.some((message) => message.id === 'old-user-2')).toBe(false);
    expect(compacted.some((message) => message.id === 'old-ai-3')).toBe(false);
  });

  it('keeps the run alive when only the summary stage cannot produce a valid schema', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'summarize old work' }),
      mark(new AIMessage({ id: 'old-ai-1', content: 'old implementation details' }), 1),
      new HumanMessage({ id: 'recent-user', content: 'r' }),
      mark(new AIMessage({ id: 'recent-ai', content: 'current next step' }), 8)
    ];

    seedAgentThread('thread_ctx_pipeline_summary_failure', 'chat');
    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(10),
      emitEvent: (event) => events.push(event),
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_pipeline_summary_failure',
      summarize: async () => {
        throw new Error('context_summary_failed');
      },
      threadId: 'thread_ctx_pipeline_summary_failure',
      workspaceHash: 'workspace_hash_summary_failure',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: countApproximateTokens
    });

    expect(events.map((event) => event.type)).toEqual([
      'context_compaction_started',
      'context_deterministic_compacted',
      'context_summary_started',
      'context_compaction_failed'
    ]);
    expect(compacted.some(isContextDigestMessage)).toBe(false);
    expect(await countApproximateTokens(compacted)).toBeLessThanOrEqual(10);
    expect(compacted.map((message) => message.id)).toEqual(['system', 'user', 'recent-user']);
  });

  it('propagates unknown summary implementation errors', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'summarize old work' }),
      mark(new AIMessage({ id: 'old-ai', content: 'old implementation details' }), 1),
      mark(new AIMessage({ id: 'recent-ai', content: 'current next step' }), 8)
    ];

    await expect(runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: (event) => events.push(event),
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_unknown_summary_failure',
      summarize: async () => {
        throw new Error('summary_programming_error', {
          cause: new TypeError('bad invariant')
        });
      },
      threadId: 'thread_ctx_unknown_summary_failure',
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: countBeforeAndAfterSummary
    })).rejects.toThrow('summary_programming_error');

    expect(events.filter((event) => event.type === 'context_compaction_failed')).toHaveLength(1);
  });

  it('fails before the model when protected context alone exceeds the hard budget', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 's'.repeat(120) }),
      new HumanMessage({ id: 'user', content: 'u'.repeat(120) }),
      mark(new AIMessage({ id: 'old-ai', content: 'old'.repeat(80) }), 1),
      mark(new HumanMessage({ id: 'recent-user', content: 'recent'.repeat(40) }), 8)
    ];
    seedAgentThread('thread_ctx_budget_exhausted', 'chat');

    const execution = runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(10),
      emitEvent: (event) => events.push(event),
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_budget_exhausted',
      summarize: async () => {
        throw new Error('context_summary_failed');
      },
      threadId: 'thread_ctx_budget_exhausted',
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: countApproximateTokens
    });

    await expect(execution).rejects.toThrow('context_budget_exhausted');
    expect(events.filter((event) => event.type === 'context_compaction_failed')).toHaveLength(1);
    expect(toRunFailure(new Error('context_budget_exhausted'))).toMatchObject({
      code: 'context_budget_exhausted',
      retryable: false
    });
  });

  it('does not call the summary model when the summary prompt cannot fit its budget', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const summarize = vi.fn();
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'summarize' }),
      mark(new AIMessage({ id: 'old', content: 'old work' }), 1)
    ];

    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: (event) => events.push(event),
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_summary_budget',
      summarize,
      threadId: 'thread_ctx_summary_budget',
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: async (candidate) => {
        if (candidate.some((message) => String(message.content).includes('You summarize old runtime context for Roc.'))) {
          return 150;
        }
        return candidate.length <= 2 ? 80 : 200;
      }
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'context_compaction_started',
      'context_deterministic_compacted',
      'context_summary_started',
      'context_compaction_failed'
    ]);
    expect(compacted.map((message) => message.id)).toEqual(['system', 'user']);
  });

  it('removes a paired tool call and result together during hard trim', async () => {
    const store = new ContextArtifactStore(db);
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'keep context' }),
      mark(new AIMessage({
        id: 'ai-tool-call-hard-trim',
        content: '',
        tool_calls: [{ id: 'call-hard-trim', name: 'read_file', args: {}, type: 'tool_call' }]
      }), 8),
      mark(new ToolMessage({
        id: 'tool-hard-trim',
        tool_call_id: 'call-hard-trim',
        name: 'read_file',
        content: 'tool result',
        status: 'success'
      }), 8),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 8)
    ];
    seedAgentThread('thread_ctx_pair_hard_trim', 'chat');

    const compacted = await runContextCompaction({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(100),
      emitEvent: () => {},
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_pair_hard_trim',
      summarize: async () => ({
        goal: 'Keep context.',
        facts: [],
        decisions: [],
        filesTouched: [],
        toolEvidence: [],
        verification: [],
        openQuestions: [],
        nextActions: []
      }),
      threadId: 'thread_ctx_pair_hard_trim',
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: async (candidate) => {
        if (candidate.some((message) => String(message.content).includes('You summarize old runtime context for Roc.'))) {
          return 50;
        }
        if (candidate.some((message) => isContextDigestMessage(message))) {
          return candidate.some((message) => AIMessage.isInstance(message) && message.tool_calls?.length) ? 200 : 50;
        }
        return 200;
      }
    });

    expect(compacted.some((message) => message.id === 'ai-tool-call-hard-trim')).toBe(false);
    expect(compacted.some((message) => message.id === 'tool-hard-trim')).toBe(false);
  });

  it('rejects an over-budget model request before invoking the provider', async () => {
    const store = new ContextArtifactStore(db);
    const middleware = createRocContextCompactionMiddleware({
      artifactStore: store,
      sessionHistory: createFakePreCompactionFlushRecorder(),
      budgetProfile: createTestBudgetProfile(1000),
      emitEvent: () => {},
      mode: 'run',
      model: {} as never,
      runId: 'run_ctx_model_gate',
      threadId: 'thread_ctx_model_gate',
      tokenCounter: {
        countMessages: async () => ({ estimated: false, tokens: 600 }),
        countText: async () => ({ estimated: false, tokens: 0 }),
        wasEstimated: () => false
      },
      workspaceHash: null,
      workspacePath: null
    });
    const wrapModelCall = Reflect.get(middleware as object, 'wrapModelCall');
    if (typeof wrapModelCall !== 'function') {
      throw new Error('context_compaction_wrap_model_call_missing');
    }
    const handler = vi.fn();

    await expect(wrapModelCall({
      messages: [new HumanMessage('over budget')],
      systemMessage: new SystemMessage('system'),
      tools: []
    }, handler)).rejects.toThrow('context_budget_exhausted');
    expect(handler).not.toHaveBeenCalled();
  });
});

async function countBeforeAndAfterSummary(messages: readonly BaseMessage[]): Promise<number> {
  if (messages.some((message) => String(message.content).includes('You summarize old runtime context for Roc.'))) {
    return 50;
  }
  return messages.some(isContextDigestMessage) ? 50 : 1200;
}

async function countApproximateTokens(messages: readonly BaseMessage[]): Promise<number> {
  const chars = messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return total + content.length;
  }, 0);
  return Math.ceil(chars / 4);
}

function createTestBudgetProfile(modelInputTokens: number): ContextBudgetProfile {
  return {
    contextWindowTokens: modelInputTokens,
    modelInputTokens,
    reservedOutputTokens: 0,
    systemToolOverheadTokens: 0,
    summaryInputTokens: modelInputTokens,
    safetyMarginTokens: 0
  };
}
