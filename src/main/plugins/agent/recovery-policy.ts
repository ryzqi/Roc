import type { RunFailure } from '../../services/deep-agent/types';
import { classifyFailure, type StructuredFailure } from '../../services/deep-agent/structured-failure';
import type { RetryTelemetry } from '../../services/deep-agent/retry-telemetry';

const maxRecoveryMs = 10 * 60 * 1000;
const recoverableHttpStatuses = new Set([408, 425, 429]);

export type RecoveryDecision =
  | {
      action: 'recover';
      attempt: number;
      delayMs: number;
      resumeFromCheckpoint: boolean;
      strategy: string;
    }
  | {
      action: 'fail';
      reason: 'non_transient' | 'attempts_exhausted' | 'time_exhausted';
      finalFailure: StructuredFailure;
    };

export function toRecoveryDecision(input: {
  failure: RunFailure;
  attempt: number;
  firstFailureAtMs: number;
  nowMs: number;
  telemetry?: RetryTelemetry;
}): RecoveryDecision {
  const structured = classifyFailure(input.failure);

  if (!structured.retryable || !structured.retryStrategy) {
    // 回退到旧逻辑检查
    if (!isRecoverableFailure(input.failure)) {
      return {
        action: 'fail',
        reason: 'non_transient',
        finalFailure: structured
      };
    }
  }

  const strategy = structured.retryStrategy ?? {
    maxAttempts: isCheckpointRecoveryFailure(input.failure) ? 3 : 5,
    baseDelayMs: 500,
    conditions: new Set([]),
    useCheckpointResume: isCheckpointRecoveryFailure(input.failure)
  };

  if (input.attempt > strategy.maxAttempts) {
    return {
      action: 'fail',
      reason: 'attempts_exhausted',
      finalFailure: structured
    };
  }

  if (input.nowMs - input.firstFailureAtMs > maxRecoveryMs) {
    return {
      action: 'fail',
      reason: 'time_exhausted',
      finalFailure: structured
    };
  }

  const delayMs = calculateBackoffMs(input.attempt, strategy.baseDelayMs);

  // 记录遥测
  if (input.telemetry) {
    input.telemetry.record({
      attempt: input.attempt,
      delayMs,
      failure: structured,
      operation: 'agent_run',
      useCheckpointResume: strategy.useCheckpointResume
    });
  }

  return {
    action: 'recover',
    attempt: input.attempt,
    delayMs,
    resumeFromCheckpoint: strategy.useCheckpointResume,
    strategy: `${strategy.maxAttempts}次/${strategy.baseDelayMs}ms基础延迟`
  };
}

export function isRecoverableFailure(failure: RunFailure): boolean {
  if (!failure.retryable) {
    return false;
  }
  if (failure.code === 'provider_network_error') {
    return true;
  }
  if (failure.code === 'provider_request_timeout') {
    return true;
  }
  if (isCheckpointRecoveryFailure(failure)) {
    return true;
  }
  if (failure.code !== 'provider_http_error') {
    return false;
  }
  const status = readHttpStatus(failure.message);
  if (status === null) {
    return false;
  }
  if (recoverableHttpStatuses.has(status)) {
    return true;
  }
  return status >= 500;
}

function isCheckpointRecoveryFailure(failure: RunFailure): boolean {
  return failure.code === 'provider_stream_terminated' || failure.code === 'provider_stream_idle';
}

function calculateBackoffMs(attempt: number, baseMs: number = 500): number {
  const normalizedAttempt = Math.max(0, attempt - 1);
  const exponentialMs = baseMs * Math.pow(2, normalizedAttempt);
  const cappedMs = Math.min(8000, exponentialMs);
  // 添加 20% 随机抖动(学习 Codex)
  const jitter = 0.8 + Math.random() * 0.4; // 0.8 - 1.2
  return Math.floor(cappedMs * jitter);
}

function readHttpStatus(message: string): number | null {
  const match = /\bHTTP\s+(\d{3})\b/u.exec(message);
  if (match === null) {
    return null;
  }
  return Number(match[1]);
}
