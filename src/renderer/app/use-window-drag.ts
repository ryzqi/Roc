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

  useEffect(() => {
    return () => {
      windowDragRef.current = null;
    };
  }, []);

  function finishWindowDrag(pointerId?: number): void {
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
    if (dragSession === null || windowState.maximized || windowState.fullscreen) {
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
    void window.roc.window.getBounds().then((result) => {
      const bounds = unwrap<WindowBoundsSnapshot>('window bounds', result);
      windowDragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - bounds.x,
        offsetY: event.clientY - bounds.y,
        width: bounds.width,
        height: bounds.height
      };
    });
  }

  return {
    finishWindowDrag,
    continueWindowDrag,
    startWindowDrag
  };
}
