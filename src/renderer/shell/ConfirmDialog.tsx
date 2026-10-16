import { useRef } from 'react';
import { ModalShell } from './ModalShell';

/**
 * Destructive-action confirmation (MASTER v2 §11).
 *
 * Used by settings-close-with-drafts, git discard, skill/MCP/task deletion, and
 * project delete. Replaces `window.confirm`, which cannot be styled, cannot be
 * keyboard-trapped consistently, and blocks the renderer.
 *
 * Safety defaults: focus starts on **cancel**, Escape cancels, and the scrim
 * never confirms. A destructive confirm must be pressed deliberately.
 */

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /** What will happen. State irreversible consequences explicitly. */
  message: string;
  /** Extra line for the part that cannot be undone (e.g. "不删除磁盘目录"). */
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
};

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
  testId = 'confirm-dialog'
}: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalShell
      open={open}
      title={title}
      onClose={onCancel}
      closeOnBackdrop={false}
      widthClassName="w-[420px]"
      testId={testId}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
            className="h-[var(--control-height)] rounded-control border border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
            className={
              tone === 'destructive'
                ? 'h-[var(--control-height)] rounded-control border border-[var(--st-bad-line)] px-3 text-[var(--st-bad)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                : 'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)]'
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-ink" data-testid={`${testId}-message`}>
        {message}
      </p>
      {detail === undefined ? null : (
        <p className="mt-2 text-muted text-[var(--font-meta-size)]">{detail}</p>
      )}
    </ModalShell>
  );
}
