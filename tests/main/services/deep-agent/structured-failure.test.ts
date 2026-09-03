import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../../../src/main/services/deep-agent/structured-failure';
import { toRunFailure } from '../../../../src/main/services/deep-agent/error-mapping';
import { RocDomainError } from '../../../../src/main/services/errors';

describe('classifyFailure', () => {
  it('应分类 provider HTTP 错误并附带重试策略', () => {
    const error = new RocDomainError({
      code: 'provider_http_error',
      message: 'Provider 返回 HTTP 429。',
      category: 'external',
      retryable: true
    });
    const classified = classifyFailure(error);

    expect(classified.category).toBe('provider');
    expect(classified.retryStrategy).toBeDefined();
    expect(classified.retryStrategy?.maxAttempts).toBe(3);
    expect(classified.retryStrategy?.conditions.has('http_429')).toBe(true);
    expect(classified.diagnostic?.httpStatus).toBe(429);
  });

  it('应分类 5xx 错误为可重试', () => {
    const error = new RocDomainError({
      code: 'provider_http_error',
      message: 'Provider 返回 HTTP 503。',
      category: 'external',
      retryable: true
    });
    const classified = classifyFailure(error);

    expect(classified.category).toBe('provider');
    expect(classified.retryStrategy?.maxAttempts).toBe(5);
    expect(classified.retryStrategy?.conditions.has('http_5xx')).toBe(true);
    expect(classified.diagnostic?.httpStatus).toBe(503);
  });

  it('应分类 stream 中断为 checkpoint 恢复', () => {
    const error = new RocDomainError({
      code: 'provider_stream_terminated',
      message: 'Stream ended',
      category: 'external',
      retryable: true
    });
    const classified = classifyFailure(error);

    expect(classified.category).toBe('network');
    expect(classified.retryStrategy?.useCheckpointResume).toBe(true);
    expect(classified.retryStrategy?.conditions.has('stream_interrupted')).toBe(true);
  });

  it('应分类工具 schema 错误', () => {
    const error = new Error('Error invoking tool "test_tool": did not match expected schema');
    const classified = classifyFailure(error);

    expect(classified.category).toBe('user');
    expect(classified.telemetryTags.layer).toBe('tool');
    expect(classified.telemetryTags.subsystem).toBe('validation');
  });

  it('应分类网络错误', () => {
    const error = new RocDomainError({
      code: 'provider_network_error',
      message: 'Network failed',
      category: 'external',
      retryable: true
    });
    const classified = classifyFailure(error);

    expect(classified.category).toBe('network');
    expect(classified.retryStrategy?.maxAttempts).toBe(5);
    expect(classified.retryStrategy?.conditions.has('network')).toBe(true);
  });

  it('应分类系统内部错误', () => {
    const error = new Error('context_budget_exhausted');
    const classified = classifyFailure(error);

    expect(classified.category).toBe('system');
    expect(classified.telemetryTags.subsystem).toBe('context');
  });

  it('应为未知错误提供默认分类', () => {
    const error = new Error('Something went wrong');
    const classified = classifyFailure(error);

    expect(classified.category).toBe('system');
    expect(classified.telemetryTags.layer).toBe('unknown');
    expect(classified.timestamp).toBeGreaterThan(0);
  });
});
