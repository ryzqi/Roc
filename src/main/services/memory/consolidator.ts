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
  securityScan: SecurityScanService;
  capacity: CapacityService;
  resolveCheapModelHandle: (activeHandle: LangChainChatModelHandle) => LangChainChatModelHandle;
  resolveDefaultModelHandle: () => Promise<LangChainChatModelHandle>;
  callLLM: (input: { systemPrompt: string; content: string; activeHandle: LangChainChatModelHandle }) => Promise<string>;
  settings: Pick<
    AppSettings['memory'],
    | 'charLimits'
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
    if (!this.deps.settings.consolidatorEnabled) {
      return;
    }
    if (this.isWithinDebounceWindow(absolutePath)) {
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
    if (!this.deps.settings.consolidatorEnabled) {
      return;
    }
    if (this.inflight.has(absolutePath)) {
      return;
    }
    if (!this.claimDailyQuota()) {
      return;
    }

    this.inflight.add(absolutePath);
    this.lastRunAtMs.set(absolutePath, Date.now());
    try {
      if (!existsSync(absolutePath)) {
        return;
      }
      const content = readFileSync(absolutePath, 'utf8');
      mkdirSync(this.deps.backupDir, { recursive: true });
      this.sweepExpiredBackups();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(this.deps.backupDir, `${basename(absolutePath)}.${ts}.md`);
      copyFileSync(absolutePath, backupPath);

      const limit = this.deps.capacity.check(kind, '').limit;
      const target = Math.floor(limit * this.deps.settings.consolidatorTargetRatio);
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

      const scanIssues = this.deps.securityScan.scan(compressed);
      if (scanIssues.length > 0) {
        console.warn(`[consolidator] LLM output failed security scan for ${absolutePath}; keeping original.`);
        return;
      }
      const cap = this.deps.capacity.check(kind, compressed);
      if (!cap.ok) {
        console.warn(`[consolidator] LLM output still over limit for ${absolutePath} (${cap.chars}/${cap.limit}); keeping original.`);
        return;
      }

      writeFileSync(absolutePath, compressed, 'utf8');
      console.log(`[consolidator] compressed ${absolutePath} -> ${cap.chars}/${cap.limit}; backup at ${backupPath}`);
    } catch (err) {
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

  private claimDailyQuota(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyCount = 0;
    }
    if (this.dailyCount >= this.deps.settings.consolidatorDailyQuota) {
      return false;
    }
    this.dailyCount += 1;
    return true;
  }

  private isWithinDebounceWindow(absolutePath: string): boolean {
    const lastRun = this.lastRunAtMs.get(absolutePath);
    if (lastRun === undefined) {
      return false;
    }
    const debounceMs = this.deps.settings.consolidatorDebounceMinutes * 60 * 1000;
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
