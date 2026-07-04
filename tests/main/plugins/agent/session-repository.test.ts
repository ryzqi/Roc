import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnabledCapabilities } from '../../../../src/shared/types';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

let db: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('AgentSessionRepository', () => {
  it('applies the migrated agent tables with current column names', () => {
    applyAgentPluginSchema(db);

    expect(columnNames('task_runs')).toContain('thread_id');
    expect(columnNames('task_events')).toContain('run_id');
    expect(columnNames('task_events')).toContain('payload_json');
    expect(columnNames('session_messages')).toContain('phase');
  });

  it('reads and writes task threads, task runs, task events, and session messages', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);

    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Summarize this workspace'
    });
    const event = repository.recordEvent({
      payload: {
        kind: 'text',
        blockId: `text-${run.id}`,
        phase: 'delta',
        text: 'Working'
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'assistant_block'
    });
    const message = repository.recordSessionMessage({
      content: 'Compaction note',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 12
    });

    expect(repository.getRun(run.id)).toEqual(run);
    const events = repository.listThreadEvents(run.threadId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      payload: {
        content: 'Summarize this workspace',
        enabledCapabilities,
        role: 'user'
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'message'
    });
    expect(events[1]).toEqual(event);
    expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
    expect(rawRow('task_runs', run.id)).toMatchObject({
      enabled_capabilities_json: JSON.stringify(enabledCapabilities),
      model_id: 'openai:gpt-4.1',
      thread_id: run.threadId
    });
    expect(rawRow('task_events', event.id)).toMatchObject({
      payload_json: JSON.stringify({
        kind: 'text',
        blockId: `text-${run.id}`,
        phase: 'delta',
        text: 'Working'
      }),
      run_id: run.id,
      thread_id: run.threadId
    });
    expect(rawRow('session_messages', message.id)).toMatchObject({
      phase: 'pre_compaction_flush',
      thread_id: run.threadId,
      token_count: 12
    });
  });

  it('marks interrupted runs waiting for the user while persisting resume metadata', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Review a pending command'
    });

    const interruptedRun = repository.markRunInterrupted({
      runId: run.id,
      threadId: run.threadId,
      interrupt: {
        interruptId: 'interrupt_repository_1',
        payload: {
          kind: 'approval',
          request: {
            actionRequests: [
              {
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        },
        mode: 'plan',
        taskSource: 'workbench',
        workflowHint: 'propose_background_task',
        workspacePath: undefined,
        explicitSkillIds: ['typescript']
      }
    });

    expect(interruptedRun.status).toBe('waiting_user');
    expect(repository.getPendingInterrupt(run.id)).toEqual({
      runId: run.id,
      threadId: run.threadId,
      interrupt: {
        interruptId: 'interrupt_repository_1',
        payload: {
          kind: 'approval',
          request: {
            actionRequests: [
              {
                name: 'run_shell_command',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'run_shell_command',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        },
        mode: 'plan',
        taskSource: 'workbench',
        workflowHint: 'propose_background_task',
        workspacePath: undefined,
        explicitSkillIds: ['typescript']
      }
    });
  });

  it('persists workspace hash on session messages', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Remember workspace context'
    });

    const message = repository.recordSessionMessage({
      content: 'Workspace specific answer',
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: 'workspace_hash_a'
    });

    expect(columnNames('session_messages')).toContain('workspace_hash');
    expect(message.workspaceHash).toBe('workspace_hash_a');
    expect(rawRow('session_messages', message.id)).toMatchObject({
      workspace_hash: 'workspace_hash_a'
    });
    expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
  });

  it('migrates existing session messages to support workspace hashes', () => {
    db.exec(`
      CREATE TABLE session_messages (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content        TEXT NOT NULL,
        token_count    INTEGER,
        phase          TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
        created_at     TEXT NOT NULL
      );

      INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
      VALUES ('smsg_legacy', 'thread_legacy', 'assistant', 'Legacy context', 8, 'visible', '2026-06-24T00:00:00.000Z');
    `);

    applyAgentPluginSchema(db);

    expect(columnNames('session_messages')).toContain('workspace_hash');
    expect(rawRow('session_messages', 'smsg_legacy')).toMatchObject({
      content: 'Legacy context',
      workspace_hash: null
    });
  });

  it('stores user image attachment metadata without base64 data', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: '描述图片',
      attachments: [
        {
          kind: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          sizeBytes: 123
        }
      ]
    });

    const events = repository.listThreadEvents(run.threadId);

    expect(events[0]?.payload).toEqual({
      role: 'user',
      content: '描述图片',
      enabledCapabilities,
      attachments: [
        {
          kind: 'image',
          name: 'diagram.png',
          mediaType: 'image/png',
          sizeBytes: 123
        }
      ]
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('base64');
  });

  it('filters current workspace search by workspace hash and keeps unscoped rows only in all scope', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const runA = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Workspace A'
    });
    const runB = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Workspace B'
    });

    repository.recordSessionMessage({
      content: 'alpha recall from workspace a',
      role: 'assistant',
      threadId: runA.threadId,
      workspaceHash: 'workspace_hash_a'
    });
    repository.recordSessionMessage({
      content: 'alpha recall from workspace b',
      role: 'assistant',
      threadId: runB.threadId,
      workspaceHash: 'workspace_hash_b'
    });
    repository.recordSessionMessage({
      content: 'alpha recall from unscoped history',
      role: 'assistant',
      threadId: runB.threadId,
      workspaceHash: null
    });

    const current = repository.searchSessionMessages({
      query: 'alpha',
      workspaceScope: 'current',
      workspaceHash: 'workspace_hash_a'
    });
    expect(current.items.map((item) => item.content)).toEqual(['alpha recall from workspace a']);

    const all = repository.searchSessionMessages({
      query: 'alpha',
      workspaceScope: 'all'
    });
    expect(all.items.map((item) => item.content).sort()).toEqual([
      'alpha recall from unscoped history',
      'alpha recall from workspace a',
      'alpha recall from workspace b'
    ]);
  });

  it('includes pre-compaction flush rows in workspace-scoped session search', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Create a long context summary'
    });

    repository.recordSessionMessage({
      content: 'summary index includes context artifact paymentserviceevidence',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 120,
      workspaceHash: 'workspace_hash_summary'
    });

    const result = repository.searchSessionMessages({
      query: 'paymentserviceevidence',
      workspaceHash: 'workspace_hash_summary',
      workspaceScope: 'current'
    });

    expect(result.items.map((item) => ({
      content: item.content,
      phase: item.phase,
      workspaceHash: item.workspaceHash
    }))).toEqual([
      {
        content: 'summary index includes context artifact paymentserviceevidence',
        phase: 'pre_compaction_flush',
        workspaceHash: 'workspace_hash_summary'
      }
    ]);
  });

  it('treats punctuation-heavy session_search queries as plain text instead of FTS syntax', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Review service evidence'
    });

    repository.recordSessionMessage({
      content: 'payment-service evidence lives under F:\\Code\\Roc\\src\\payments',
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: 'workspace_hash_query'
    });

    const result = repository.searchSessionMessages({
      query: 'payment-service F:\\Code\\Roc',
      workspaceHash: 'workspace_hash_query',
      workspaceScope: 'current'
    });

    expect(result.items.map((item) => item.content)).toEqual([
      'payment-service evidence lives under F:\\Code\\Roc\\src\\payments'
    ]);
  });
});

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function rawRow(tableName: string, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
}
