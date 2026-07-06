import Database from 'better-sqlite3';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentPluginSchema } from '../../../../../src/main/plugins/agent/schema';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import {
  runContextCompactionForTest,
  type ContextMaintenanceEvent
} from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import { markIterationOnMessage } from '../../../../../src/main/services/forge-guardrails';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

function mark<M extends BaseMessage>(message: M, iteration: number): M {
  return markIterationOnMessage(message, iteration) as M;
}

describe('RocContextCompactionPipeline', () => {
  it('persists oversized tool results before deterministic compaction and summarization', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const summarize = vi.fn(async () => ({
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

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
      emitEvent: (event) => events.push(event),
      mode: 'chat',
      model: {} as never,
      runId: 'run_ctx_pipeline_1',
      summarize,
      threadId: 'thread_ctx_pipeline_1',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_a',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 1200
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
    expect(messages.some(isContextDigestMessage)).toBe(true);
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

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 1000,
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

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
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
      countTokens: async () => 1200
    });

    expect(messages.some((message) => message.id === 'ai-tool-call')).toBe(true);
    expect(messages.some((message) => message.id === 'tool-result')).toBe(true);
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

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 1000,
      emitEvent: () => {},
      mode: 'chat',
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

    const toolResults = messages.filter(
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
      mark(new HumanMessage({ id: 'recent-user', content: 'continue from here' }), 8),
      mark(new AIMessage({ id: 'recent-ai', content: 'current next step' }), 8)
    ];

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
      emitEvent: () => {},
      mode: 'chat',
      model: {} as never,
      runId: 'run_ctx_pipeline_5',
      summarize: async () => ({
        goal: 'summarize old work',
        facts: ['Old implementation details were summarized.'],
        decisions: [],
        filesTouched: [],
        toolEvidence: [],
        verification: [],
        openQuestions: [],
        nextActions: ['Continue from recent tail.']
      }),
      threadId: 'thread_ctx_pipeline_5',
      workspaceHash: 'workspace_hash_summary',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 1200
    });

    expect(messages.some(isContextDigestMessage)).toBe(true);
    expect(messages[2] === undefined ? false : isContextDigestMessage(messages[2])).toBe(true);
    expect(messages.map((message) => message.id)).toEqual(['system', 'user', 'roc-context-digest', 'recent-user', 'recent-ai']);
    expect(messages.some((message) => message.id === 'old-ai-1')).toBe(false);
    expect(messages.some((message) => message.id === 'old-user-2')).toBe(false);
    expect(messages.some((message) => message.id === 'old-ai-3')).toBe(false);
  });

  it('keeps the run alive when only the summary stage cannot produce a valid schema', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'summarize old work' }),
      mark(new AIMessage({ id: 'old-ai-1', content: 'old implementation details' }), 1),
      mark(new HumanMessage({ id: 'recent-user', content: 'continue from here' }), 8),
      mark(new AIMessage({ id: 'recent-ai', content: 'current next step' }), 8)
    ];

    await expect(runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
      emitEvent: (event) => events.push(event),
      mode: 'chat',
      model: {} as never,
      runId: 'run_ctx_pipeline_summary_failure',
      summarize: async () => {
        throw new Error('context_summary_failed');
      },
      threadId: 'thread_ctx_pipeline_summary_failure',
      workspaceHash: 'workspace_hash_summary_failure',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 1200
    })).resolves.toBeUndefined();

    expect(events.map((event) => event.type)).toEqual([
      'context_compaction_started',
      'context_deterministic_compacted',
      'context_summary_started',
      'context_compaction_failed'
    ]);
    expect(messages.some(isContextDigestMessage)).toBe(false);
    expect(messages.map((message) => message.id)).toEqual(['system', 'user', 'recent-user', 'recent-ai']);
  });
});
