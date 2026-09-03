import { describe, expect, it } from 'vitest';

import { toRecoveryDecision } from '../../../../src/main/plugins/agent/recovery-policy';

describe('toRecoveryDecision', () => {
  it('recovers provider network errors inside the attempt and wall-clock budget', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_network_error', message: 'Connection error.', retryable: true },
        attempt: 1,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toMatchObject({ action: 'recover', attempt: 1, resumeFromCheckpoint: false });
  });

  it('recovers a terminated model stream up to 3 times from checkpoint', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_stream_terminated', message: 'terminated', retryable: true },
        attempt: 1,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toMatchObject({ action: 'recover', attempt: 1, resumeFromCheckpoint: true });
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_stream_terminated', message: 'terminated', retryable: true },
        attempt: 2,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toMatchObject({ action: 'recover', attempt: 2, resumeFromCheckpoint: true });
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_stream_terminated', message: 'terminated', retryable: true },
        attempt: 3,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toMatchObject({ action: 'recover', attempt: 3, resumeFromCheckpoint: true });
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_stream_terminated', message: 'terminated', retryable: true },
        attempt: 4,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toEqual({ action: 'fail', reason: 'attempts_exhausted' });
  });

  it('recovers retryable provider HTTP 5xx errors', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_http_error', message: 'Provider 返回 HTTP 502。', retryable: true },
        attempt: 2,
        firstFailureAtMs: 1000,
        nowMs: 1500
      })
    ).toMatchObject({ action: 'recover', attempt: 2 });
  });

  it('does not recover schema errors even when retryable is true', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'tool_input_schema_invalid', message: 'bad schema', retryable: true },
        attempt: 1,
        firstFailureAtMs: 1000,
        nowMs: 1100
      })
    ).toEqual({ action: 'fail', reason: 'non_transient' });
  });

  it('exhausts after five attempts', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_request_timeout', message: 'timeout', retryable: true },
        attempt: 6,
        firstFailureAtMs: 1000,
        nowMs: 2000
      })
    ).toEqual({ action: 'fail', reason: 'attempts_exhausted' });
  });

  it('exhausts after ten minutes', () => {
    expect(
      toRecoveryDecision({
        failure: { code: 'provider_network_error', message: 'Connection error.', retryable: true },
        attempt: 2,
        firstFailureAtMs: 1000,
        nowMs: 601001
      })
    ).toEqual({ action: 'fail', reason: 'time_exhausted' });
  });
});
