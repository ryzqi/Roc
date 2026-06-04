import type { IpcResult, RocError, RocErrorCategory } from '../../shared/types';
import type { LogEventContext, LogService } from './log-service';

type ErrorLogService = Pick<LogService, 'warn' | 'error'>;

let logServiceInstance: ErrorLogService | null = null;

export class RocDomainError extends Error {
  readonly code: string;
  readonly category: RocErrorCategory;
  readonly retryable: boolean;
  readonly userAction?: string;

  constructor(input: {
    code: string;
    message: string;
    category: RocErrorCategory;
    retryable: boolean;
    userAction?: string;
  }) {
    super(input.message);
    this.name = 'RocDomainError';
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.userAction = input.userAction;
  }
}

export type ErrorContext = {
  service?: string;
  component?: string;
  traceId?: string;
  runId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
};

export function setLogService(logService: ErrorLogService | null): void {
  logServiceInstance = logService;
}

export function toRocError(error: unknown, context: ErrorContext = {}): RocError {
  if (error instanceof RocDomainError) {
    logServiceInstance?.warn('Domain error occurred.', {
      ...buildLogContext(context),
      error: {
        code: error.code,
        message: error.message,
        category: error.category
      }
    });
    return {
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      userAction: error.userAction
    };
  }

  if (error instanceof Error) {
    logServiceInstance?.error('Internal error.', error, buildLogContext(context));
    return {
      code: 'internal_error',
      message: 'Roc 内部错误，已记录到本地日志。',
      category: 'internal',
      retryable: false,
      userAction: '请查看 Roc 日志后重试。'
    };
  }

  logServiceInstance?.error('Unknown error type.', new Error(String(error)), {
    ...buildLogContext(context),
    metadata: {
      ...context.metadata,
      error: String(error)
    }
  });
  return {
    code: 'unknown_error',
    message: 'Roc 遇到未知错误。',
    category: 'internal',
    retryable: false,
    userAction: '请查看 Roc 日志后重试。'
  };
}

export async function wrapIpc<T>(operation: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: toRocError(error) };
  }
}

function buildLogContext(context: ErrorContext): LogEventContext {
  const logContext: LogEventContext = {
    service: context.service === undefined ? 'unknown' : context.service
  };
  if (context.component !== undefined) {
    logContext.component = context.component;
  }
  if (context.traceId !== undefined) {
    logContext.traceId = context.traceId;
  }
  if (context.runId !== undefined) {
    logContext.runId = context.runId;
  }
  if (context.threadId !== undefined) {
    logContext.threadId = context.threadId;
  }
  if (context.metadata !== undefined) {
    logContext.metadata = context.metadata;
  }
  return logContext;
}
