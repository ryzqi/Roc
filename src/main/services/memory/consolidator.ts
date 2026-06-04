import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join } from 'node:path';
import type { AppSettings, MemoryKind } from '../../../shared/types';
import type { LangChainChatModelHandle } from '../langchain-model-factory';
import type { MetricsService } from '../metrics-service';
import { CapacityService } from './capacity';
import { SecurityScanService } from './security-scan';

const backupRetentionMs = 90 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT_TEMPLATE = (targetChars: number) => `You are a memory consolidator. Compress the markdown below by:
1. Merging duplicate or redundant entries
2. Removing entries explicitly superseded by newer ones
3. Keeping every distinct fact, preference, or rule
4. Preserving the original structure (headings, bullet style)

Target: <= ${targetChars} characters total.
Output ONLY the new markdown content. No explanation, no fences, no preface.`;

export type ConsolidatorDeps = {
  memoryDir: string;
  backupDir: string;
  metricsService?: MetricsService;
  resolveCheapModelHandle: (activeHandle: LangChainChatModelHandle) => LangChainChatModelHandle;
  resolveDefaultModelHandle: () => Promise<LangChainChatModelHandle>;
  callLLM: (input: { systemPrompt: string; content: string; activeHandle: LangChainChatModelHandle }) => Promise<string>;
  getSettings: () => Pick<
    AppSettings['memory'],
    | 'charLimits'
    | 'securityScan'
    | 'consolidatorEnabled'
    | 'consolidatorDebounceMinutes'
    | 'consolidatorTargetRatio'
    | 'consolidatorDailyQuota'
  >;
};

export class ConsolidatorService {
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();
  private readonly lastRunAtMs = new Map<string, number>();
  private dailyDate = '';
  private dailyCount = 0;

  constructor(private readonly deps: ConsolidatorDeps) {}

  scheduleForFile(absolutePath: string, kind: MemoryKind, activeHandle?: LangChainChatModelHandle): void {
    const settings = this.deps.getSettings();
    if (!settings.consolidatorEnabled) {
      return;
    }
    if (this.isWithinDebounceWindow(absolutePath, settings.consolidatorDebounceMinutes)) {
      return;
    }
    if (this.scheduled.has(absolutePath)) {
      return;
    }

    const timer = setTimeout(() => {
      this.scheduled.delete(absolutePath);
      void this.runForFile(absolutePath, kind, activeHandle);
    }, 0);
    timer.unref();
    this.scheduled.set(absolutePath, timer);
  }

  async runForFile(absolutePath: string, kind: MemoryKind, activeHandle?: LangChainChatModelHandle): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.consolidatorEnabled) {
      return;
    }
    if (this.inflight.has(absolutePath)) {
      return;
    }
    if (!this.claimDailyQuota(settings.consolidatorDailyQuota)) {
      return;
    }

    this.inflight.add(absolutePath);
    this.lastRunAtMs.set(absolutePath, Date.now());
    const startedAtMs = Date.now();
    try {
      if (!existsSync(absolutePath)) {
        return;
      }
      const capacity = new CapacityService(settings.charLimits);
      const securityScan = new SecurityScanService(settings.securityScan);
      const content = readFileSync(absolutePath, 'utf8');
      mkdirSync(this.deps.backupDir, { recursive: true });
      this.sweepExpiredBackups();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(this.deps.backupDir, `${basename(absolutePath)}.${ts}.md`);
      copyFileSync(absolutePath, backupPath);

      const limit = capacity.check(kind, '').limit;
      const target = Math.floor(limit * settings.consolidatorTargetRatio);
      const baseHandle = activeHandle === undefined ? await this.deps.resolveDefaultModelHandle() : activeHandle;
      const cheapHandle = this.deps.resolveCheapModelHandle(baseHandle);
      const compressed = await this.deps.callLLM({
        systemPrompt: SYSTEM_PROMPT_TEMPLATE(target),
        content,
        activeHandle: cheapHandle
      });

      if (content.trim().length > 0 && compressed.trim().length === 0) {
        console.warn(`[consolidator] LLM output was empty for ${absolutePath}; keeping original.`);
        return;
      }

      const scanIssues = securityScan.scan(compressed);
      if (scanIssues.length > 0) {
        console.warn(`[consolidator] LLM output failed security scan for ${absolutePath}; keeping original.`);
        return;
      }
      const cap = capacity.check(kind, compressed);
      if (!cap.ok) {
        console.warn(`[consolidator] LLM output still over limit for ${absolutePath} (${cap.chars}/${cap.limit}); keeping original.`);
        return;
      }

      writeFileSync(absolutePath, compressed, 'utf8');
      const reductionRatio = content.length === 0 ? 0 : 1 - compressed.length / content.length;
      this.deps.metricsService?.recordHistogram('memory.consolidation.reduction_ratio', reductionRatio, { kind });
      this.deps.metricsService?.recordHistogram('memory.consolidation.duration_ms', Date.now() - startedAtMs, { kind });
      this.deps.metricsService?.incrementCounter('memory.consolidation.success', { kind });
      console.log(`[consolidator] compressed ${absolutePath} -> ${cap.chars}/${cap.limit}; backup at ${backupPath}`);
    } catch (err) {
      this.deps.metricsService?.incrementCounter('memory.consolidation.failed', { kind });
      console.error('[consolidator] failed', err);
    } finally {
      this.inflight.delete(absolutePath);
    }
  }

  setTestModelHooksForTestsOnly(input: {
    resolveDefaultModelHandle?: () => Promise<LangChainChatModelHandle>;
    callLLM?: ConsolidatorDeps['callLLM'];
  }): void {
    if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
      throw new Error('setTestModelHooksForTestsOnly is only available in tests.');
    }
    if (input.resolveDefaultModelHandle !== undefined) {
      this.deps.resolveDefaultModelHandle = input.resolveDefaultModelHandle;
    }
    if (input.callLLM !== undefined) {
      this.deps.callLLM = input.callLLM;
    }
  }

  private claimDailyQuota(dailyQuota: number): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyCount = 0;
    }
    if (this.dailyCount >= dailyQuota) {
      return false;
    }
    this.dailyCount += 1;
    return true;
  }

  private isWithinDebounceWindow(absolutePath: string, debounceMinutes: number): boolean {
    const lastRun = this.lastRunAtMs.get(absolutePath);
    if (lastRun === undefined) {
      return false;
    }
    const debounceMs = debounceMinutes * 60 * 1000;
    return Date.now() - lastRun < debounceMs;
  }

  private sweepExpiredBackups(): void {
    const now = Date.now();
    for (const entry of readdirSync(this.deps.backupDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const absolutePath = join(this.deps.backupDir, entry.name);
      if (now - statSync(absolutePath).mtimeMs <= backupRetentionMs) {
        continue;
      }
      rmSync(absolutePath, { force: true });
    }
  }
}
