import { afterEach, describe, expect, it, vi } from 'vitest';
import { RocDomainError, setLogService, toLogError, toRocError } from '../../src/main/services/errors';

function createLogServiceMock() {
  return {
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe('error logging', () => {
  afterEach(() => {
    setLogService(null);
  });

  it('logs RocDomainError details with context while preserving the public error contract', () => {
    const logService = createLogServiceMock();
    setLogService(logService);
    const error = new RocDomainError({
      code: 'git_command_failed',
      message: 'Git command failed.',
      category: 'external',
      retryable: true,
      userAction: 'Retry the Git operation.'
    });

    const result = toRocError(error, {
      service: 'git',
      component: 'commit',
      traceId: 'trace_1',
      runId: 'run_1',
      metadata: { command: 'git commit' }
    });

    expect(result).toEqual({
      code: 'git_command_failed',
      message: 'Git command failed.',
      category: 'external',
      retryable: true,
      userAction: 'Retry the Git operation.'
    });
    expect(logService.warn).toHaveBeenCalledWith('Domain error occurred.', {
      service: 'git',
      component: 'commit',
      traceId: 'trace_1',
      runId: 'run_1',
      error: {
        code: 'git_command_failed',
        message: 'Git command failed.',
        category: 'external'
      },
      metadata: { command: 'git commit' }
    });
  });

  it('logs internal Error instances with the original stack', () => {
    const logService = createLogServiceMock();
    setLogService(logService);
    const error = new Error('database unavailable');
    error.stack = 'database stack';

    const result = toRocError(error, {
      service: 'ipc',
      component: 'tasksGetSnapshot',
      metadata: { channel: 'roc:tasks:getSnapshot' }
    });

    expect(result).toEqual({
      code: 'internal_error',
      message: 'Roc 内部错误，已记录到本地日志。',
      category: 'internal',
      retryable: false,
      userAction: '请查看 Roc 日志后重试。'
    });
    expect(logService.error).toHaveBeenCalledWith('Internal error.', error, {
      service: 'ipc',
      component: 'tasksGetSnapshot',
      metadata: { channel: 'roc:tasks:getSnapshot' }
    });
  });

  it('logs unknown thrown values as structured errors', () => {
    const logService = createLogServiceMock();
    setLogService(logService);

    const result = toRocError('string failure', {
      service: 'ipc',
      metadata: { channel: 'roc:test' }
    });

    expect(result).toEqual({
      code: 'unknown_error',
      message: 'Roc 遇到未知错误。',
      category: 'internal',
      retryable: false,
      userAction: '请查看 Roc 日志后重试。'
    });
    expect(logService.error).toHaveBeenCalledWith('Unknown error type.', expect.any(Error), {
      service: 'ipc',
      metadata: {
        channel: 'roc:test',
        error: 'string failure'
      }
    });
  });

  it('normalizes unknown thrown values for boundary logging', () => {
    const error = new Error('already normalized');

    expect(toLogError(error)).toBe(error);
    expect(toLogError('string failure')).toMatchObject({
      message: 'string failure'
    });
  });
});
