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
  if (error instanceof Error) {
    const toolFailure = readToolFailure(error);
    if (toolFailure !== null) {
      return toolFailure;
    }
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

function readToolFailure(error: Error): RunFailure | null {
  const message = redact(error.message);
  const toolSchemaFailure = readToolSchemaFailure(message);
  if (toolSchemaFailure !== null) {
    return toolSchemaFailure;
  }
  if (message.startsWith('web_read 请求超时。')) {
    return {
      code: 'web_read_timeout',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_read 请求失败：HTTP ')) {
    const statusMatch = /\bHTTP\s+(\d{3})\b/iu.exec(message);
    const status = statusMatch === null ? null : Number(statusMatch[1]);
    return {
      code: 'web_read_http_error',
      message,
      retryable: status === null ? true : status === 429 || status >= 500
    };
  }
  if (message.startsWith('web_read 未返回可读正文。')) {
    return {
      code: 'web_read_empty_response',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_read url 不能为空。')) {
    return {
      code: 'web_read_url_empty',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 只支持合法的 HTTP/HTTPS URL。')) {
    return {
      code: 'web_read_url_invalid',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read timeoutSeconds 必须是 1 到 120 之间的整数。')) {
    return {
      code: 'web_read_timeout_invalid',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 请求失败')) {
    return {
      code: 'web_read_request_failed',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_search 不可用')) {
    return {
      code: 'web_search_unavailable',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_search 当前不可用。')) {
    return {
      code: 'web_search_unavailable',
      message,
      retryable: true
    };
  }
  return null;
}

function readToolSchemaFailure(message: string): RunFailure | null {
  if (!message.startsWith('Error invoking tool ')) {
    return null;
  }
  if (!/did not match expected schema|Received tool input did not match expected schema|Invalid input/iu.test(message)) {
    return null;
  }

  const toolName = readInvokedToolName(message);
  return {
    code: 'tool_input_schema_invalid',
    message: `任务工具参数不符合 schema：${toolName} 的输入不符合工具契约。`,
    retryable: true
  };
}

function readInvokedToolName(message: string): string {
  const match = /^Error invoking tool ['"]([^'"]+)['"]/u.exec(message);
  if (match === null) {
    return '工具';
  }
  return match[1];
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
