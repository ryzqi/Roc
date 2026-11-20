import { useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { ModalShell } from './ModalShell';

/**
 * Destructive-action confirmation.
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
  confirmDisabled?: boolean;
  pending?: boolean;
  error?: string | null;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  testId?: string;
};

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  confirmDisabled = false,
  pending = false,
  error,
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
  testId = 'confirm-dialog'
}: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);

  const confirm = async (): Promise<void> => {
    if (confirmDisabled || pending || confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      await onConfirm();
    } finally {
      confirmingRef.current = false;
    }
  };

  return (
    <ModalShell
      open={open}
      title={title}
      onClose={onCancel}
      closeOnBackdrop={false}
      closeDisabled={pending}
      widthClassName="w-[400px]"
      testId={testId}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            data-testid={`${testId}-cancel`}
            className="min-h-[var(--control-height)] max-w-full rounded-control border-[0.5px] border-line px-3 text-ink enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={confirmDisabled || pending}
            aria-busy={pending}
            data-testid={`${testId}-confirm`}
            className={`inline-flex min-h-[var(--control-height)] max-w-full items-center justify-center gap-2 rounded-control border-[0.5px] px-3 disabled:opacity-50 ${
              tone === 'destructive'
                ? 'border-[var(--st-bad-line)] text-st-bad enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)]'
                : 'border-transparent bg-[var(--fill-strong)] text-[var(--fill-strong-text)] enabled:hover:bg-[var(--fill-strong-hover)] enabled:active:opacity-90'
            }`}
          >
            {pending ? <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-ink" data-testid={`${testId}-message`}>
        {message}
      </p>
      {detail === undefined ? null : (
        <p className="mt-2 text-muted text-[length:var(--font-meta-size)]">{detail}</p>
      )}
      {error ? <p role="alert" className="mt-2 text-st-bad">{error}</p> : null}
    </ModalShell>
  );
}
