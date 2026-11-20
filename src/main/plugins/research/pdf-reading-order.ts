import type {PdfBox} from './pdf-native-text';

export type PositionedBlock = {id: string; bbox: PdfBox | null};
const centerY = (box: PdfBox): number => (box[1] + box[3]) / 2;

/** Spatial columns within bands separated by spanning blocks. Array order is only a tie break. */
export function orderPdfBlocks<T extends PositionedBlock>(blocks: T[], pageWidth: number): {blocks: T[]; warnings: string[]} {
  const located = blocks.filter((block): block is T & {bbox: PdfBox} => block.bbox !== null);
  const unlocated = blocks.filter(block => block.bbox === null);
  const spatial = (a: T & {bbox: PdfBox}, b: T & {bbox: PdfBox}): number =>
    a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id);
  const edges = [...new Set(located.flatMap(block => [block.bbox[0], block.bbox[2]]))].sort((a, b) => a - b);
  let split: number | null = null, bestScore = 0;
  for (let i = 1; i < edges.length; i++) {
    const leftEdge = edges[i - 1]!, rightEdge = edges[i]!, gap = rightEdge - leftEdge;
    if (gap < pageWidth * 0.025) continue;
    const candidate = (leftEdge + rightEdge) / 2;
    // A margin is not a column split; require actual content on both sides.
    const left = located.filter(block => block.bbox[2] <= leftEdge);
    const right = located.filter(block => block.bbox[0] >= rightEdge);
    const crossing = located.length - left.length - right.length;
    if (left.length < 2 || right.length < 2 || crossing > located.length * 0.35) continue;
    const leftRange: PdfBox = [0, Math.min(...left.map(b => b.bbox[1])), 0, Math.max(...left.map(b => b.bbox[3]))];
    const rightRange: PdfBox = [0, Math.min(...right.map(b => b.bbox[1])), 0, Math.max(...right.map(b => b.bbox[3]))];
    if (Math.min(leftRange[3], rightRange[3]) <= Math.max(leftRange[1], rightRange[1])) continue;
    const score = Math.min(left.length, right.length) * gap / (crossing + 1);
    if (score > bestScore) {split = candidate; bestScore = score;}
  }
  if (split === null) return {blocks: [...located.sort(spatial), ...unlocated],
    warnings: unlocated.length ? ['native_geometry_unavailable'] : []};
  const columnSplit = split;
  const spanning = located.filter(block => block.bbox[0] < columnSplit && block.bbox[2] > columnSplit).sort(spatial);
  const columns = located.filter(block => !spanning.includes(block));
  const ordered: T[] = [];
  const appendBand = (band: typeof located): void => {
    ordered.push(...band.filter(block => block.bbox[2] <= columnSplit).sort(spatial),
      ...band.filter(block => block.bbox[0] >= columnSplit).sort(spatial));
  };
  let remaining = columns;
  for (const block of spanning) {
    appendBand(remaining.filter(item => centerY(item.bbox) < centerY(block.bbox)));
    remaining = remaining.filter(item => centerY(item.bbox) >= centerY(block.bbox));
    ordered.push(block);
  }
  appendBand(remaining);
  return {blocks: [...ordered, ...unlocated], warnings: unlocated.length ? ['native_geometry_unavailable'] : []};
}
