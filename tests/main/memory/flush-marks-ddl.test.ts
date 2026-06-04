import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-flush-marks-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('memory_flush_marks DDL', () => {
  it('creates table with expected columns', () => {
    const db = services.databaseService.db;
    const cols = db.prepare('PRAGMA table_info(memory_flush_marks)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['flushed_at', 'ratio', 'thread_id', 'tokens_used']);
  });

  it('upsert sets flushed_at', () => {
    const db = services.databaseService.db;
    db.prepare(
      `INSERT INTO memory_flush_marks (thread_id, flushed_at, ratio, tokens_used)
       VALUES ('t1', '2026-05-25T00:00:00Z', 0.87, 173000)
       ON CONFLICT(thread_id) DO UPDATE SET flushed_at=excluded.flushed_at, ratio=excluded.ratio, tokens_used=excluded.tokens_used`
    ).run();
    const row = db.prepare("SELECT * FROM memory_flush_marks WHERE thread_id = 't1'").get() as { ratio: number };
    expect(row.ratio).toBe(0.87);
  });
});
