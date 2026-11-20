import pRetry from 'p-retry';
import { RocDomainError } from './errors';
import type { MetricsService } from './metrics-service';

// 增加到 10 分钟以支持长推理模型（如 DeepSeek extended thinking）
export const providerRequestTimeoutMs = 600_000;
export const providerRequestTimeoutMessage = 'Provider 流在限定时间内没有返回新数据。这通常发生在模型进行长时间推理时（如复杂任务的思考阶段）。建议：1) 重试任务 2) 简化提示词 3) 分解为多个小任务。';

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

// A plain Error wrapper lets Roc apply its retry policy to TypeErrors and non-Error rejections.
class ProviderAttemptError extends Error {}

export async function executeWithProviderRequestRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isRetryableProviderRequestFailure;
  const startedAtMs = Date.now();
  let successfulAttempt = 0;

  try {
    const result = await pRetry(
      async (attemptNumber) => {
        successfulAttempt = attemptNumber;
        options.metricsService?.incrementCounter('provider.request.total', {
          ...options.labels,
          attempt: String(attemptNumber)
        });

        try {
          return await operation();
        } catch (error) {
          throw new ProviderAttemptError('Provider request failed.', { cause: error });
        }
      },
      {
        retries: 3,
        factor: 2,
        minTimeout: 1_000,
        maxTimeout: 4_000,
        randomize: false,
        signal: options.signal,
        onFailedAttempt: ({ error, attemptNumber }) => {
          const classification = classifyProviderRequestFailure(error.cause);
          options.metricsService?.incrementCounter('provider.request.errors', {
            ...options.labels,
            attempt: String(attemptNumber),
            kind: classification.kind
          });
        },
        shouldRetry: ({ error }) => shouldRetry(error.cause)
      }
    );

    options.metricsService?.recordHistogram('provider.request.duration_ms', Date.now() - startedAtMs, {
      ...options.labels,
      attempt: String(successfulAttempt)
    });
    return result;
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    throw error instanceof ProviderAttemptError ? error.cause : error;
  }
}

function isRetryableProviderRequestFailure(error: unknown): boolean {
  const classification = classifyProviderRequestFailure(error);
  if (classification.kind === 'http') {
    return isRetryableProviderHttpStatus(classification.status);
  }
  return classification.kind === 'timeout' || classification.kind === 'network' || classification.kind === 'empty_response';
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
  return status === 408 || status === 425 || status === 429 || status >= 500;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
