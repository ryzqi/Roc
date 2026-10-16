import { useState } from 'react';
import { GripVertical } from 'lucide-react';

/**
 * Column resize handle.
 *
 * Pointer drag is the primary interaction, but AGENTS.md requires every
 * important action to be keyboard reachable, so the separator takes focus and
 * responds to arrow keys (8px per press, 32px with Shift). Double-click resets
 * to the default width; double-click is a convenience, never the only path.
 *
 * The hairline is drawn at 1px inside an 8px hit area: the hit target is
 * comfortable without making the two panels look separated by a gutter.
 *
 * Colors come from the token layer through arbitrary Tailwind values so no
 * component hard-codes a hex (MASTER v2 §2).
 */

export type ResizableDividerProps = {
  ariaLabel: string;
  /** Positive means "the panel to the left grew". */
  onDelta: (deltaPx: number) => void;
  onReset?: () => void;
  onDragChange?: (dragging: boolean) => void;
  /** Announces that the panel cannot shrink further in this direction. */
  atLimit?: 'min' | 'max' | null;
  testId?: string;
};

const KEYBOARD_STEP = 8;
const KEYBOARD_STEP_LARGE = 32;

export function ResizableDivider({
  ariaLabel,
  onDelta,
  onReset,
  onDragChange,
  atLimit = null,
  testId
}: ResizableDividerProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);
    onDragChange?.(true);
    let lastX = event.clientX;

    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - lastX;
      lastX = moveEvent.clientX;
      if (delta !== 0) {
        onDelta(delta);
      }
    };

    const onUp = (upEvent: PointerEvent): void => {
      try {
        target.releasePointerCapture(upEvent.pointerId);
      } catch {
        // Pointer capture may already be gone; releasing twice is harmless.
      }
      setDragging(false);
      onDragChange?.(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Home' && onReset !== undefined) {
      event.preventDefault();
      onReset();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    onDelta(event.key === 'ArrowLeft' ? -step : step);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-testid={testId}
      data-dragging={dragging}
      onPointerDown={startDrag}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onReset?.();
      }}
      onKeyDown={onKeyDown}
      className="relative z-30 -mx-1 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center select-none"
    >
      <div
        className={
          dragging
            ? 'h-full w-px bg-line-strong transition-colors duration-[var(--duration-fast)]'
            : 'h-full w-px bg-line transition-colors duration-[var(--duration-fast)]'
        }
      />
      <div
        className={
          dragging
            ? 'pointer-events-none absolute top-1/2 flex h-6 w-3.5 -translate-y-1/2 items-center justify-center rounded-control border border-line bg-[var(--surface-card-hover)] opacity-100 transition-opacity duration-[var(--duration-fast)]'
            : 'pointer-events-none absolute top-1/2 flex h-6 w-3.5 -translate-y-1/2 items-center justify-center rounded-control border border-line bg-surface opacity-0 transition-opacity duration-[var(--duration-fast)]'
        }
      >
        <GripVertical size={10} aria-hidden="true" className="text-muted" />
      </div>
      {atLimit === null ? null : (
        <span className="sr-only" aria-live="polite">
          {atLimit === 'min' ? '已达到最小宽度' : '已达到最大宽度'}
        </span>
      )}
    </div>
  );
}
