import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-precompact-it-'));
  services = createAppServices(root);
  services.appService.initialize();
  services.databaseService.db
    .prepare(
      `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('t1', 'chat', 'flush thread', '', 'active', datetime('now'), datetime('now'))`
    )
    .run();
});

afterEach(() => {
  services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('PrecompactionService idempotency', () => {
  it('first at or above 85% triggers, second within 24h does not', () => {
    expect(services.precompactionService.shouldTrigger('t1', 0.86, 172000)).toBe(true);

    services.precompactionService.markFlushed('t1', 0.86, 172000);

    expect(services.precompactionService.shouldTrigger('t1', 0.95, 190000)).toBe(false);
  });

  it('tracks different threads independently', () => {
    services.databaseService.db
      .prepare(
        `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES ('t2', 'chat', 'other thread', '', 'active', datetime('now'), datetime('now'))`
      )
      .run();
    services.precompactionService.markFlushed('t1', 0.86, 172000);

    expect(services.precompactionService.shouldTrigger('t2', 0.86, 172000)).toBe(true);
  });
});

describe('PrecompactionService flush prompt content', () => {
  it('mentions correct memory paths and FLUSH_DONE', () => {
    const prompt = services.precompactionService.buildFlushPrompt({
      ratio: 0.87,
      tokensUsed: 174000,
      contextWindow: 200000
    });

    expect(prompt).toMatch(/\/memory\/global\/USER\.md/);
    expect(prompt).toMatch(/\/memory\/workspaces\/current\/AGENTS\.md/);
    expect(prompt).toMatch(/\/memory\/workspaces\/current\/MEMORY\.md/);
    expect(prompt).toContain('FLUSH_DONE');
    expect(prompt).toContain('user will NOT see');
  });
});
