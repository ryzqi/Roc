import type {TextContent} from 'pdfjs-dist/types/src/display/api';
import type {ResearchPdfCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';

export type PdfBox = [number, number, number, number];
type Point = [number, number];
export type NativeTextItem = {
  id: string;
  page: number;
  itemIndex: number;
  text: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  fontFamily: string | null;
  fontSize: number;
  direction: string;
  hasEOL: boolean;
  vertical: boolean;
  ascent: number | null;
  descent: number | null;
  /** Whole TextItem font-metric bounds, never inferred glyph or substring bounds. */
  geometry: 'font-metrics' | 'font-box-fallback' | 'unavailable';
  pdfQuad: Point[] | null;
  pdfBbox: PdfBox | null;
  /** Unclipped projection of the original whole item; bbox is its visible viewport intersection. */
  rasterBbox: PdfBox | null;
  viewportClipped: boolean;
  bbox: PdfBox | null;
};

export function boundsOfPoints(points: Point[]): PdfBox {
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

/** PDF.js item transforms and advance widths retain the source coordinate system. */
export function captureNativeTextItems(content: TextContent, page: number): NativeTextItem[] {
  return content.items.flatMap((raw, itemIndex) => {
    if (!('str' in raw)) return [];
    const transform = Array.from(raw.transform, Number);
    const style = content.styles[raw.fontName];
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : null;
    const descent = Number.isFinite(style?.descent) ? style.descent : null;
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
    const vertical = style?.vertical === true;
    const item: NativeTextItem = {id: `page-${page}-native-item-${itemIndex + 1}`, page, itemIndex,
      text: raw.str, transform, width: raw.width, height: raw.height, fontName: raw.fontName,
      fontFamily: style?.fontFamily ?? null, fontSize, direction: raw.dir, hasEOL: raw.hasEOL,
      vertical, ascent, descent, geometry: 'unavailable', pdfQuad: null, pdfBbox: null,
      rasterBbox: null, viewportClipped: false, bbox: null};
    if (transform.length !== 6 || !transform.every(Number.isFinite) || fontSize <= 0 ||
        !Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return [item];
    const [a, b, c, d, x, y] = transform as [number, number, number, number, number, number];
    const baselineSize = Math.hypot(a, b);
    if (baselineSize === 0) return [item];
    // In PDF coordinates c/d point towards the font's ascent. Vertical fonts
    // use the perpendicular baseline, matching PDF.js text-layer orientation.
    const advance: Point = vertical ? [-b / baselineSize, a / baselineSize] : [a / baselineSize, b / baselineSize];
    const up: Point = vertical ? [a / baselineSize, b / baselineSize] : [c / fontSize, d / fontSize];
    const length = Math.abs(vertical ? raw.height : raw.width);
    const low = fontSize * (descent ?? 0), high = fontSize * (ascent ?? 1);
    const point = (along: number, rise: number): Point => [x + advance[0] * along + up[0] * rise,
      y + advance[1] * along + up[1] * rise];
    item.pdfQuad = [point(0, low), point(length, low), point(length, high), point(0, high)];
    item.pdfBbox = boundsOfPoints(item.pdfQuad);
    item.geometry = ascent === null || descent === null ? 'font-box-fallback' : 'font-metrics';
    return [item];
  });
}

/** Apply the exact viewport used by the page raster, including rotation/CropBox/UserUnit. */
export function projectNativeTextItems(items: NativeTextItem[], frame: ResearchPdfCoordinateFrame): NativeTextItem[] {
  const [a, b, c, d, e, f] = frame.viewport.transform;
  return items.map(item => {
    const rasterBbox = item.pdfQuad === null ? null : boundsOfPoints(item.pdfQuad.map(([x, y]) =>
      [a * x + c * y + e, b * x + d * y + f]));
    const clipped: PdfBox | null = rasterBbox === null ? null : [Math.max(0, rasterBbox[0]), Math.max(0, rasterBbox[1]),
      Math.min(frame.width, rasterBbox[2]), Math.min(frame.height, rasterBbox[3])];
    const bbox = clipped && clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : null;
    return {...item, rasterBbox, bbox, viewportClipped: rasterBbox !== null &&
      (bbox === null || bbox.some((value, i) => value !== rasterBbox[i]))};
  });
}

export function nativeItemsText(items: NativeTextItem[]): string {
  return items.map(item => `${item.text}${item.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+\n/gu, '\n').trim();
}
