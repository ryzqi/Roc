import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-archive-ddl-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('session_messages DDL', () => {
  it('creates session_messages, FTS5 virtual table, and 3 triggers', () => {
    const db = services.databaseService.db;
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_messages'").get();
    expect(table).toBeDefined();
    const cols = db.prepare('PRAGMA table_info(session_messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual([
      'content',
      'created_at',
      'id',
      'phase',
      'role',
      'thread_id',
      'token_count'
    ]);
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_messages_fts'").get();
    expect(fts).toBeDefined();
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'session_messages_%'")
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name).sort();
    expect(names).toEqual(['session_messages_ad', 'session_messages_ai', 'session_messages_au']);
  });

  it('FTS5 triggers sync on insert', () => {
    const db = services.databaseService.db;
    db.prepare(
      `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
       VALUES ('m1', 't1', 'user', 'hello world FTS5', 5, 'visible', '2026-05-25T00:00:00Z')`
    ).run();
    const rows = db.prepare("SELECT rowid FROM session_messages_fts WHERE session_messages_fts MATCH 'world'").all();
    expect(rows.length).toBe(1);
  });
});
