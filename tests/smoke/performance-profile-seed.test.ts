import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DatabasePool } from '../../src/main/infrastructure/database-pool';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from '../../src/main/infrastructure/database-schemas';

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('performance profile seed', () => {
  it('creates deterministic empty, 1k, and 10k data roots', () => {
    const roots = readProfileRoots();

    seedProfile(roots.empty, 0, 'thread-profile-empty');
    seedProfile(roots.profile1000, 1_000, 'thread-profile-1000');
    seedProfile(roots.profile10000, 10_000, 'thread-profile-10000');

    expect(countEvents(roots.profile1000)).toBe(1_000);
    expect(countEvents(roots.profile10000)).toBe(10_000);
  });
});

function readProfileRoots(): { empty: string; profile1000: string; profile10000: string } {
  const raw = process.env.ROC_PERFORMANCE_PROFILE_ROOTS;
  if (raw === undefined) {
    const suffixRoot = mkdtempSync(join(tmpdir(), 'roc-performance-profile-seed-'));
    temporaryRoots.push(suffixRoot);
    return {
      empty: join(suffixRoot, 'empty'),
      profile1000: join(suffixRoot, 'profile-1000'),
      profile10000: join(suffixRoot, 'profile-10000')
    };
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof parsed.empty !== 'string' ||
    typeof parsed.profile1000 !== 'string' ||
    typeof parsed.profile10000 !== 'string'
  ) {
    throw new Error('performance_profile_roots_invalid');
  }
  return { empty: parsed.empty, profile1000: parsed.profile1000, profile10000: parsed.profile10000 };
}

function seedProfile(dataRoot: string, eventCount: number, threadId: string): void {
  const pool = new DatabasePool(join(dataRoot, 'plugin-data'));
  try {
    applyCoreDatabaseSchema(pool.getCoreConnection());
    const agentDb = pool.getConnection('@roc/plugin-agent');
    applyAgentDatabaseSchema(agentDb);
    applyMemoryDatabaseSchema(pool.getConnection('@roc/plugin-memory'));
    applyTaskDatabaseSchema(pool.getConnection('@roc/plugin-task'));
    applyWorkspaceDatabaseSchema(pool.getConnection('@roc/plugin-workspace'));
    applyDiagnosticsDatabaseSchema(pool.getConnection('@roc/plugin-diagnostics'));
    if (eventCount === 0) {
      return;
    }
    const runId = `run-${threadId}`;
    agentDb
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, 'chat', ?, ?, 'completed', ?, ?)`
      )
      .run(threadId, `Profile ${eventCount}`, `Profile ${eventCount}`, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
    agentDb
      .prepare(
        `INSERT INTO agent_runs
         (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
          enabled_capabilities_json, workspace_path, task_source, workflow_hint)
         VALUES (?, ?, 1, 'profile', 'completed', ?, ?, NULL, NULL, ?, NULL, NULL, NULL)`
      )
      .run(
        runId,
        threadId,
        '2026-07-10T00:00:00.000Z',
        '2026-07-10T00:10:00.000Z',
        JSON.stringify({ mcpServers: [], skills: [] })
      );
    const insert = agentDb.prepare(
      `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'message', ?, ?)`
    );
    agentDb.transaction(() => {
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        insert.run(
          `event-${threadId}-${sequence}`,
          threadId,
          runId,
          sequence,
          JSON.stringify({ role: 'user', content: `profile-marker-${eventCount}-${sequence}` }),
          new Date(Date.UTC(2026, 6, 10, 0, 0, 0, sequence)).toISOString()
        );
      }
    })();
  } finally {
    pool.closeAll();
  }
}

function countEvents(dataRoot: string): number {
  const pool = new DatabasePool(join(dataRoot, 'plugin-data'));
  try {
    return pool.getConnection('@roc/plugin-agent').prepare('SELECT COUNT(*) FROM agent_events').pluck().get() as number;
  } finally {
    pool.closeAll();
  }
}
