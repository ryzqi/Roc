import type { RunFailure } from './types';
import { toRunFailure } from './error-mapping';

export type FailureCategory = 'user' | 'provider' | 'system' | 'network';

export type RetryStrategy = {
  maxAttempts: number;
  baseDelayMs: number;
  conditions: ReadonlySet<'http_429' | 'http_5xx' | 'network' | 'timeout' | 'stream_interrupted'>;
  useCheckpointResume: boolean;
};

export type StructuredFailure = RunFailure & {
  category: FailureCategory;
  retryStrategy?: RetryStrategy;
  diagnostic?: {
    toolName?: string;
    schemaPath?: string;
    badKeys?: string[];
    httpStatus?: number;
    providerId?: string;
    modelId?: string;
  };
  telemetryTags: Record<string, string>;
  timestamp: number;
};

export function classifyFailure(error: unknown): StructuredFailure {
  const baseFailure = toRunFailure(error);
  const timestamp = Date.now();

  // Provider HTTP 错误
  if (baseFailure.code === 'provider_http_error') {
    const status = extractHttpStatus(baseFailure.message);
    return {
      ...baseFailure,
      category: 'provider',
      retryStrategy: {
        maxAttempts: status === 429 ? 3 : 5,
        baseDelayMs: status === 429 ? 2000 : 500,
        conditions: new Set(status === 429 ? ['http_429'] : ['http_5xx']),
        useCheckpointResume: false
      },
      diagnostic: {
        ...baseFailure.diagnostic,
        httpStatus: status ?? undefined
      },
      telemetryTags: {
        layer: 'provider',
        subsystem: 'http',
        status: status?.toString() ?? 'unknown'
      },
      timestamp
    };
  }

  // Stream 中断错误(需要 checkpoint 恢复)
  if (baseFailure.code === 'provider_stream_terminated' || baseFailure.code === 'provider_stream_idle') {
    return {
      ...baseFailure,
      category: 'network',
      retryStrategy: {
        maxAttempts: 3,
        baseDelayMs: 1000,
        conditions: new Set(['stream_interrupted']),
        useCheckpointResume: true
      },
      telemetryTags: {
        layer: 'provider',
        subsystem: 'stream',
        recovery_mode: 'checkpoint'
      },
      timestamp
    };
  }

  // 工具 schema 错误
  if (baseFailure.code === 'tool_input_schema_invalid') {
    return {
      ...baseFailure,
      category: 'user',
      diagnostic: baseFailure.diagnostic,
      telemetryTags: {
        layer: 'tool',
        subsystem: 'validation',
        tool_name: (baseFailure.diagnostic as { toolName?: string })?.toolName ?? 'unknown'
      },
      timestamp
    };
  }

  // 系统内部错误
  if (
    baseFailure.code?.startsWith('agent_checkpoint_') ||
    baseFailure.code === 'context_budget_exhausted'
  ) {
    return {
      ...baseFailure,
      category: 'system',
      telemetryTags: {
        layer: 'system',
        subsystem: baseFailure.code?.startsWith('agent_checkpoint_') ? 'checkpoint' : 'context'
      },
      timestamp
    };
  }

  // 网络错误
  if (baseFailure.code === 'provider_network_error' || baseFailure.code === 'provider_request_timeout') {
    return {
      ...baseFailure,
      category: 'network',
      retryStrategy: {
        maxAttempts: 5,
        baseDelayMs: 500,
        conditions: new Set(['network', 'timeout']),
        useCheckpointResume: false
      },
      telemetryTags: {
        layer: 'provider',
        subsystem: 'network'
      },
      timestamp
    };
  }

  // Web 工具错误
  if (baseFailure.code?.startsWith('web_read_') || baseFailure.code?.startsWith('web_search_')) {
    return {
      ...baseFailure,
      category: baseFailure.retryable ? 'network' : 'user',
      telemetryTags: {
        layer: 'tool',
        subsystem: 'web'
      },
      timestamp
    };
  }

  // 默认分类
  return {
    ...baseFailure,
    category: 'system',
    telemetryTags: { layer: 'unknown', subsystem: 'unknown' },
    timestamp
  };
}

function extractHttpStatus(message: string): number | null {
  const match = /\bHTTP\s+(\d{3})\b/u.exec(message);
  return match ? Number(match[1]) : null;
}
