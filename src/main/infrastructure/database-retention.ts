import type { Database as DatabaseConnection } from 'better-sqlite3';

export type RocDatabaseRetentionPolicy = {
  terminalRunRetentionDays: number;
  maxCheckpointsPerThread: number;
  autoMemoryAuditRetentionDays: number;
};

export type RocDatabaseRetentionResult = {
  deleted: {
    agentEvents: number;
    agentRunEvents: number;
    agentOutbox: number;
    runTelemetry: number;
    langSmithTraceSessions: number;
    checkpoints: number;
    checkpointWrites: number;
    toolEffects: number;
    contextArtifacts: number;
    memoryAudit: number;
  };
};

export function runDatabaseRetention(input: {
  agentDb: DatabaseConnection;
  memoryDb: DatabaseConnection;
  policy: RocDatabaseRetentionPolicy;
  now: Date;
}): RocDatabaseRetentionResult {
  validatePolicy(input.policy);
  const terminalCutoff = cutoffIso(input.now, input.policy.terminalRunRetentionDays);
  const memoryAuditCutoff = cutoffIso(input.now, input.policy.autoMemoryAuditRetentionDays);
  const agentDeleted = runAgentRetention(input.agentDb, input.policy, terminalCutoff);
  const memoryAudit = runMemoryRetention(input.memoryDb, memoryAuditCutoff);
  return {
    deleted: {
      ...agentDeleted,
      memoryAudit
    }
  };
}

function runAgentRetention(
  agentDb: DatabaseConnection,
  policy: RocDatabaseRetentionPolicy,
  terminalCutoff: string
): Omit<RocDatabaseRetentionResult['deleted'], 'memoryAudit'> {
  return agentDb.transaction(() => {
    try {
      createProtectedThreadTempTable(agentDb, terminalCutoff);
      createOldRunTempTable(agentDb, terminalCutoff);
      createOldCheckpointTempTable(agentDb, policy.maxCheckpointsPerThread);
      const agentEvents = agentDb.prepare('DELETE FROM agent_events WHERE run_id IN (SELECT run_id FROM retention_old_runs)').run()
        .changes;
      const agentRunEvents = agentDb.prepare('DELETE FROM agent_run_events WHERE run_id IN (SELECT run_id FROM retention_old_runs)').run()
        .changes;
      const agentOutbox = agentDb.prepare('DELETE FROM agent_outbox WHERE run_id IN (SELECT run_id FROM retention_old_runs)').run().changes;
      const runTelemetry = agentDb
        .prepare('DELETE FROM agent_run_telemetry WHERE run_id IN (SELECT run_id FROM retention_old_runs)')
        .run().changes;
      const langSmithTraceSessions = agentDb
        .prepare('DELETE FROM agent_langsmith_trace_sessions WHERE run_id IN (SELECT run_id FROM retention_old_runs)')
        .run().changes;
      const toolEffects = agentDb.prepare('DELETE FROM agent_tool_effects WHERE run_id IN (SELECT run_id FROM retention_old_runs)').run()
        .changes;
      const contextArtifacts = agentDb
        .prepare('DELETE FROM context_artifacts WHERE run_id IN (SELECT run_id FROM retention_old_runs)')
        .run().changes;
      const checkpointWrites = agentDb
        .prepare(
          `DELETE FROM langgraph_checkpoint_writes
           WHERE EXISTS (
             SELECT 1
             FROM retention_old_checkpoints old
             WHERE old.thread_id = langgraph_checkpoint_writes.thread_id
               AND old.checkpoint_ns = langgraph_checkpoint_writes.checkpoint_ns
               AND old.checkpoint_id = langgraph_checkpoint_writes.checkpoint_id
           )`
        )
        .run().changes;
      const checkpoints = agentDb
        .prepare(
          `DELETE FROM langgraph_checkpoints
           WHERE EXISTS (
             SELECT 1
             FROM retention_old_checkpoints old
             WHERE old.thread_id = langgraph_checkpoints.thread_id
               AND old.checkpoint_ns = langgraph_checkpoints.checkpoint_ns
               AND old.checkpoint_id = langgraph_checkpoints.checkpoint_id
           )`
        )
        .run().changes;
      return {
        agentEvents,
        agentRunEvents,
        agentOutbox,
        runTelemetry,
        langSmithTraceSessions,
        checkpoints,
        checkpointWrites,
        toolEffects,
        contextArtifacts
      };
    } finally {
      dropTempTables(agentDb);
    }
  })();
}

