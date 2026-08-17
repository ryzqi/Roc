import type { Database as DatabaseConnection } from 'better-sqlite3';

import { AgentRunEventLog } from '../plugins/agent/run-event-log';
import { RocSqliteCheckpointer } from '../services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../services/deep-agent/tool-effect-store';

export function deleteAgentThreadHistory(db: DatabaseConnection, threadId: string): void {
  const targetThreadId = requireHistoryThreadId(threadId);
  db.transaction(() => {
    const runIds = db.prepare('SELECT id FROM agent_runs WHERE thread_id = ?').pluck().all(targetThreadId) as string[];
    db.prepare('DELETE FROM agent_run_leases WHERE thread_id = ? OR run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId, targetThreadId);
    db.prepare('DELETE FROM agent_pending_interrupts WHERE thread_id = ? OR run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId, targetThreadId);
    db.prepare(
      `UPDATE agent_outbox
       SET event_type = 'run_deleted', payload_json = '{}'
       WHERE thread_id = ? OR run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)`
    )
      .run(targetThreadId, targetThreadId);
    new AgentRunEventLog(db).deleteForRunIds(runIds);
    const toolEffects = new AgentToolEffectStore(db);
    toolEffects.deleteForThread(targetThreadId);
    toolEffects.deleteForRunIds(runIds);
    db.prepare('DELETE FROM context_artifacts WHERE thread_id = ? OR run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId, targetThreadId);
    new RocSqliteCheckpointer(db).deleteThreadCheckpoints(targetThreadId);
    db.prepare('DELETE FROM session_messages WHERE thread_id = ?').run(targetThreadId);
    db.prepare('DELETE FROM agent_events WHERE thread_id = ? OR run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId, targetThreadId);
    db.prepare('DELETE FROM agent_thread_event_cursors WHERE thread_id = ?').run(targetThreadId);
    db.prepare('DELETE FROM agent_run_telemetry WHERE run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId);
    db.prepare('DELETE FROM agent_langsmith_trace_sessions WHERE run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)')
      .run(targetThreadId);
    db.prepare('DELETE FROM agent_runs WHERE thread_id = ?').run(targetThreadId);
    db.prepare('DELETE FROM agent_threads WHERE id = ?').run(targetThreadId);
  })();
}

export function deleteTaskProjectionForThread(db: DatabaseConnection, threadId: string): void {
  const targetThreadId = requireHistoryThreadId(threadId);
  db.transaction(() => {
    db.prepare(
      `DELETE FROM scheduled_task_runs
       WHERE background_task_id IN (SELECT id FROM background_tasks WHERE thread_id = ?)`
    ).run(targetThreadId);
    db.prepare(
      `DELETE FROM scheduled_occurrences
       WHERE background_task_id IN (SELECT id FROM background_tasks WHERE thread_id = ?)`
    ).run(targetThreadId);
    db.prepare('DELETE FROM background_tasks WHERE thread_id = ?').run(targetThreadId);
  })();
}

function requireHistoryThreadId(threadId: string): string {
  if (threadId.length === 0) {
    throw new Error('agent_history_thread_id_empty');
  }
  return threadId;
}
