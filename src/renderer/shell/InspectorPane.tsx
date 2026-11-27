import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {
  autoUpdate, FloatingFocusManager, FloatingPortal, size,
  useDismiss, useFloating, useInteractions, useRole
} from '@floating-ui/react';
import {X} from 'lucide-react';
import {OVERLAY_Z_INDEX} from './overlay-stack';
import {useOverlayBehavior} from './use-overlay-behavior';
import {useFloatingSurfacePresence} from './use-floating-surface-presence';
import './inspector-pane.css';

type Bounds = {x: number; y: number; width: number; height: number};

/**
 * A permanent desktop track, or a non-modal drawer over the same canvas.
 * The dock keeps its width while closed; opening details cannot resize the list.
 * Floating UI owns the overlay's fixed position and focus order.
 */
export function InspectorPane({open, overlay, anchorRef, returnFocusRef, title, testId, onClose, children}: {
  open: boolean;
  overlay: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  title: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const overlayId = useId();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const {refs, context, floatingStyles, isPositioned, update: updatePosition} = useFloating({
    open: open && overlay, onOpenChange: value => {if (!value) onClose();},
    strategy: 'fixed', placement: 'left-start', whileElementsMounted: autoUpdate,
    middleware: [size({apply({elements}) {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      elements.floating.style.width = `${Math.min(340, rect.width)}px`;
      elements.floating.style.height = `${rect.height}px`;
    }})]
  });
  useLayoutEffect(() => {
    if (open && overlay) updatePosition();
  }, [open, overlay, updatePosition]);
  const setFloating = refs.setFloating;
  const setPanel = useCallback((element: HTMLDivElement | null): void => {
    setFloating(element);
    panelRef.current = element;
  }, [setFloating]);
  const setReference = refs.setReference;
  // The canvas host's ref is attached after its children finish their layout
  // effects. Read it after that commit, including an initially narrow window.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!overlay || anchor === null) return;
    setReference({
      contextElement: anchor,
      getBoundingClientRect: () => {
        const rect = anchor.getBoundingClientRect();
        return new DOMRect(rect.right, rect.top, 0, rect.height);
      }
    });
    const update = (): void => {
      const {x, y, width, height} = anchor.getBoundingClientRect();
      setBounds(current => current?.x === x && current.y === y && current.width === width && current.height === height
        ? current : {x, y, width, height});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [overlay, anchorRef, setReference]);
  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePressEvent: 'pointerdown',
    outsidePress: event => !(event.target instanceof Element &&
      event.target.closest('[data-inspector-trigger], [data-library-row]'))
  });
  const role = useRole(context, {role: 'dialog'});
  const {getFloatingProps} = useInteractions([dismiss, role]);
  const {isMounted, state, visible, reduced} = useFloatingSurfacePresence(context, isPositioned, 'drawer');
  useOverlayBehavior({
    open: open && overlay, panelRef, overlayId, onRequestClose: onClose,
    canClose: () => true, inertBackground: false, modal: false, manageFocus: false, captureEscape: true
  });

  const content = <>
    <header className="inspector-pane-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" onClick={onClose} aria-label={`关闭${title}`} data-testid={`${testId}-close`}>
        <X size={14} aria-hidden="true"/>
      </button>
    </header>
    <div className="inspector-pane-scroll">{children}</div>
  </>;
  if (!overlay) return <div className="inspector-pane-dock" data-testid={`${testId}-track`}>
    <aside className="inspector-pane-panel" aria-label={title} data-testid={testId} data-presentation="docked"
      data-open={open} onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) {event.preventDefault(); onClose();}
      }}>
      {open ? content : <p className="inspector-pane-placeholder">选中文献查看详情</p>}
    </aside>
  </div>;
  return <>{isMounted && bounds !== null ? <FloatingPortal>
    <div className="inspector-pane-backdrop" aria-hidden="true" data-state={state} data-motion-reduced={reduced}
      data-testid={`${testId}-scrim`}
      style={{left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height,
        visibility: visible ? undefined : 'hidden', zIndex: OVERLAY_Z_INDEX.dialog}}/>
    <FloatingFocusManager context={context} modal={false} initialFocus={-1}
      disabled={!open || !isPositioned} closeOnFocusOut={false} returnFocus={returnFocusRef ?? true}>
      <div ref={setPanel}
        {...getFloatingProps()} aria-labelledby={titleId} aria-hidden={!open || undefined} inert={!open}
        className="inspector-pane-overlay" data-testid={testId} data-presentation="overlay" data-state={state}
        data-motion-reduced={reduced}
        style={{...floatingStyles, visibility: visible ? undefined : 'hidden', zIndex: OVERLAY_Z_INDEX.dialog}}>
        <section className="inspector-pane-panel">{content}</section>
      </div>
    </FloatingFocusManager>
  </FloatingPortal> : null}</>;
}
