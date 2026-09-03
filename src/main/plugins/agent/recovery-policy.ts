import type { RunFailure } from '../../services/deep-agent/types';

const maxAttempts = 5;
const maxRecoveryMs = 10 * 60 * 1000;
const recoverableHttpStatuses = new Set([408, 425, 429]);

export type RecoveryDecision =
  | { action: 'recover'; attempt: number; delayMs: number; resumeFromCheckpoint: boolean }
  | { action: 'fail'; reason: 'non_transient' | 'attempts_exhausted' | 'time_exhausted' };

export function toRecoveryDecision(input: {
  failure: RunFailure;
  attempt: number;
  firstFailureAtMs: number;
  nowMs: number;
}): RecoveryDecision {
  if (!isRecoverableFailure(input.failure)) {
    return { action: 'fail', reason: 'non_transient' };
  }
  const allowedAttempts = isCheckpointRecoveryFailure(input.failure) ? 3 : maxAttempts;
  if (input.attempt > allowedAttempts) {
    return { action: 'fail', reason: 'attempts_exhausted' };
  }
  if (input.nowMs - input.firstFailureAtMs > maxRecoveryMs) {
    return { action: 'fail', reason: 'time_exhausted' };
  }
  return {
    action: 'recover',
    attempt: input.attempt,
    delayMs: calculateBackoffMs(input.attempt),
    resumeFromCheckpoint: isCheckpointRecoveryFailure(input.failure)
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

function calculateBackoffMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, attempt - 1);
  const baseMs = 500;
  const exponentialMs = baseMs * Math.pow(2, normalizedAttempt);
  const cappedMs = Math.min(8000, exponentialMs);
  return cappedMs + Math.floor(cappedMs * 0.2);
}

function readHttpStatus(message: string): number | null {
  const match = /\bHTTP\s+(\d{3})\b/u.exec(message);
  if (match === null) {
    return null;
  }
  return Number(match[1]);
}
