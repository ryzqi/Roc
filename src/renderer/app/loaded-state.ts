/**
 * Uniform async-result handling.
 *
 * Every IPC call is either `{ ok: true, data }` or `{ ok: false, error }`.
 * Components never `try/catch` around IPC calls; they unwrap and let the shell
 * render an error bar with the backend's own message.
 */

export type IpcLikeResult<T> = { ok: true; data: T } | { ok: false; error: { message: string; code?: string } };

export type ActionOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export async function runIpcAction<T>(
  operation: () => Promise<IpcLikeResult<T>>
): Promise<ActionOutcome<T>> {
  try {
    const result = await operation();
    return result.ok
      ? { ok: true, data: result.data }
      : { ok: false, error: result.error.message };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Backend error codes the renderer branches on.
 *
 * `rocErrorSchema` requires `code`, so it is always present at runtime; the
 * contract widens it as optional here because some of these states are expected
 * outcomes rather than failures — "this directory is not a Git repository" has
 * to reach the UI as an explanation, not as a red error bar.
 */
export const BACKEND_ERROR_CODES = {
  gitRepositoryMissing: 'git_repository_missing',
  workspacePathMissing: 'workspace_path_missing'
} as const;

export class IpcCallError extends Error {
  constructor(
    readonly label: string,
    readonly cause: { message: string }
  ) {
    super(`${label} 失败：${cause.message}`);
    this.name = 'IpcCallError';
  }
}

/** Returns the payload, or throws an `IpcCallError` carrying the backend text. */
export function unwrap<T>(label: string, result: IpcLikeResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new IpcCallError(label, result.error);
}

/** Non-throwing variant for call sites that render their own inline error. */
export function settled<T>(result: IpcLikeResult<T>): { ok: true; data: T } | { ok: false; message: string } {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, message: result.error.message };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '未知错误';
}