function createOldRunTempTable(agentDb: DatabaseConnection, terminalCutoff: string): void {
  agentDb.exec(`
    DROP TABLE IF EXISTS temp.retention_old_runs;
    CREATE TEMP TABLE retention_old_runs (
      run_id TEXT PRIMARY KEY
    );
  `);
  agentDb
    .prepare(
      `INSERT INTO retention_old_runs (run_id)
       SELECT id
       FROM agent_runs
       WHERE status IN ('failed','cancelled','completed','interrupted','archived')
         AND COALESCE(ended_at, started_at) < ?
         AND thread_id NOT IN (SELECT thread_id FROM retention_protected_threads)`
    )
    .run(terminalCutoff);
}

function createProtectedThreadTempTable(agentDb: DatabaseConnection, terminalCutoff: string): void {
  agentDb.exec(`
    DROP TABLE IF EXISTS temp.retention_protected_threads;
    CREATE TEMP TABLE retention_protected_threads (
      thread_id TEXT PRIMARY KEY
    );
  `);
  agentDb
    .prepare(
      `INSERT INTO retention_protected_threads (thread_id)
       SELECT DISTINCT thread_id
       FROM agent_runs
       WHERE status NOT IN ('failed','cancelled','completed','interrupted','archived')
          OR COALESCE(ended_at, started_at) >= ?
       UNION
       SELECT DISTINCT thread_id
       FROM agent_pending_interrupts`
    )
    .run(terminalCutoff);
}

function createOldCheckpointTempTable(agentDb: DatabaseConnection, maxCheckpointsPerThread: number): void {
  agentDb.exec(`
    DROP TABLE IF EXISTS temp.retention_old_checkpoints;
    CREATE TEMP TABLE retention_old_checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
  `);
  agentDb
    .prepare(
      `INSERT INTO retention_old_checkpoints (thread_id, checkpoint_ns, checkpoint_id)
       SELECT thread_id, checkpoint_ns, checkpoint_id
       FROM (
         SELECT thread_id,
                checkpoint_ns,
                checkpoint_id,
                ROW_NUMBER() OVER (
                  PARTITION BY thread_id
                  ORDER BY created_at DESC, checkpoint_id DESC
                ) AS checkpoint_rank
         FROM langgraph_checkpoints
         WHERE thread_id NOT IN (
           SELECT thread_id FROM retention_protected_threads
         )
       )
       WHERE checkpoint_rank > ?`
    )
    .run(maxCheckpointsPerThread);
}

function runMemoryRetention(memoryDb: DatabaseConnection, memoryAuditCutoff: string): number {
  return memoryDb
    .prepare('DELETE FROM memory_auto_audit WHERE created_at < ?')
    .run(memoryAuditCutoff).changes;
}

function dropTempTables(agentDb: DatabaseConnection): void {
  agentDb.exec(`
    DROP TABLE IF EXISTS temp.retention_old_runs;
    DROP TABLE IF EXISTS temp.retention_old_checkpoints;
    DROP TABLE IF EXISTS temp.retention_protected_threads;
  `);
}

function validatePolicy(policy: RocDatabaseRetentionPolicy): void {
  if (policy.terminalRunRetentionDays < 0) {
    throw new Error('database_retention_terminal_days_invalid');
  }
  if (policy.maxCheckpointsPerThread < 1) {
    throw new Error('database_retention_checkpoint_limit_invalid');
  }
  if (policy.autoMemoryAuditRetentionDays < 0) {
    throw new Error('database_retention_memory_days_invalid');
  }
}

function cutoffIso(now: Date, retentionDays: number): string {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}
