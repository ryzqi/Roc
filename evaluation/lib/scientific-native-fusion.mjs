import {hash} from './common.mjs';

const requireValue = (condition, code) => {if (!condition) throw new Error(`scientific_native_fusion_${code}`);};
const clean = text => text.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
const compact = text => clean(text).normalize('NFC').replace(/\s/gu, '');
const area = box => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
const intersection = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const characters = text => [...compact(text)].sort().join('');
const sameNativeText = (text, items) => characters(text) === characters(items.map(i => i.text).join('')) &&
  items.every(item => compact(text).includes(compact(item.text)));

// PDF.js allocates the g_dN prefix per loading task. Preserve its raw value in
// artifacts; only this documented runtime counter is excluded from comparisons.
export const localPdfFontName = name => name.replace(/^g_d\d+_/u, 'g_');
export function stableNativeFusionValue(value) {
  if (Array.isArray(value)) return value.map(stableNativeFusionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, key === 'fontName' && typeof entry === 'string' ? localPdfFontName(entry) : stableNativeFusionValue(entry)]));
}

/** Reconstruct saved TextItem fields and whole-item font bounds from fresh
 * original PDF.js output. No production capture/geometry code is imported. */
export function verifyScientificNativeTextSource(page, content) {
  const sourceItems = content.items.flatMap((raw, index) => 'str' in raw ? [{raw, index}] : []);
  requireValue(Array.isArray(page.nativeTextItems) && page.nativeTextItems.length === sourceItems.length, 'source_count_changed');
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6;
  const sameNumbers = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => close(v, b[i]));
  for (const [position, {raw, index}] of sourceItems.entries()) {
    const item = page.nativeTextItems[position], style = content.styles[raw.fontName];
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : null;
    const descent = Number.isFinite(style?.descent) ? style.descent : null;
    const [a, b, c, d, x, y] = raw.transform, size = Math.hypot(c, d), baseline = Math.hypot(a, b);
    requireValue(item.id === `page-${page.page}-native-item-${index + 1}` && item.page === page.page && item.itemIndex === index
      && item.text === raw.str && sameNumbers(item.transform, raw.transform)
      && close(item.width, raw.width) && close(item.height, raw.height)
      && item.fontFamily === (style?.fontFamily ?? null) && close(item.fontSize, size)
      && localPdfFontName(item.fontName) === localPdfFontName(raw.fontName)
      && item.direction === raw.dir && item.hasEOL === raw.hasEOL && item.vertical === (style?.vertical === true)
      && item.ascent === ascent && item.descent === descent, 'source_item_changed');
    if (size <= 0 || baseline <= 0) {
      requireValue(item.geometry === 'unavailable' && item.pdfQuad === null && item.pdfBbox === null && item.bbox === null
        && item.rasterBbox === null && item.viewportClipped === false,
        'source_geometry_changed');
      continue;
    }
    const vertical = style?.vertical === true, advance = vertical ? [-b / baseline, a / baseline] : [a / baseline, b / baseline];
    const up = vertical ? [a / baseline, b / baseline] : [c / size, d / size];
    const length = Math.abs(vertical ? raw.height : raw.width), low = size * (descent ?? 0), high = size * (ascent ?? 1);
    const quad = [[0, low], [length, low], [length, high], [0, high]].map(([along, rise]) =>
      [x + along * advance[0] + rise * up[0], y + along * advance[1] + rise * up[1]]);
    const bounds = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
    const [va, vb, vc, vd, ve, vf] = page.coordinateFrame.viewport.transform;
    const raster = bounds(quad.map(([px, py]) => [va * px + vc * py + ve, vb * px + vd * py + vf]));
    const clipped = [Math.max(0, raster[0]), Math.max(0, raster[1]), Math.min(page.coordinateFrame.width, raster[2]),
      Math.min(page.coordinateFrame.height, raster[3])];
    const visible = clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : null;
    requireValue(item.geometry === (ascent === null || descent === null ? 'font-box-fallback' : 'font-metrics')
      && Array.isArray(item.pdfQuad) && item.pdfQuad.length === 4 && item.pdfQuad.every((p, i) => sameNumbers(p, quad[i]))
      && sameNumbers(item.pdfBbox, bounds(quad)) && sameNumbers(item.rasterBbox, raster)
      && (visible === null ? item.bbox === null : sameNumbers(item.bbox, visible))
      && item.viewportClipped === (visible === null || visible.some((v, i) => v !== raster[i])), 'source_geometry_changed');
  }
  return {items: sourceItems.length, sourceTextAndGeometryVerified: true};
}

function similarity(a, b) {
  a = compact(a).toLowerCase(); b = compact(b).toLowerCase();
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 1; i < a.length; i++) counts.set(a.slice(i - 1, i + 1), (counts.get(a.slice(i - 1, i + 1)) ?? 0) + 1);
  let hits = 0;
  for (let i = 1; i < b.length; i++) {
    const key = b.slice(i - 1, i + 1), count = counts.get(key) ?? 0;
    if (count) {hits++; counts.set(key, count - 1);}
  }
  return 2 * hits / (a.length + b.length - 2);
}

