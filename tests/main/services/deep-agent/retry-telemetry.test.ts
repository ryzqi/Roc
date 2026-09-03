import { describe, it, expect } from 'vitest';
import { RetryTelemetry } from '../../../../src/main/services/deep-agent/retry-telemetry';
import type { StructuredFailure } from '../../../../src/main/services/deep-agent/structured-failure';

describe('RetryTelemetry', () => {
  it('应记录重试事件', () => {
    const telemetry = new RetryTelemetry('test-run-id');
    const failure: StructuredFailure = {
      code: 'provider_http_error',
      message: 'HTTP 429',
      retryable: true,
      category: 'provider',
      telemetryTags: { layer: 'provider', subsystem: 'http' },
      timestamp: Date.now()
    };

    telemetry.record({
      attempt: 1,
      delayMs: 1000,
      failure,
      operation: 'agent_run',
      useCheckpointResume: false
    });

    const events = telemetry.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].attempt).toBe(1);
    expect(events[0].errorCode).toBe('provider_http_error');
    expect(events[0].layer).toBe('provider');
  });

  it('应正确汇总重试统计', () => {
    const telemetry = new RetryTelemetry('test-run-id');
    const failure: StructuredFailure = {
      code: 'provider_network_error',
      message: 'Network failed',
      retryable: true,
      category: 'network',
      telemetryTags: { layer: 'provider', subsystem: 'network' },
      timestamp: Date.now()
    };

    telemetry.record({
      attempt: 1,
      delayMs: 500,
      failure,
      operation: 'agent_run',
      useCheckpointResume: false
    });

    telemetry.record({
      attempt: 2,
      delayMs: 1000,
      failure,
      operation: 'agent_run',
      useCheckpointResume: false
    });

    const summary = telemetry.summarize();
    expect(summary.totalRetries).toBe(2);
    expect(summary.avgDelayMs).toBe(750);
    expect(summary.byLayer.network).toBe(2);
    expect(summary.byErrorCode.provider_network_error).toBe(2);
    expect(summary.checkpointResumes).toBe(0);
  });

  it('应统计 checkpoint 恢复次数', () => {
    const telemetry = new RetryTelemetry('test-run-id');
    const failure: StructuredFailure = {
      code: 'provider_stream_terminated',
      message: 'Stream ended',
      retryable: true,
      category: 'network',
      telemetryTags: { layer: 'provider', subsystem: 'stream' },
      timestamp: Date.now()
    };

    telemetry.record({
      attempt: 1,
      delayMs: 1000,
      failure,
      operation: 'agent_run',
      useCheckpointResume: true
    });

    const summary = telemetry.summarize();
    expect(summary.checkpointResumes).toBe(1);
  });

  it('空遥测应返回零值汇总', () => {
    const telemetry = new RetryTelemetry('test-run-id');
    const summary = telemetry.summarize();

    expect(summary.totalRetries).toBe(0);
    expect(summary.avgDelayMs).toBe(0);
    expect(summary.checkpointResumes).toBe(0);
    expect(Object.keys(summary.byLayer)).toHaveLength(0);
  });
});
