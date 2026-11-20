/**
 * Error taxonomy carried into the shell.
 *
 * Five levels, each with a distinct surface. Naming them in one module is what
 * stops every view from inventing its own error chrome:
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
