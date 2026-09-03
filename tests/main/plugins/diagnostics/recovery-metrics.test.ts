import { describe, it, expect, beforeEach } from 'vitest';
import { RecoveryMetricsCollector } from '../../../../src/main/plugins/diagnostics/recovery-metrics';
import type { RetryEvent } from '../../../../src/main/services/deep-agent/retry-telemetry';

describe('RecoveryMetricsCollector', () => {
  let collector: RecoveryMetricsCollector;

  beforeEach(() => {
    collector = new RecoveryMetricsCollector();
  });

  it('应正确记录重试事件', () => {
    const event: RetryEvent = {
      attempt: 1,
      delayMs: 1000,
      layer: 'provider',
      operation: 'run-1',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: Date.now()
    };

    collector.recordRetry(event);
    expect(collector.getEvents()).toHaveLength(1);
    expect(collector.getEvents()[0]).toEqual(event);
  });

  it('应正确汇总重试统计', () => {
    const now = Date.now();

    collector.recordRetry({
      attempt: 1,
      delayMs: 500,
      layer: 'provider',
      operation: 'run-1',
      errorCode: 'provider_network_error',
      category: 'network',
      useCheckpointResume: false,
      timestamp: now
    });

    collector.recordRetry({
      attempt: 2,
      delayMs: 1000,
      layer: 'network',
      operation: 'run-1',
      errorCode: 'provider_stream_terminated',
      category: 'network',
      useCheckpointResume: true,
      timestamp: now
    });

    const summary = collector.summarize(3600_000);

    expect(summary.totalRuns).toBe(1);
    expect(summary.recoveryAttempts).toBe(2);
    expect(summary.byLayer.provider).toBe(1);
    expect(summary.byLayer.network).toBe(1);
    expect(summary.byFailureCode.provider_network_error).toBe(1);
    expect(summary.byFailureCode.provider_stream_terminated).toBe(1);
  });

  it('应正确统计按策略分组', () => {
    const now = Date.now();

    collector.recordRetry({
      attempt: 1,
      delayMs: 1000,
      layer: 'provider',
      operation: 'run-1',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: now
    });

    collector.recordRetry({
      attempt: 2,
      delayMs: 2000,
      layer: 'provider',
      operation: 'run-1',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: now
    });

    collector.recordRetry({
      attempt: 1,
      delayMs: 1000,
      layer: 'network',
      operation: 'run-2',
      errorCode: 'provider_stream_terminated',
      category: 'network',
      useCheckpointResume: true,
      timestamp: now
    });

    const summary = collector.summarize(3600_000);

    expect(summary.byStrategy['provider/direct']).toBeDefined();
    expect(summary.byStrategy['provider/direct'].attempts).toBe(2);
    expect(summary.byStrategy['provider/direct'].avgDelayMs).toBe(1500);

    expect(summary.byStrategy['network/checkpoint']).toBeDefined();
    expect(summary.byStrategy['network/checkpoint'].attempts).toBe(1);
    expect(summary.byStrategy['network/checkpoint'].avgDelayMs).toBe(1000);
  });

  it('应正确记录恢复结果', () => {
    collector.recordOutcome('run-1', 'success');
    collector.recordOutcome('run-2', 'failure');

    const summary = collector.summarize(3600_000);

    expect(summary.successfulRecoveries).toBe(1);
    expect(summary.failedRecoveries).toBe(1);
  });

  it('应过滤超出时间窗口的事件', () => {
    const now = Date.now();
    const oldTimestamp = now - 7200_000; // 2 小时前

    collector.recordRetry({
      attempt: 1,
      delayMs: 1000,
      layer: 'provider',
      operation: 'run-old',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: oldTimestamp
    });

    collector.recordRetry({
      attempt: 1,
      delayMs: 1000,
      layer: 'provider',
      operation: 'run-new',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: now
    });

    const summary = collector.summarize(3600_000); // 1 小时窗口

    expect(summary.recoveryAttempts).toBe(1); // 只统计最近 1 小时内的
    expect(collector.getEvents()).toHaveLength(2); // 但所有事件都保留
  });

  it('clear 应清空所有数据', () => {
    collector.recordRetry({
      attempt: 1,
      delayMs: 1000,
      layer: 'provider',
      operation: 'run-1',
      errorCode: 'provider_http_error',
      category: 'provider',
      useCheckpointResume: false,
      timestamp: Date.now()
    });
    collector.recordOutcome('run-1', 'success');

    collector.clear();

    expect(collector.getEvents()).toHaveLength(0);
    const summary = collector.summarize();
    expect(summary.recoveryAttempts).toBe(0);
    expect(summary.successfulRecoveries).toBe(0);
  });
});
