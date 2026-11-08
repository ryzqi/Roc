import { useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';

/** An 8px pointer target around a hairline. Escape restores the drag's exact baseline. */
export type ResizableDividerProps = {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset?: () => void;
  onDragChange?: (dragging: boolean) => void;
  atLimit?: 'min' | 'max' | null;
  testId?: string;
};

export function ResizableDivider({
  ariaLabel, value, min, max, onResize, onReset, onDragChange, atLimit = null, testId
}: ResizableDividerProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onResize, onDragChange });
  callbacks.current = { onResize, onDragChange };
  useEffect(() => () => cleanupRef.current?.(), []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.isPrimary || cleanupRef.current !== null) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = value;
    target.focus();
    target.setPointerCapture(pointerId);
    setDragging(true);
    callbacks.current.onDragChange?.(true);

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onEscape, true);
      target.removeEventListener('lostpointercapture', onCancel);
      cleanupRef.current = null;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      callbacks.current.onDragChange?.(false);
    };
    const finish = (cancelled: boolean): void => {
      cleanup();
      if (cancelled) callbacks.current.onResize(startWidth);
      setDragging(false);
    };
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId === pointerId) callbacks.current.onResize(startWidth + moveEvent.clientX - startX);
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId === pointerId) finish(false);
    };
    const onCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId === pointerId) finish(true);
    };
    const onEscape = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(true);
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onEscape, true);
    target.addEventListener('lostpointercapture', onCancel);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (dragging) return;
    if (event.key === 'Home' && onReset !== undefined) {
      event.preventDefault();
      onReset();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? 32 : 8;
      onResize(value + (event.key === 'ArrowLeft' ? -step : step));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} 像素`}
      title="拖动调整宽度，Escape 撤销；方向键微调，Home 重置"
      tabIndex={0}
      data-testid={testId}
      data-dragging={dragging}
      onPointerDown={startDrag}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onReset?.();
      }}
      onKeyDown={onKeyDown}
      className="group relative z-30 -mx-1 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center select-none"
    >
      <div
        className={
          dragging
            ? 'h-full w-[0.5px] bg-accent transition-colors duration-[var(--duration-fast)]'
            : 'h-full w-[0.5px] bg-line transition-colors duration-[var(--duration-fast)] group-hover:bg-line-strong'
        }
      />
      <div
        className={
          dragging
            ? 'pointer-events-none absolute top-1/2 flex h-6 w-3.5 -translate-y-1/2 scale-105 items-center justify-center rounded-control border-[0.5px] border-line bg-[var(--surface-card-hover)] opacity-100 transition-all duration-[var(--duration-fast)]'
            : 'pointer-events-none absolute top-1/2 flex h-6 w-3.5 -translate-y-1/2 scale-100 items-center justify-center rounded-control border-[0.5px] border-line bg-surface opacity-0 transition-all duration-[var(--duration-fast)] group-hover:opacity-100'
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
