import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema as applyAgentPluginSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentRunTelemetryRepository } from '../../../../src/main/plugins/agent/run-telemetry';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  seedRun();
});

afterEach(() => {
  db.close();
});

describe('AgentRunTelemetryRepository', () => {
  it('round-trips one redacted versioned summary by run id', () => {
    const repository = new AgentRunTelemetryRepository(db);
    const telemetry = createTelemetry();

    repository.save(telemetry, '2026-07-26T01:02:03.000Z');

    expect(repository.get('run_telemetry_1')).toEqual(telemetry);
    const persisted = db
      .prepare('SELECT schema_version, telemetry_json, created_at, updated_at FROM agent_run_telemetry WHERE run_id = ?')
      .get('run_telemetry_1') as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schema_version: 1,
      created_at: '2026-07-26T01:02:03.000Z',
      updated_at: '2026-07-26T01:02:03.000Z'
    });
    expect(persisted.telemetry_json).not.toContain('secret-user-input');
    expect(persisted.telemetry_json).not.toContain('F:\\private\\workspace');
  });

  it('rejects unknown fields instead of persisting arbitrary content', () => {
    const repository = new AgentRunTelemetryRepository(db);
    const telemetry = {
      ...createTelemetry(),
      rawPrompt: 'secret-user-input'
    };

    expect(() => repository.save(telemetry, '2026-07-26T01:02:03.000Z')).toThrow(
      'agent_run_telemetry_invalid'
    );
    expect(repository.get('run_telemetry_1')).toBeNull();
  });

  it('fails closed when persisted telemetry JSON is corrupt', () => {
    db.prepare(
      `INSERT INTO agent_run_telemetry
       (run_id, schema_version, telemetry_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      'run_telemetry_1',
      1,
      '{not-json',
      '2026-07-26T01:02:03.000Z',
      '2026-07-26T01:02:03.000Z'
    );

    const repository = new AgentRunTelemetryRepository(db);

    expect(() => repository.get('run_telemetry_1')).toThrow('agent_run_telemetry_corrupt');
  });
});

function createTelemetry() {
  return {
    schemaVersion: 1 as const,
    correlation: {
      runId: 'run_telemetry_1',
      threadId: 'thread_telemetry_1',
      runOrigin: 'chat' as const,
      dispatchKey: null,
      snapshotVersion: 2 as const,
      manifestHash: 'manifest_hash_1',
      providerId: 'provider_1',
      modelId: 'model_1'
    },
    model: {
      callCount: 2,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      reportedCostUsd: null
    },
    tool: {
      callCount: 3,
      errorCount: 1
    },
    subagent: {
      count: 2,
      failedCount: 1,
      maxDepth: 1
    },
    context: {
      compactionCount: 1,
      summaryCount: 1,
      artifactCount: 2,
      failureCount: 0,
      estimatedCount: 1,
      inputTokens: 7000,
      budgetTokens: 7168,
      removedChars: 4000,
      persistedChars: 2000
    },
    runtime: {
      firstOutputMs: 80,
      totalDurationMs: 900,
      recoveryCount: 1
    },
    terminal: {
      status: 'completed' as const,
      errorCode: null,
      retryable: null,
      cancelSource: null
    }
  };
}

function seedRun(): void {
  const now = '2026-07-26T01:00:00.000Z';
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('thread_telemetry_1', 'chat', 'Telemetry', 'Telemetry', 'running', now, now);
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('run_telemetry_1', 'thread_telemetry_1', 1, 'secret-user-input', 'running', now, '{}');
}
