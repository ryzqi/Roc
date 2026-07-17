import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryReader } from '../../../../src/main/plugins/task/agent-task-history';
import { applyTaskPluginSchema } from '../../../../src/main/plugins/task/schema';
import { TaskRepository } from '../../../../src/main/plugins/task/task-repository';
import { ThreadDeletionJournal } from '../../../../src/main/plugins/task/thread-deletion-journal';
import type { BackgroundTaskPreviewRequest, EnabledCapabilities } from '../../../../src/shared/types';

let db: Database.Database;
let agentDb: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['planning']
};

const manualPreviewRequest: BackgroundTaskPreviewRequest = {
  goal: 'Review the workspace every morning',
  trigger: {
    type: 'manual',
    description: 'Run when requested'
  },
  workspacePath: 'F:\\Code\\Roc',
  allowedActions: [],
  forbiddenActions: [],
  failurePolicy: 'pause_and_report',
  notificationPolicy: 'failures_and_confirmations',
  enabledCapabilities
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb);
});

afterEach(() => {
  db.close();
  agentDb.close();
});

describe('TaskRepository', () => {
  it('creates proposal run requests from description input and background-task workflow hint', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();

    expect(
      repository.createBackgroundTaskProposalRequest({
        description: 'Create a daily review task',
        enabledCapabilities
      })
    ).toEqual({
      input: 'Create a daily review task',
      mode: 'task',
      enabledCapabilities,
      workflowHint: 'propose_background_task'
    });
  });

  it('writes and reads current background task rows', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();

    const preview = repository.createBackgroundTaskPreview(manualPreviewRequest);
    const task = repository.createBackgroundTask(manualPreviewRequest);

    expect(preview).toMatchObject({ riskLevel: 'low', requiresConfirmation: false });
    expect(task).toMatchObject({
      goal: 'Review the workspace every morning',
      scheduled: false,
      status: 'running',
      triggerType: 'manual'
    });
    expect(new AgentTaskHistoryReader(agentDb).listEventsForThread(task.threadId)).toContainEqual(
      expect.objectContaining({
        runId: task.runId,
        type: 'background_task_created',
        payload: expect.objectContaining({
          taskId: task.id,
          goal: task.goal,
          status: task.status
        })
      })
    );
    expect(repository.findBackgroundTask(task.id)).toEqual(task);
    expect(rawRow('background_tasks', task.id)).toMatchObject({
      enabled_capabilities_json: JSON.stringify(enabledCapabilities),
      scheduled: 0,
      status: 'running',
      trigger_type: 'manual'
    });
    expect(columnNames('background_tasks')).toContain('thread_id');
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('re-derives risk fields from the raw create request', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();

    const task = repository.createBackgroundTask({
      ...manualPreviewRequest,
      forbiddenActions: ['Remove-Item -Recurse release']
    });

    expect(task.riskLevel).toBe('medium');
    expect(task.requiresConfirmation).toBe(true);
  });

  it('rejects non-positive scheduled run limits before querying sqlite', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();
    const task = repository.createBackgroundTask(manualPreviewRequest);

    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: 0 })).toThrow('scheduled_runs_limit_invalid');
    expect(() => repository.listScheduledRuns({ taskId: task.id, limit: -1 })).toThrow('scheduled_runs_limit_invalid');
  });

  it('preserves current background task status names across lifecycle mutations', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();
    const task = repository.createBackgroundTask(manualPreviewRequest);

    expect(repository.pauseBackgroundTask(task.id).status).toBe('paused');
    expect(repository.resumeBackgroundTask(task.id).status).toBe('running');
    expect(repository.cancelBackgroundTask(task.id).status).toBe('cancelled');
    expect(repository.deleteBackgroundTask(task.id)).toEqual({
      deleted: true,
      taskId: task.id
    });
    expect(repository.findBackgroundTask(task.id)?.status).toBe('archived');
  });

  it('physically deletes background thread history and task projection rows', () => {
    applyTaskPluginSchema(db);
    const repository = createRepository();
    const task = repository.createBackgroundTask(manualPreviewRequest);
    const now = '2026-07-06T00:00:00.000Z';
    repository.recordScheduledTaskRun({
      backgroundTaskId: task.id,
      scheduledAt: now,
      status: 'skipped',
      skipReason: 'manual_delete_regression'
    });
    db.prepare(
      `INSERT INTO scheduled_occurrences
       (occurrence_key, background_task_id, task_revision, scheduled_at, status, claim_owner, claim_expires_at,
        attempt, dispatch_key, run_id, request_json, created_at, claimed_at, dispatched_at, terminal_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'occurrence_delete_regression',
      task.id,
      1,
      now,
      'skipped',
      null,
      null,
      0,
      'occurrence_delete_regression',
      null,
      '{}',
      now,
      null,
      null,
      now,
      'manual_delete_regression'
    );
    insertAgentThreadResidue({
      runId: task.runId,
      threadId: task.threadId,
      createdAt: now
    });

    expect(countRows(db, 'background_tasks')).toBe(1);
    expect(countRows(db, 'scheduled_task_runs')).toBe(1);
    expect(countRows(db, 'scheduled_occurrences')).toBe(1);
    expect(countRows(agentDb, 'agent_threads')).toBe(1);
    expect(countRows(agentDb, 'agent_runs')).toBe(1);
    expect(countRows(agentDb, 'agent_events')).toBe(1);
    expect(countRows(agentDb, 'session_messages')).toBe(1);
    expect(countRows(agentDb, 'session_messages_fts')).toBe(1);
    expect(countRows(agentDb, 'agent_pending_interrupts')).toBe(1);
    expect(countRows(agentDb, 'agent_run_events')).toBe(1);
    expect(countRows(agentDb, 'langgraph_checkpoints')).toBe(1);
    expect(countRows(agentDb, 'langgraph_checkpoint_writes')).toBe(1);
    expect(countRows(agentDb, 'agent_tool_effects')).toBe(1);
    expect(countRows(agentDb, 'context_artifacts')).toBe(1);

    expect(repository.deleteThread(task.threadId)).toEqual({
      deleted: true,
      threadId: task.threadId
    });

    expect(repository.findBackgroundTask(task.id)).toBeNull();
    expect(countRows(db, 'scheduled_task_runs')).toBe(0);
    expect(countRows(db, 'scheduled_occurrences')).toBe(0);
    expect(countRows(db, 'background_tasks')).toBe(0);
    expect(countRows(agentDb, 'agent_threads')).toBe(0);
    expect(countRows(agentDb, 'agent_runs')).toBe(0);
    expect(countRows(agentDb, 'agent_events')).toBe(0);
    expect(countRows(agentDb, 'session_messages')).toBe(0);
    expect(countRows(agentDb, 'session_messages_fts')).toBe(0);
    expect(countRows(agentDb, 'agent_pending_interrupts')).toBe(0);
    expect(countRows(agentDb, 'agent_run_events')).toBe(0);
    expect(countRows(agentDb, 'langgraph_checkpoints')).toBe(0);
    expect(countRows(agentDb, 'langgraph_checkpoint_writes')).toBe(0);
    expect(countRows(agentDb, 'agent_tool_effects')).toBe(0);
    expect(countRows(agentDb, 'context_artifacts')).toBe(0);
    expect(new ThreadDeletionJournal(db).require(task.threadId).state).toBe('complete');
  });

  it('keeps an agent-delete failure pending, hidden, and retryable', () => {
    applyTaskPluginSchema(db);
    const journal = new ThreadDeletionJournal(db, () => '2026-07-10T02:00:00.000Z');
    const agentHistory = new AgentTaskHistoryReader(agentDb);
    const repository = new TaskRepository(db, agentHistory, journal);
    const task = repository.createBackgroundTask(manualPreviewRequest);
    const deleteSpy = vi.spyOn(agentHistory, 'deleteThread').mockImplementationOnce(() => {
      throw new Error('agent_delete_injected');
    });

    expect(() => repository.deleteThread(task.threadId)).toThrow('agent_delete_injected');
    expect(journal.require(task.threadId)).toMatchObject({
      state: 'pending',
      attemptCount: 1,
      lastError: 'agent_delete_injected'
    });
    expect(repository.findBackgroundTask(task.id)).toBeNull();
    expect(repository.listBackgroundTasks()).toEqual([]);
    expect(repository.getSnapshot().threads.some((thread) => thread.id === task.threadId)).toBe(false);

    deleteSpy.mockRestore();
    expect(repository.deleteThread(task.threadId)).toEqual({ deleted: true, threadId: task.threadId });
    expect(journal.require(task.threadId).state).toBe('complete');
    expect(repository.deleteThread(task.threadId)).toEqual({ deleted: true, threadId: task.threadId });
    expect(journal.require(task.threadId).attemptCount).toBe(1);
  });

  it('resumes projection deletion after agent history has already been deleted', () => {
    applyTaskPluginSchema(db);
    const journal = new ThreadDeletionJournal(db, () => '2026-07-10T02:00:00.000Z');
    const repository = new TaskRepository(db, new AgentTaskHistoryReader(agentDb), journal);
    const task = repository.createBackgroundTask(manualPreviewRequest);
    db.exec(`
      CREATE TRIGGER fail_background_task_delete
      BEFORE DELETE ON background_tasks
      BEGIN
        SELECT RAISE(ABORT, 'projection_delete_injected');
      END;
    `);

    expect(() => repository.deleteThread(task.threadId)).toThrow('projection_delete_injected');
    expect(journal.require(task.threadId)).toMatchObject({
      state: 'agent_deleted',
      attemptCount: 1
    });
    expect(journal.require(task.threadId).lastError).toContain('projection_delete_injected');
    expect(countRows(agentDb, 'agent_threads')).toBe(0);
    expect(countRows(db, 'background_tasks')).toBe(1);

    db.exec('DROP TRIGGER fail_background_task_delete;');
    expect(repository.deleteThread(task.threadId)).toEqual({ deleted: true, threadId: task.threadId });
    expect(journal.require(task.threadId).state).toBe('complete');
    expect(countRows(db, 'background_tasks')).toBe(0);
  });

  it('hides every public task surface as soon as deletion is journaled', () => {
    applyTaskPluginSchema(db);
    const journal = new ThreadDeletionJournal(db);
    const repository = new TaskRepository(db, new AgentTaskHistoryReader(agentDb), journal);
    const request: BackgroundTaskPreviewRequest = {
      ...manualPreviewRequest,
      trigger: {
        type: 'once',
        description: 'Run later',
        nextRunAt: '2026-07-11T00:00:00.000Z'
      }
    };
    const task = repository.createBackgroundTask(request);
    repository.recordScheduledTaskRun({
      backgroundTaskId: task.id,
      scheduledAt: '2026-07-11T00:00:00.000Z',
      status: 'skipped',
      skipReason: 'visibility_test'
    });
    journal.ensurePending(task.threadId);

    expect(repository.findBackgroundTask(task.id)).toBeNull();
    expect(repository.findBackgroundTaskByRunId(task.runId)).toBeNull();
    expect(repository.listBackgroundTasks()).toEqual([]);
    expect(repository.listSchedulableBackgroundTasks()).toEqual([]);
    expect(repository.getActiveTasks()).toEqual([]);
    expect(repository.getBackgroundTaskSummary().total).toBe(0);
    expect(repository.countRecentSkippedScheduledRuns()).toBe(0);
    expect(repository.getSnapshot().threads.map((thread) => thread.id)).not.toContain(task.threadId);
    expect(repository.getSnapshot().recentEvents.map((event) => event.threadId)).not.toContain(task.threadId);
    expect(() => repository.getTaskDetail({ taskId: task.id, schedulerRegistered: true })).toThrow(
      'background_task_not_found'
    );
    expect(() => repository.listScheduledRuns({ taskId: task.id })).toThrow('background_task_not_found');
    expect(() =>
      repository.listThreadMessages({ threadId: task.threadId, limit: 100, cursor: null })
    ).toThrow(expect.objectContaining({ code: 'task_thread_not_found' }));
  });
});

function rawRow(tableName: string, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
}

function createRepository(): TaskRepository {
  return new TaskRepository(db, new AgentTaskHistoryReader(agentDb));
}

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

function countRows(targetDb: Database.Database, tableName: string): number {
  return targetDb.prepare(`SELECT COUNT(*) FROM ${tableName}`).pluck().get() as number;
}

function insertAgentThreadResidue(input: { runId: string; threadId: string; createdAt: string }): void {
  agentDb
    .prepare(
      `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('smsg_delete_thread', input.threadId, 'assistant', 'delete thread residue', 10, 'visible', 'workspace_hash', input.createdAt);
  agentDb
    .prepare(
      `INSERT INTO agent_pending_interrupts
       (run_id, thread_id, interrupt_id, payload_json, mode, task_source, workflow_hint,
        workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId,
      input.threadId,
      'interrupt_delete_thread',
      '{}',
      'task',
      'workbench',
      'background_task',
      'value',
      'F:\\Code\\Roc',
      '[]',
      input.createdAt,
      input.createdAt
    );
  agentDb
    .prepare('INSERT INTO agent_run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(input.runId, 1, '{"type":"started"}', input.createdAt);
  agentDb
    .prepare(
      `INSERT INTO langgraph_checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.threadId, '', 'checkpoint_delete_thread', null, 'json', Buffer.from('{}'), 'json', Buffer.from('{}'), input.createdAt);
  agentDb
    .prepare(
      `INSERT INTO langgraph_checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.threadId, '', 'checkpoint_delete_thread', 'task_delete_thread', 0, 'messages', 'json', Buffer.from('[]'), input.createdAt);
  agentDb
    .prepare(
      `INSERT INTO agent_tool_effects
       (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.runId, input.threadId, 'tool_delete_thread', 'shell', 'hash_delete_thread', 'success', '{}', null, input.createdAt, input.createdAt);
  agentDb
    .prepare(
      `INSERT INTO context_artifacts
       (id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'ctx_delete_thread',
      input.runId,
      input.threadId,
      'tool_result',
      'tool_delete_thread',
      'shell',
      'sha_delete_thread',
      19,
      'delete thread residue',
      'delete thread residue',
      'workspace_hash',
      input.createdAt
    );
}
