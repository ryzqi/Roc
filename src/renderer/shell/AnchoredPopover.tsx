import {useId, useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject} from 'react';
import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size,
  useClick, useClientPoint, useDismiss, useFloating, useInteractions, useRole, useTransitionStatus,
  type Placement
} from '@floating-ui/react';
import {motionDurationSeconds} from '../shared/motion';
import {OVERLAY_Z_INDEX} from './overlay-stack';
import {useOverlayBehavior} from './use-overlay-behavior';
import './anchored-popover.css';

export type AnchoredPopoverTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref: (element: HTMLButtonElement | null) => void;
};

type PopoverContentProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  testId?: string;
  children: ReactNode;
  className?: string;
  placement?: Placement;
  role?: 'dialog' | 'menu';
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export type AnchoredPopoverProps = PopoverContentProps & (
  | {renderTrigger: (props: AnchoredPopoverTriggerProps) => ReactNode; anchor?: {x: number; y: number}}
  | {renderTrigger?: never; anchor: {x: number; y: number}}
);

function readLength(name: string): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * An interactive, non-modal surface. Positioning stays on the outer element;
 * only its child transitions, so Floating UI's translate never fights motion.
 * FloatingPortal preserves the trigger's natural Tab order without locking body
 * scrolling or changing the list's geometry.
 */
export function AnchoredPopover({
  open, onOpenChange, label, testId, children, className, renderTrigger, anchor,
  placement = 'bottom-end', role = 'dialog', returnFocusRef
}: AnchoredPopoverProps): React.JSX.Element {
  const overlayId = useId();
  const [metrics, setMetrics] = useState({gutter: 0, gap: 0});
  useLayoutEffect(() => {
    if (!open) return;
    const readMetrics = (): void => {
      const gutter = readLength('--shadow-popover-gutter');
      const gap = readLength('--space-2');
      setMetrics(current => current.gutter === gutter && current.gap === gap ? current : {gutter, gap});
    };
    readMetrics();
    const observer = new MutationObserver(readMetrics);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-high-contrast']});
    return () => observer.disconnect();
  }, [open]);

  const {refs, floatingStyles, context, placement: resolvedPlacement, isPositioned, update} = useFloating({
    open,
    onOpenChange,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(metrics.gap),
      flip({padding: metrics.gutter}),
      shift({padding: metrics.gutter, crossAxis: true}),
      size({
        padding: metrics.gutter,
        apply({availableWidth, availableHeight, elements}) {
          elements.floating.style.setProperty('--anchored-available-width', `${Math.max(0, availableWidth)}px`);
          elements.floating.style.setProperty('--anchored-available-height', `${Math.max(0, availableHeight)}px`);
        }
      })
    ]
  });
  useLayoutEffect(() => {
    // Exit transitions retain the same DOM refs. Reopening must position again
    // even when autoUpdate sees no reference or geometry change.
    if (open) update();
  }, [open, update]);
  useOverlayBehavior({
    open, panelRef: refs.floating, overlayId, layer: 'dialog', modal: false,
    inertBackground: false, manageFocus: false, captureEscape: true,
    onRequestClose: () => onOpenChange(false), canClose: () => true
  });
  const setReference = refs.setReference;
  useLayoutEffect(() => {
    if (renderTrigger === undefined) setReference(returnFocusRef?.current ?? null);
  }, [renderTrigger, returnFocusRef, setReference, open]);

  const click = useClick(context, {enabled: renderTrigger !== undefined});
  const clientPoint = useClientPoint(context, {enabled: anchor !== undefined, x: anchor?.x, y: anchor?.y});
  const dismiss = useDismiss(context, {outsidePressEvent: 'pointerdown', escapeKey: false});
  const accessibleRole = useRole(context, {role});
  const {getReferenceProps, getFloatingProps} = useInteractions([click, clientPoint, dismiss, accessibleRole]);
  const {isMounted, status} = useTransitionStatus(context, {duration: motionDurationSeconds.fast * 1000});

  return <>
    {renderTrigger?.({...getReferenceProps(), ref: setReference, type: 'button'})}
    {isMounted ? <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} disabled={!open || !isPositioned} returnFocus={returnFocusRef ?? true}>
        <div ref={refs.setFloating}
          {...getFloatingProps({
            onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
              if (role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
              )).filter(element => !element.matches(':disabled, [aria-disabled="true"]') && element.getClientRects().length > 0);
              if (items.length === 0) return;
              const index = items.findIndex(element => element === document.activeElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowDown' ? (index + 1) % items.length
                  : index < 0 ? items.length - 1 : (index + items.length - 1) % items.length;
              event.preventDefault();
              items[next]?.focus({preventScroll: true});
            }
          })}
          className="anchored-popover-position"
          aria-label={label}
          aria-labelledby={undefined}
          aria-hidden={!open || undefined}
          inert={!open}
          data-testid={testId}
          data-state={status}
          data-placement={resolvedPlacement}
          style={{...floatingStyles, zIndex: OVERLAY_Z_INDEX.dialog, visibility: isPositioned ? undefined : 'hidden'}}
        >
          <div className={`anchored-popover-surface ${className ?? ''}`}>{children}</div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal> : null}
  </>;
}
