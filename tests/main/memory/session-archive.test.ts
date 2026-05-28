import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';
import { SessionArchiveService } from '../../../src/main/services/memory/session-archive';

let root: string;
let services: AppServices;
let archive: SessionArchiveService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-archive-'));
  services = createAppServices(root);
  services.appService.initialize();
  archive = new SessionArchiveService(services.databaseService);
  services.databaseService.db
    .prepare(
      `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('t1', 'chat', 'thread one', '', 'active', datetime('now'), datetime('now'))`
    )
    .run();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('SessionArchiveService.record*', () => {
  it('records user input', () => {
    archive.recordUserInput('t1', '帮我修一下启动崩溃');
    const rows = services.databaseService.db
      .prepare("SELECT role, content FROM session_messages WHERE thread_id='t1'")
      .all();
    expect(rows).toEqual([{ role: 'user', content: '帮我修一下启动崩溃' }]);
  });

  it('records assistant + tool + system in time order', () => {
    archive.recordUserInput('t1', 'hi');
    archive.recordAssistantMessage('t1', 'hello back', 12);
    archive.recordToolCall('t1', 'read', { path: '/x' }, { content: 'y' });
    archive.recordSystemMessage('t1', 'memory_edit: /memory/global/USER.md chars=42');
    const rows = services.databaseService.db
      .prepare("SELECT role, content FROM session_messages WHERE thread_id='t1' ORDER BY created_at, id")
      .all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool', 'system']);
    expect(rows[2].content).toContain('"path":"/x"');
  });

  it('records pre-compaction flush phase when requested', () => {
    archive.recordAssistantMessage('t1', 'FLUSH_DONE', 2, 'pre_compaction_flush');
    const row = services.databaseService.db
      .prepare("SELECT role, content, phase FROM session_messages WHERE thread_id='t1'")
      .get() as { role: string; content: string; phase: string };
    expect(row).toEqual({ role: 'assistant', content: 'FLUSH_DONE', phase: 'pre_compaction_flush' });
  });
});

describe('SessionArchiveService.search', () => {
  beforeEach(() => {
    services.databaseService.db
      .prepare(
        `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES ('t2', 'chat', 'thread two', '', 'active', datetime('now'), datetime('now'))`
      )
      .run();
    archive.recordUserInput('t1', '我在调试 electron 启动崩溃');
    archive.recordAssistantMessage('t1', '看起来是 ndarray 原生模块的问题', 10);
    archive.recordUserInput('t2', '另一个对话讨论 settings');
  });

  it('returns matches with snippet markup', () => {
    const r = archive.search({ query: 'electron', workspaceScope: 'all', limit: 10 });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.some((it) => it.snippet.includes('**electron**') || it.snippet.toLowerCase().includes('electron'))).toBe(
      true
    );
  });

  it('filters by threadId', () => {
    const r = archive.search({ query: 'electron', workspaceScope: 'all', threadId: 't2', limit: 10 });
    expect(r.total).toBe(0);
  });

  it('AND multi-keyword via FTS5', () => {
    const r = archive.search({ query: 'electron 启动', workspaceScope: 'all', limit: 10 });
    expect(r.total).toBeGreaterThan(0);
  });
});

describe('SessionArchiveService.sweepRetention', () => {
  it('deletes rows older than retentionDays', () => {
    const db = services.databaseService.db;
    db.prepare(
      `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
       VALUES ('old1', 't1', 'user', 'old message', NULL, 'visible', datetime('now', '-120 days'))`
    ).run();
    archive.recordUserInput('t1', 'recent');
    const before = db.prepare('SELECT COUNT(*) AS n FROM session_messages').get() as { n: number };
    expect(before.n).toBe(2);

    const result = archive.sweepRetention(90);
    expect(result.deletedRows).toBe(1);
    const after = db.prepare('SELECT COUNT(*) AS n FROM session_messages').get() as { n: number };
    expect(after.n).toBe(1);
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM session_messages_fts').get() as { n: number };
    expect(ftsCount.n).toBe(1);
  });
});
