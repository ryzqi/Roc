import { RocDomainError } from './errors';
import type { MetricsService } from './metrics-service';

export const providerRequestTimeoutMs = 300_000;
const providerRequestRetryBackoffMs = [1_000, 2_000, 4_000] as const;
export const providerRequestTimeoutMessage = 'Provider 流在限定时间内没有返回新数据。若使用长推理模型，这是正常现象，可稍后重试或检查网络连接。';

export class ProviderStreamIdleError extends Error {
  readonly code = 'provider_stream_idle';

  constructor() {
    super('provider_stream_idle');
    this.name = 'ProviderStreamIdleError';
  }
}

export class ProviderStreamTerminatedError extends Error {
  readonly code = 'provider_stream_terminated';

  constructor() {
    super('provider_stream_terminated');
    this.name = 'ProviderStreamTerminatedError';
  }
}

type RetryOptions = {
  labels?: Record<string, string>;
  metricsService?: MetricsService;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
};

export type ProviderRequestFailureClassification =
  | {
      kind: 'abort';
    }
  | {
      kind: 'http';
      status: number;
    }
  | {
      kind: 'network';
    }
  | {
      kind: 'timeout';
    }
  | {
      kind: 'empty_response';
    }
  | {
      kind: 'stream_terminated';
    }
  | {
      kind: 'stream_idle';
    }
  | {
      kind: 'other';
    };

export async function executeWithProviderRequestRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isRetryableProviderRequestFailure;
  const startedAtMs = Date.now();

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    throwIfAborted(options.signal);
    const attempt = String(attemptIndex + 1);
    options.metricsService?.incrementCounter('provider.request.total', {
      ...options.labels,
      attempt
    });

    try {
      const result = await operation();
      options.metricsService?.recordHistogram('provider.request.duration_ms', Date.now() - startedAtMs, {
        ...options.labels,
        attempt
      });
      return result;
    } catch (error) {
      const classification = classifyProviderRequestFailure(error);
      options.metricsService?.incrementCounter('provider.request.errors', {
        ...options.labels,
        attempt,
        kind: classification.kind
      });
      if (attemptIndex >= providerRequestRetryBackoffMs.length || !shouldRetry(error)) {
        throw error;
      }
      await delayWithAbort(providerRequestRetryBackoffMs[attemptIndex], options.signal);
    }
  }
}

function isRetryableProviderRequestFailure(error: unknown): boolean {
  const classification = classifyProviderRequestFailure(error);
  if (classification.kind === 'abort') {
    return false;
  }
  if (classification.kind === 'timeout') {
    return true;
  }
  if (classification.kind === 'network') {
    return true;
  }
  if (classification.kind === 'empty_response') {
    return true;
  }
  if (classification.kind === 'http') {
    return isRetryableProviderHttpStatus(classification.status);
  }
  return false;
}

export function classifyProviderRequestFailure(error: unknown): ProviderRequestFailureClassification {
  if (isAbortError(error)) {
    return { kind: 'abort' };
  }

  if (error instanceof RocDomainError) {
    if (error.code === 'provider_request_timeout') {
      return { kind: 'timeout' };
    }
    if (error.code === 'provider_network_error') {
      return { kind: 'network' };
    }
    if (error.code === 'provider_empty_response') {
      return { kind: 'empty_response' };
    }
    if (error.code === 'provider_http_error') {
      const status = readProviderHttpStatus(error);
      if (status !== null) {
        return {
          kind: 'http',
          status
        };
      }
    }
    return { kind: 'other' };
  }

  if (isRecord(error)) {
    const status = readOptionalHttpStatus(error.status);
    if (status !== null) {
      return {
        kind: 'http',
        status
      };
    }
  }

  if (!(error instanceof Error)) {
    return { kind: 'other' };
  }

  if (isTimeoutError(error)) {
    return { kind: 'timeout' };
  }
  if (isStreamIdleError(error)) {
    return { kind: 'stream_idle' };
  }
  if (isStreamTerminatedError(error)) {
    return { kind: 'stream_terminated' };
  }
  if (isNetworkError(error)) {
    return { kind: 'network' };
  }
  return { kind: 'other' };
}

export function isRetryableProviderHttpStatus(status: number): boolean {
  if (status === 408) {
    return true;
  }
  if (status === 425) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  return false;
}

function readProviderHttpStatus(error: Error): number | null {
  const match = /\bHTTP\s+(\d{3})\b/iu.exec(error.message);
  if (match === null) {
    return null;
  }
  return Number(match[1]);
}

function readOptionalHttpStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof value === 'string' && /^\d{3}$/u.test(value)) {
    return Number(value);
  }
  return null;
}

function isTimeoutError(error: Error): boolean {
  return /timeout|timed out/i.test(error.message);
}

function isNetworkError(error: Error): boolean {
  return (
    /connection error/i.test(error.message) ||
    /fetch failed|network|socket|econn|enotfound|eai_again/i.test(error.message) ||
    isNetworkCause(error.cause)
  );
}

function isStreamIdleError(error: Error): boolean {
  return error.name === 'ProviderStreamIdleError' || Reflect.get(error, 'code') === 'provider_stream_idle';
}

function isStreamTerminatedError(error: Error): boolean {
  return error.name === 'ProviderStreamTerminatedError' || Reflect.get(error, 'code') === 'provider_stream_terminated';
}

function isNetworkCause(cause: unknown): boolean {
  if (!isRecord(cause)) {
    return false;
  }
  const code = cause.code;
  if (typeof code === 'string' && /^(ECONN|ENET|EHOST|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)/iu.test(code)) {
    return true;
  }
  return typeof cause.message === 'string' && /connection error|fetch failed|network|socket|econn|enotfound|eai_again/iu.test(cause.message);
}

function isAbortError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.name === 'AbortError' || error.code === 'ABORT_ERR';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  if (typeof globalThis.DOMException === 'function') {
    return new globalThis.DOMException('The operation was aborted.', 'AbortError');
  }
  const error = new Error('The operation was aborted.') as Error & { code?: string };
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function delayWithAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted === true) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}
