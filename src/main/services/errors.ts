import type { IpcResult, RocError, RocErrorCategory } from '../../shared/types';

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

export function toRocError(error: unknown): RocError {
  if (error instanceof RocDomainError) {
    return {
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      userAction: error.userAction
    };
  }

  if (error instanceof Error) {
    return {
      code: 'internal_error',
      message: 'Roc 内部错误，已记录到本地日志。',
      category: 'internal',
      retryable: false,
      userAction: '请查看 Roc 日志或重新运行 Doctor。'
    };
  }

  return {
    code: 'unknown_error',
    message: 'Roc 遇到未知错误。',
    category: 'internal',
    retryable: false,
    userAction: '请查看 Roc 日志或重新运行 Doctor。'
  };
}

export async function wrapIpc<T>(operation: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: toRocError(error) };
  }
}
