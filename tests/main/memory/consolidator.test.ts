import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsolidatorService, type ConsolidatorDeps } from '../../../src/main/services/memory/consolidator';
import type { LangChainChatModelHandle } from '../../../src/main/services/langchain-model-factory';
import type { LogService } from '../../../src/main/services/log-service';
import { MetricsService } from '../../../src/main/services/metrics-service';

const limits = { user: 1375, agents: 800, memory: 2200 };
const allOn = { promptInjection: true, credential: true, sshBackdoor: true, invisibleUnicode: true };

let root: string;
let memoryDir: string;
let backupDir: string;
const activeHandle = {
  model: { invoke: vi.fn() },
  modelId: 'active-model',
  provider: { id: 'test-provider', type: 'openai_compatible' },
  runtime: { providerType: 'openai_compatible', baseUrl: 'http://localhost', streaming: false, modelKwargs: {} }
} as unknown as LangChainChatModelHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-consolidator-'));
  memoryDir = join(root, 'memory');
  backupDir = join(memoryDir, '.consolidator-backup');
  mkdirSync(join(memoryDir, 'global'), { recursive: true });
  mkdirSync(backupDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeService(
  mockLLM: (input: { systemPrompt: string; content: string; activeHandle: LangChainChatModelHandle }) => Promise<string>,
  settings: Partial<{
    consolidatorEnabled: boolean;
    consolidatorDebounceMinutes: number;
    consolidatorTargetRatio: number;
    consolidatorDailyQuota: number;
  }> = {},
  metricsService?: MetricsService,
  logService?: Pick<LogService, 'info' | 'warn' | 'error'>
) {
  const deps: ConsolidatorDeps = {
    memoryDir,
    backupDir,
    resolveCheapModelHandle: (handle) => handle,
    resolveDefaultModelHandle: async () => activeHandle,
    callLLM: mockLLM,
    getSettings: () => ({
      charLimits: limits,
      securityScan: allOn,
      consolidatorEnabled: true,
      consolidatorDebounceMinutes: 10,
      consolidatorTargetRatio: 0.85,
      consolidatorDailyQuota: 50,
      ...settings
    })
  };
  if (metricsService !== undefined) {
    Object.assign(deps, { metricsService });
  }
  if (logService !== undefined) {
    Object.assign(deps, { logService });
  }
  return new ConsolidatorService(deps);
}

function createLogServiceMock(): Pick<LogService, 'info' | 'warn' | 'error'> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Pick<LogService, 'info' | 'warn' | 'error'>;
}

