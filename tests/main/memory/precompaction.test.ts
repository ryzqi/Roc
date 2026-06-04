import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';
import { PrecompactionService } from '../../../src/main/services/memory/precompaction';

let root: string;
let services: AppServices;
let svc: PrecompactionService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-precompact-'));
  services = createAppServices(root);
  services.appService.initialize();
  svc = new PrecompactionService(services.databaseService, () => ({
    preCompactionFlushEnabled: true,
    preCompactionTokenThreshold: 0.85,
    preCompactionContextWindowTokens: 200000
  }));
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('PrecompactionService.shouldTrigger', () => {
  it('returns false when below threshold', () => {
    expect(svc.shouldTrigger('t1', 0.80, 160000)).toBe(false);
  });

  it('returns true at or above threshold without prior mark', () => {
    expect(svc.shouldTrigger('t1', 0.85, 170000)).toBe(true);
    expect(svc.shouldTrigger('t1', 0.92, 184000)).toBe(true);
  });

  it('returns false within 24h after prior flush', () => {
    svc.markFlushed('t1', 0.85, 170000);
    expect(svc.shouldTrigger('t1', 0.92, 184000)).toBe(false);
  });

  it('returns true after 24h+', () => {
    services.databaseService.db.prepare(
      `INSERT INTO memory_flush_marks (thread_id, flushed_at, ratio, tokens_used)
       VALUES ('t1', datetime('now', '-25 hours'), 0.85, 170000)`
    ).run();
    expect(svc.shouldTrigger('t1', 0.90, 180000)).toBe(true);
  });

  it('honors preCompactionFlushEnabled=false', () => {
    const off = new PrecompactionService(services.databaseService, () => ({
      preCompactionFlushEnabled: false,
      preCompactionTokenThreshold: 0.85,
      preCompactionContextWindowTokens: 200000
    }));
    expect(off.shouldTrigger('t1', 0.95, 190000)).toBe(false);
  });
});

describe('PrecompactionService.contextWindowTokens', () => {
  it('reads explicit settings instead of assuming modelHandle.contextWindow exists', () => {
    expect(svc.contextWindowTokens()).toBe(200000);
  });
});

describe('PrecompactionService.buildFlushPrompt', () => {
  it('contains target paths and FLUSH_DONE sentinel', () => {
    const prompt = svc.buildFlushPrompt({ ratio: 0.87, tokensUsed: 174000, contextWindow: 200000 });
    expect(prompt).toContain('USER.md');
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('MEMORY.md');
    expect(prompt).toContain('FLUSH_DONE');
    expect(prompt).toContain('87%');
  });
});
