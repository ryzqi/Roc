import type { RocError } from '../../shared/types/common';

/** Preserves the structured IPC failure while exposing a normal Error to SWR. */
export class IpcResourceError extends Error {
  readonly code: RocError['code'];
  readonly category: RocError['category'];
  readonly retryable: RocError['retryable'];
  readonly userAction: RocError['userAction'];
  readonly auditEventId: RocError['auditEventId'];

  constructor(readonly rocError: RocError) {
    super(rocError.message);
    this.name = 'IpcResourceError';
    this.code = rocError.code;
    this.category = rocError.category;
    this.retryable = rocError.retryable;
    this.userAction = rocError.userAction;
    this.auditEventId = rocError.auditEventId;
  }
}

export function isRetryableIpcResourceError(error: unknown): error is IpcResourceError {
  return error instanceof IpcResourceError && error.retryable;
}
