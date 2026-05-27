import { useEffect, useRef } from 'react';
import type React from 'react';
import type { WindowBoundsSnapshot, WindowStateSnapshot } from '../../shared/types';
import { unwrap } from '../loaded-state';

type WindowDragSession = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

type PendingWindowDragSession = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  latestClientX: number;
  latestClientY: number;
  released: boolean;
};

export function canStartWindowDrag({
  button,
  fullscreen,
  maximized,
  targetWithinActions
}: {
  button: number;
  fullscreen: boolean;
  maximized: boolean;
  targetWithinActions: boolean;
}): boolean {
  if (button !== 0 || maximized || fullscreen) {
    return false;
  }
  return !targetWithinActions;
}

export function buildDraggedWindowBounds({
  clientX,
  clientY,
  session
}: {
  clientX: number;
  clientY: number;
  session: WindowDragSession;
}): WindowBoundsSnapshot {
  return {
    x: Math.round(clientX - session.offsetX),
    y: Math.round(clientY - session.offsetY),
    width: session.width,
    height: session.height
  };
}

export function useWindowDrag(windowState: WindowStateSnapshot): {
  finishWindowDrag: (pointerId?: number) => void;
  continueWindowDrag: (clientX: number, clientY: number) => void;
  startWindowDrag: (event: React.PointerEvent<HTMLElement>) => void;
} {
  const windowDragRef = useRef<WindowDragSession | null>(null);
  const pendingWindowDragRef = useRef<PendingWindowDragSession | null>(null);

  useEffect(() => {
    return () => {
      windowDragRef.current = null;
      pendingWindowDragRef.current = null;
    };
  }, []);

  function finishWindowDrag(pointerId?: number): void {
    const pendingDragSession = pendingWindowDragRef.current;
    if (pendingDragSession !== null) {
      if (pointerId !== undefined && pendingDragSession.pointerId !== pointerId) {
        return;
      }
      pendingDragSession.released = true;
    }
    const dragSession = windowDragRef.current;
    if (dragSession === null) {
      return;
    }
    if (pointerId !== undefined && dragSession.pointerId !== pointerId) {
      return;
    }
    windowDragRef.current = null;
  }

  function continueWindowDrag(clientX: number, clientY: number): void {
    const dragSession = windowDragRef.current;
    if (windowState.maximized || windowState.fullscreen) {
      return;
    }
    if (dragSession === null) {
      const pendingDragSession = pendingWindowDragRef.current;
      if (pendingDragSession !== null) {
        pendingDragSession.latestClientX = clientX;
        pendingDragSession.latestClientY = clientY;
      }
      return;
    }
    void window.roc.window.setBounds(
      buildDraggedWindowBounds({
        clientX,
        clientY,
        session: dragSession
      })
    );
  }

  function startWindowDrag(event: React.PointerEvent<HTMLElement>): void {
    const targetWithinActions =
      event.target instanceof Element && event.target.closest('.workband-actions') !== null;
    if (
      !canStartWindowDrag({
        button: event.button,
        maximized: windowState.maximized,
        fullscreen: windowState.fullscreen,
        targetWithinActions
      })
    ) {
      return;
    }
    event.preventDefault();
    const pointerId = event.pointerId;
    pendingWindowDragRef.current = {
      pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      latestClientX: event.clientX,
      latestClientY: event.clientY,
      released: false
    };
    void window.roc.window.getBounds().then((result) => {
      const bounds = unwrap<WindowBoundsSnapshot>('window bounds', result);
      const pendingDragSession = pendingWindowDragRef.current;
      if (pendingDragSession === null || pendingDragSession.pointerId !== pointerId) {
        return;
      }
      pendingWindowDragRef.current = null;
      const dragSession = {
        pointerId,
        offsetX: pendingDragSession.startClientX - bounds.x,
        offsetY: pendingDragSession.startClientY - bounds.y,
        width: bounds.width,
        height: bounds.height
      };
      if (
        pendingDragSession.latestClientX !== pendingDragSession.startClientX ||
        pendingDragSession.latestClientY !== pendingDragSession.startClientY
      ) {
        void window.roc.window.setBounds(
          buildDraggedWindowBounds({
            clientX: pendingDragSession.latestClientX,
            clientY: pendingDragSession.latestClientY,
            session: dragSession
          })
        );
      }
      if (!pendingDragSession.released) {
        windowDragRef.current = dragSession;
      }
    });
  }

  return {
    finishWindowDrag,
    continueWindowDrag,
    startWindowDrag
  };
}
