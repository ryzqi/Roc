import { RocDomainError } from '../errors';
import {
  classifyProviderRequestFailure,
  isRetryableProviderHttpStatus,
  providerRequestTimeoutMessage
} from '../provider-request-retry';
import { isRecord } from './record-utils';
import { redact } from './redact';
import type { RunFailure } from './types';

function readHttpStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

export function toRunFailure(error: unknown): RunFailure {
  if (error instanceof RocDomainError) {
    return {
      code: error.code,
      message: redact(error.message),
      retryable: error.retryable
    };
  }
  const classification = classifyProviderRequestFailure(error);
  if (classification.kind === 'abort') {
    return {
      code: 'chat_run_cancelled',
      message: '当前运行已取消。',
      retryable: true
    };
  }
  if (classification.kind === 'http') {
    return {
      code: 'provider_http_error',
      message: `Provider 返回 HTTP ${classification.status}。`,
      retryable: isRetryableProviderHttpStatus(classification.status)
    };
  }
  if (error instanceof Error) {
    if (classification.kind === 'timeout') {
      return {
        code: 'provider_request_timeout',
        message: providerRequestTimeoutMessage,
        retryable: true
      };
    }
    if (classification.kind === 'network') {
      return {
        code: 'provider_network_error',
        message: `Provider 网络请求失败：${redact(error.message)}`,
        retryable: true
      };
    }
    return {
      code: 'provider_execution_failed',
      message: redact(error.message),
      retryable: true
    };
  }
  return {
    code: 'provider_execution_failed',
    message: 'Provider 执行失败。',
    retryable: true
  };
}

export function toWebSearchFailure(error: unknown): RocDomainError {
  if (error instanceof RocDomainError) {
    return error;
  }
  if (error instanceof Error) {
    return new RocDomainError({
      code: 'web_search_unavailable',
      message: `web_search 不可用：${redact(error.message)}`,
      category: 'external',
      retryable: true,
      userAction: '请测试 Exa Hosted MCP 连接或稍后重试。'
    });
  }
  return new RocDomainError({
    code: 'web_search_unavailable',
    message: 'web_search 当前不可用。',
    category: 'external',
    retryable: true,
    userAction: '请测试 Exa Hosted MCP 连接或稍后重试。'
  });
}