/** Independent selection/source checks, without importing the production merger.
 * Character conservation plus original item substrings permits spatial reordering;
 * it does not establish reading-order quality or calibrated confidence. */
export function verifyScientificNativeFusion(page, blocks) {
  requireValue(page.fusion?.version === 1 && Array.isArray(page.nativeTextItems)
    && Array.isArray(page.fusion.provenance) && Array.isArray(page.fusion.warnings), 'shape_invalid');
  const items = new Map(), regions = new Map(page.regions.map(region => [region.id, region]));
  for (const item of page.nativeTextItems) {
    requireValue(typeof item.id === 'string' && !items.has(item.id) && item.page === page.page
      && typeof item.text === 'string', 'item_invalid');
    items.set(item.id, item);
  }
  const byId = new Map(blocks.map(block => [block.id, block])), represented = new Set(), primary = new Set();
  const owner = item => {
    if (!item.bbox) return null;
    return [...regions.values()].filter(region => intersection(item.bbox, region.bbox) / Math.max(area(item.bbox), 1) >= .65)
      .sort((a, b) => area(a.bbox) - area(b.bbox))[0]?.id ?? null;
  };
  for (const p of page.fusion.provenance) {
    const block = byId.get(p.blockId), region = regions.get(p.blockId);
    requireValue(block && Array.isArray(p.nativeItemIds) && Array.isArray(p.alternatives)
      && new Set(p.nativeItemIds).size === p.nativeItemIds.length
      && ['selected', 'duplicate', 'disputed'].includes(p.status), 'provenance_invalid');
    const native = p.nativeItemIds.map(id => items.get(id));
    requireValue(native.every(Boolean), 'unknown_item');
    for (const item of native) represented.add(item.id);
    if (p.source === 'native') {
      requireValue(native.length > 0 && p.confidence === null
        && native.every(item => p.overlapGroupId === (owner(item) ? `overlap:${owner(item)}` : null)), 'native_owner_invalid');
      const text = p.status === 'duplicate' ? p.alternatives.find(a => a.source === 'native')?.text : block.text;
      requireValue(typeof text === 'string' && sameNativeText(text, native), 'native_text_changed');
      if (p.status === 'duplicate') {
        const boxes = native.map(item => item.bbox);
        requireValue(boxes.every(Boolean) && block.locations.length === 1, 'duplicate_geometry_invalid');
        const box = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
          Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))], target = block.locations[0].bbox;
        const overlap = intersection(box, target), union = area(box) + area(target) - overlap;
        requireValue(overlap / union >= .65 && similarity(text, block.text) >= .9, 'duplicate_invalid');
      }
      continue;
    }
    requireValue(region && !primary.has(region.id) && ['ocr', 'merged'].includes(p.source), 'region_invalid');
    primary.add(region.id);
    const assigned = [...items.values()].filter(item => clean(item.text) && owner(item) === region.id).map(item => item.id);
    requireValue(hash(assigned.sort()) === hash([...p.nativeItemIds].sort())
      && p.confidence === (Number.isFinite(region.score) ? region.score : null)
      && p.overlapGroupId === (native.length ? `overlap:${region.id}` : null), 'region_owner_invalid');
    let nativeText = '';
    if (native.length) {
      requireValue(p.alternatives.length === 2, 'alternatives_invalid');
      nativeText = p.alternatives.find(a => a.source === 'native')?.text;
      requireValue(typeof nativeText === 'string' && sameNativeText(nativeText, native)
        && p.alternatives.find(a => a.source === 'ocr')?.text === clean(region.text), 'alternatives_changed');
    } else requireValue(p.alternatives.length === 0, 'alternatives_invalid');
    const agrees = similarity(nativeText, clean(region.text)) >= .75;
    const useNative = nativeText.length > 0 && (!clean(region.text) || !['table', 'figure', 'formula'].includes(block.kind) && agrees);
    requireValue(p.source === (useNative ? 'merged' : 'ocr')
      && block.text === (useNative ? nativeText : clean(region.text))
      && p.status === (nativeText && clean(region.text) && !agrees ? 'disputed' : 'selected'), 'selection_changed');
    if (p.status === 'disputed') {
      requireValue(page.fusion.warnings.includes(`recognition_disagreement:${region.id}`), 'warning_missing');
      if (!['table', 'figure', 'formula'].includes(block.kind)) {
        requireValue(native.every(item => page.fusion.provenance.some(other => other.source === 'native'
          && other.overlapGroupId === p.overlapGroupId && other.nativeItemIds.includes(item.id))), 'disputed_native_missing');
      }
    }
  }
  requireValue(primary.size === regions.size && [...items.values()].filter(item => clean(item.text))
    .every(item => represented.has(item.id)) && blocks.every(block => page.fusion.provenance.some(p => p.blockId === block.id)),
  'coverage_incomplete');
  return {nativeItems: items.size, representedItems: represented.size, regions: regions.size,
    contentHash: hash(stableNativeFusionValue({blocks, nativeItems: page.nativeTextItems, fusion: page.fusion}))};
}
