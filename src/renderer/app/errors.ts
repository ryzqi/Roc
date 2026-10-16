import { errorMessage } from './loaded-state';

/**
 * Error taxonomy from design-system/MASTER.md §10, carried into the new shell.
 *
 * Five levels, each with a distinct surface. Naming them in one module is what
 * stops every view from inventing its own error chrome (ADR-M07):
 *
 *   startup — the app could not boot; takes over the whole window
 *   page    — a whole view failed to load; error bar above an empty body
 *   field   — one field is invalid; inline next to the control
 *   run     — an agent/workflow run failed; inline in the transcript
 *   blocked — a guardrail or policy refused the action; explains how to proceed
 *
 * Modelled as a discriminated union (not one object with a `level` field) so
 * `Extract<AppError, { level: 'page' | 'blocked' }>` narrows correctly and each
 * surface can only be handed the levels it knows how to draw.
 */

export type AppErrorLevel = 'startup' | 'page' | 'field' | 'run' | 'blocked';

type AppErrorFields = {
  message: string;
  /** Backend error code, when the IPC layer provided one. */
  code?: string | null;
  /** Optional recovery affordance rendered next to the message. */
  retry?: (() => void) | undefined;
  /** Optional "打开设置" style hint label. */
  actionLabel?: string;
  actionHref?: string;
};

export type AppError =
  | ({ level: 'startup' } & AppErrorFields)
  | ({ level: 'page' } & AppErrorFields)
  | ({ level: 'field' } & AppErrorFields)
  | ({ level: 'run' } & AppErrorFields)
  | ({ level: 'blocked' } & AppErrorFields);

export function makeError(
  level: AppErrorLevel,
  error: unknown,
  extra: Omit<AppErrorFields, 'message'> = {}
): AppError {
  return { level, message: errorMessage(error), ...extra } as AppError;
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
