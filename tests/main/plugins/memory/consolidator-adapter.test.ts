import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryConsolidatorAdapter } from '../../../../src/main/plugins/memory/consolidator-adapter';
import { MemoryRepository } from '../../../../src/main/plugins/memory/memory-repository';
import { applyMemoryPluginSchema } from '../../../../src/main/plugins/memory/schema';

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-memory-consolidator-test-'));
  db = new Database(':memory:');
  applyMemoryPluginSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MemoryConsolidatorAdapter', () => {
  it('records agent run completion events for memory snapshot previews', () => {
    const repository = new MemoryRepository({
      db,
      memoryRoot: join(root, 'memory')
    });
    const adapter = new MemoryConsolidatorAdapter(repository);

    adapter.handleAgentRunCompleted({
      assistantMessage: 'Use the plugin repository for session writes.',
      runId: 'run_1',
      summary: 'Agent migrated session handling.',
      threadId: 'thread_1'
    });

    expect(repository.buildSnapshotPreview().text).toContain('Agent migrated session handling.');
  });

  it('records session archive events without requiring deferred extraction', () => {
    const repository = new MemoryRepository({
      db,
      memoryRoot: join(root, 'memory')
    });
    const adapter = new MemoryConsolidatorAdapter(repository);

    adapter.handleAgentSessionArchived({
      reason: 'manual_cleanup',
      threadId: 'thread_2'
    });

    expect(repository.buildSnapshotPreview().text).toContain('manual_cleanup');
  });
});
