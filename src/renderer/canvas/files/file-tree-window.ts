/** Keep viewport rows and the roving focus anchor mounted, with exact spacer heights. */
export function fileTreeWindow(count: number, start: number, end: number, active: number): {
  indices: { index: number; gap: number }[];
  trailingRows: number;
} {
  const safeStart = Math.min(count, Math.max(0, start));
  const safeEnd = Math.max(safeStart, Math.min(count, end));
  const selected = new Set<number>();
  for (let index = safeStart; index < safeEnd; index += 1) selected.add(index);
  if (active >= 0 && active < count) selected.add(active);
  let previous = -1;
  const indices = [...selected].sort((a, b) => a - b).map((index) => {
    const gap = index - previous - 1;
    previous = index;
    return { index, gap };
  });
  return { indices, trailingRows: count - previous - 1 };
}
