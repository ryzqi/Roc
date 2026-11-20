import type { RunFailure } from '../../services/deep-agent/types';
import { classifyFailure, type StructuredFailure } from '../../services/deep-agent/structured-failure';
import type { RetryTelemetry } from '../../services/deep-agent/retry-telemetry';

const maxRecoveryMs = 10 * 60 * 1000;

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

  if (!structured.retryable || structured.retryStrategy === undefined) {
    return {
      action: 'fail',
      reason: 'non_transient',
      finalFailure: structured
    };
  }

  const strategy = structured.retryStrategy;

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

function calculateBackoffMs(attempt: number, baseMs: number = 500): number {
  const normalizedAttempt = Math.max(0, attempt - 1);
  const exponentialMs = baseMs * Math.pow(2, normalizedAttempt);
  const cappedMs = Math.min(8000, exponentialMs);
  // 添加 20% 随机抖动(学习 Codex)
  const jitter = 0.8 + Math.random() * 0.4; // 0.8 - 1.2
  return Math.floor(cappedMs * jitter);
}
