import { errorMessage } from './loaded-state';

/**
 * Error taxonomy from design-system/MASTER.md §9, carried into the new shell.
 *
 * Five levels, each with a distinct surface. The point of naming them in one
 * module is that no view invents its own error chrome (ADR-M07):
 *
 *   startup — the app could not boot; takes over the whole window
 *   page    — a whole view failed to load; error bar above an empty body
 *   field   — one field is invalid; inline next to the control
 *   run     — an agent/workflow run failed; inline in the transcript
 *   blocked — a guardrail or policy refused the action; explains how to proceed
 */

export type AppErrorLevel = 'startup' | 'page' | 'field' | 'run' | 'blocked';

export type AppError = {
  level: AppErrorLevel;
  message: string;
  /** Backend error code when the IPC layer provided one. */
  code?: string | null;
  /** Optional recovery affordance rendered next to the message. */
  retry?: (() => void) | undefined;
  /** Optional "open settings" / "why?" link target. */
  actionLabel?: string;
  actionHref?: string;
};

export function makeError(level: AppErrorLevel, error: unknown, extra: Omit<AppError, 'level' | 'message'> = {}): AppError {
  return { level, message: errorMessage(error), ...extra };
}

export function isBlockedError(code: string | null | undefined): boolean {
  if (code === null || code === undefined) {
    return false;
  }
  return /guard|denied|forbidden|policy|approval_required|blocked/i.test(code);
}

/**
 * Maps a backend error code onto a level.
 *
 * Guardrail refusals are `blocked` (they are expected and explain how to
 * proceed). Otherwise the caller decides between `run` and `page` by saying
 * whether the failure happened inside an agent/workflow run — a run failure
 * renders inline in the transcript, a page failure renders a page error bar.
 */
export function levelFromCode(code: string | null | undefined, insideRun: boolean): AppErrorLevel {
  if (isBlockedError(code)) {
    return 'blocked';
  }
  return insideRun ? 'run' : 'page';
}