describe('ConsolidatorService', () => {
  it('writes compressed content back when LLM result passes security+capacity', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'x'.repeat(2300));
    const metricsService = new MetricsService();
    const logService = createLogServiceMock();
    const svc = makeService(async ({ activeHandle: handle }) => {
      expect(handle).toBe(activeHandle);
      return 'compressed result line 1\ncompressed line 2';
    }, {}, metricsService, logService);
    await svc.runForFile(file, 'memory', activeHandle);
    expect(readFileSync(file, 'utf8')).toContain('compressed result');
    expect(readdirSync(backupDir).some((f) => f.startsWith('MEMORY.md.') && f.endsWith('.md'))).toBe(true);
    expect(metricsService.query({ name: 'memory.consolidation.success', labels: { kind: 'memory' } })).toHaveLength(1);
    expect(metricsService.query({ name: 'memory.consolidation.duration_ms', labels: { kind: 'memory' } })).toHaveLength(1);
    const reductionMetrics = metricsService.query({ name: 'memory.consolidation.reduction_ratio', labels: { kind: 'memory' } });
    expect(reductionMetrics).toHaveLength(1);
    expect(reductionMetrics[0]!.value).toBeGreaterThan(0.9);
    expect(logService.info).toHaveBeenCalledWith('Memory consolidation completed.', {
      service: 'memory-consolidator',
      component: 'runForFile',
      metadata: expect.objectContaining({
        absolutePath: file,
        kind: 'memory'
      })
    });
  });

  it('records failed metrics when consolidation throws', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'original content');
    const metricsService = new MetricsService();
    const logService = createLogServiceMock();
    const svc = makeService(async () => {
      throw new Error('LLM failed');
    }, {}, metricsService, logService);

    await svc.runForFile(file, 'memory', activeHandle);

    expect(readFileSync(file, 'utf8')).toBe('original content');
    expect(metricsService.query({ name: 'memory.consolidation.failed', labels: { kind: 'memory' } })).toHaveLength(1);
    expect(metricsService.query({ name: 'memory.consolidation.success', labels: { kind: 'memory' } })).toHaveLength(0);
    expect(logService.error).toHaveBeenCalledWith(
      'Memory consolidation failed.',
      expect.any(Error),
      {
        service: 'memory-consolidator',
        component: 'runForFile',
        metadata: {
          absolutePath: file,
          kind: 'memory'
        }
      }
    );
  });

  it('does NOT overwrite when LLM result fails security scan', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'original content');
    const svc = makeService(async () => 'AKIAIOSFODNN7EXAMPLE leaked');
    await svc.runForFile(file, 'memory', activeHandle);
    expect(readFileSync(file, 'utf8')).toBe('original content');
  });

  it('does NOT overwrite when LLM result still over limit', async () => {
    const file = join(memoryDir, 'global', 'USER.md');
    writeFileSync(file, 'x'.repeat(1500));
    const svc = makeService(async () => 'y'.repeat(1500));
    await svc.runForFile(file, 'user', activeHandle);
    expect(readFileSync(file, 'utf8')).toBe('x'.repeat(1500));
  });

  it('does NOT overwrite non-empty memory with an empty LLM result', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'x'.repeat(2300));
    const svc = makeService(async () => '');
    await svc.runForFile(file, 'memory', activeHandle);
    expect(readFileSync(file, 'utf8')).toBe('x'.repeat(2300));
  });

  it('debounces same path within window', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'x'.repeat(2300));
    const llm = vi.fn().mockResolvedValue('short');
    const svc = makeService(llm);
    svc.scheduleForFile(file, 'memory', activeHandle);
    svc.scheduleForFile(file, 'memory', activeHandle);
    svc.scheduleForFile(file, 'memory', activeHandle);
    await new Promise((r) => setTimeout(r, 100));
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('respects daily quota', async () => {
    const file1 = join(memoryDir, 'global', 'MEMORY.md');
    const file2 = join(memoryDir, 'global', 'USER.md');
    writeFileSync(file1, 'x'.repeat(2300));
    writeFileSync(file2, 'y'.repeat(1500));
    const llm = vi.fn().mockResolvedValue('short');
    const svc = makeService(llm, { consolidatorDailyQuota: 1 });
    await svc.runForFile(file1, 'memory', activeHandle);
    await svc.runForFile(file2, 'user', activeHandle);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('respects consolidatorEnabled=false', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    writeFileSync(file, 'x'.repeat(2300));
    const llm = vi.fn().mockResolvedValue('short');
    const svc = makeService(llm, { consolidatorEnabled: false });
    await svc.runForFile(file, 'memory', activeHandle);
    expect(llm).not.toHaveBeenCalled();
  });

  it('removes backup files older than ninety days during a consolidation run', async () => {
    const file = join(memoryDir, 'global', 'MEMORY.md');
    const oldBackup = join(backupDir, 'MEMORY.md.old.md');
    const recentBackup = join(backupDir, 'MEMORY.md.recent.md');
    writeFileSync(file, 'x'.repeat(2300));
    writeFileSync(oldBackup, 'old backup');
    writeFileSync(recentBackup, 'recent backup');
    const now = Date.now();
    const old = new Date(now - 91 * 24 * 60 * 60 * 1000);
    const recent = new Date(now - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldBackup, old, old);
    utimesSync(recentBackup, recent, recent);
    const svc = makeService(async () => 'short');

    await svc.runForFile(file, 'memory', activeHandle);

    const backups = readdirSync(backupDir);
    expect(backups).not.toContain('MEMORY.md.old.md');
    expect(backups).toContain('MEMORY.md.recent.md');
  });
});
