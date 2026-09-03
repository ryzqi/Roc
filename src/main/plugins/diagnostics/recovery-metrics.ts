import type { RetryEvent } from '../../services/deep-agent/retry-telemetry';

export type RecoveryMetrics = {
  period: { start: number; end: number };
  totalRuns: number;
  recoveryAttempts: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  byStrategy: Record<string, {
    attempts: number;
    successes: number;
    avgDelayMs: number;
  }>;
  byFailureCode: Record<string, number>;
  byLayer: Record<string, number>;
};

export class RecoveryMetricsCollector {
  private readonly events: RetryEvent[] = [];
  private readonly outcomes = new Map<string, 'success' | 'failure'>();

  recordRetry(event: RetryEvent): void {
    this.events.push(event);
  }

  recordOutcome(runId: string, outcome: 'success' | 'failure'): void {
    this.outcomes.set(runId, outcome);
  }

  summarize(periodMs: number = 3600_000): RecoveryMetrics {
    const now = Date.now();
    const start = now - periodMs;
    const recentEvents = this.events.filter(e => e.timestamp >= start);

    const byStrategy: Record<string, { attempts: number; successes: number; avgDelayMs: number }> = {};
    const byFailureCode: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const runIds = new Set<string>();

    for (const event of recentEvents) {
      const strategyKey = `${event.layer}/${event.useCheckpointResume ? 'checkpoint' : 'direct'}`;
      if (!byStrategy[strategyKey]) {
        byStrategy[strategyKey] = { attempts: 0, successes: 0, avgDelayMs: 0 };
      }
      byStrategy[strategyKey].attempts++;
      byStrategy[strategyKey].avgDelayMs += event.delayMs;

      byFailureCode[event.errorCode] = (byFailureCode[event.errorCode] ?? 0) + 1;
      byLayer[event.layer] = (byLayer[event.layer] ?? 0) + 1;

      // 从 operation 提取 runId (格式: agent_run)
      runIds.add(event.operation);
    }

    // 计算平均延迟和成功率
    for (const key of Object.keys(byStrategy)) {
      const stats = byStrategy[key];
      stats.avgDelayMs = stats.attempts > 0 ? stats.avgDelayMs / stats.attempts : 0;
    }

    // 统计成功/失败恢复
    let successfulRecoveries = 0;
    let failedRecoveries = 0;
    for (const outcome of this.outcomes.values()) {
      if (outcome === 'success') {
        successfulRecoveries++;
      } else {
        failedRecoveries++;
      }
    }

    return {
      period: { start, end: now },
      totalRuns: runIds.size,
      recoveryAttempts: recentEvents.length,
      successfulRecoveries,
      failedRecoveries,
      byStrategy,
      byFailureCode,
      byLayer
    };
  }

  getEvents(periodMs?: number): readonly RetryEvent[] {
    if (periodMs === undefined) {
      return this.events;
    }
    const cutoff = Date.now() - periodMs;
    return this.events.filter(e => e.timestamp >= cutoff);
  }

  clear(): void {
    this.events.length = 0;
    this.outcomes.clear();
  }
}
