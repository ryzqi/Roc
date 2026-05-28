import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';
import { createSessionSearchTool } from '../../../src/main/services/deep-agent/tools/session-search-tool';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-session-search-tool-'));
  services = createAppServices(root);
  services.appService.initialize();
  services.databaseService.db
    .prepare(
      `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('t1', 'chat', '过去对话', '', 'active', datetime('now', '-2 days'), datetime('now', '-2 days'))`
    )
    .run();
  services.sessionArchiveService.recordUserInput('t1', '上次我说 electron 启动崩溃了');
  services.sessionArchiveService.recordAssistantMessage('t1', '建议检查 ndarray 原生模块', 10);
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('session_search tool', () => {
  it('returns markdown with hits', async () => {
    const tool = createSessionSearchTool(services.sessionArchiveService);
    const out = await tool.invoke({ query: 'electron', workspaceScope: 'all', limit: 10 });
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    expect(text).toMatch(/electron/i);
    expect(text).toContain('过去对话');
  });

  it('returns "no matches" markdown when empty', async () => {
    const tool = createSessionSearchTool(services.sessionArchiveService);
    const out = await tool.invoke({ query: 'noSuchKeyword_xyz', workspaceScope: 'all', limit: 10 });
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    expect(text).toMatch(/no matches|未找到/i);
  });
});
