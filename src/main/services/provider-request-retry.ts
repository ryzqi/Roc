import { RocDomainError } from './errors';

export const providerRequestTimeoutMs = 60_000;
export const providerRequestRetryBackoffMs = [1_000, 2_000, 4_000] as const;
export const providerRequestTimeoutMessage = 'Provider 请求超时，请稍后重试或检查 Provider endpoint。';

type RetryOptions = {
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
      kind: 'other';
    };

export async function executeWithProviderRequestRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isRetryableProviderRequestFailure;

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    throwIfAborted(options.signal);

    try {
      return await operation();
    } catch (error) {
      if (attemptIndex >= providerRequestRetryBackoffMs.length || !shouldRetry(error)) {
        throw error;
      }
      await delayWithAbort(providerRequestRetryBackoffMs[attemptIndex], options.signal);
    }
  }
}

export function isRetryableProviderRequestFailure(error: unknown): boolean {
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
    isRecord(error.cause)
  );
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
