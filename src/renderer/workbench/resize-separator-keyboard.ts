type ResizeSeparatorDirection = 'normal' | 'inverted';

export function resolveResizeSeparatorKeyWidth({
  currentWidth,
  direction,
  key,
  maxWidth,
  minWidth,
  step
}: {
  currentWidth: number;
  direction: ResizeSeparatorDirection;
  key: string;
  maxWidth: number;
  minWidth: number;
  step: number;
}): number | null {
  if (key === 'Home') {
    return minWidth;
  }
  if (key === 'End') {
    return maxWidth;
  }
  if (key === 'ArrowLeft') {
    return clampResizeWidth(currentWidth + (direction === 'inverted' ? step : -step), minWidth, maxWidth);
  }
  if (key === 'ArrowRight') {
    return clampResizeWidth(currentWidth + (direction === 'inverted' ? -step : step), minWidth, maxWidth);
  }
  return null;
}

function clampResizeWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}
