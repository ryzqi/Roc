import type { Dispatch, PointerEvent, SetStateAction } from 'react';

import { clampGitSplitWidth } from '../git-workbench';

export function startGitPaneResize(
  event: PointerEvent<HTMLDivElement>,
  gitPaneWidth: number,
  setGitPaneWidth: Dispatch<SetStateAction<number>>
): void {
  const startX = event.clientX;
  const startWidth = gitPaneWidth;
  const onMove = (moveEvent: globalThis.PointerEvent): void => {
    setGitPaneWidth(clampGitSplitWidth(startWidth + moveEvent.clientX - startX));
  };
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}
