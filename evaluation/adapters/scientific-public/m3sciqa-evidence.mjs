import {readFileSync} from 'node:fs';
import {getDocument, version as pdfjsVersion} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {hash, sha256} from '../../lib/common.mjs';

export const m3EvidenceContract = {
  version: 'm3sciqa-original-pdf-text-alignment/1',
  normalization: 'per-codepoint-NFKC-alphabetic-line-end-dehyphenation-whitespace-collapse/1',
  readingOrder: 'original-pdfjs-text-item-order-per-page',
  matching: 'unique-full-normalized-contiguous-passage-in-complete-reference-pdf',
  minCharacters: 32,
  minWords: 6,
  geometry: 'whole-text-item-font-metric-quadrilateral/1',
  humanLocatorReview: false,
  pdfjsVersion,
  mapperHash: sha256(readFileSync(new URL(import.meta.url))),
};

/** Map normalized characters back to actual PDF text items, never infer PDF
 * coordinates from a string offset. NFKC expands ligatures per code point;
 * case, punctuation, math and word boundaries are retained. */
export function normalizedM3Text(items) {
  const units = [];
  for (const [itemIndex, item] of items.entries()) {
    let offset = 0;
    for (const char of item.str) {
      for (const normalized of char.normalize('NFKC')) {
        // Expand supplementary characters into UTF-16 units, matching indexOf.
        for (let i = 0; i < normalized.length; i++) {
          units.push({char: normalized[i], itemIndex, start: offset, end: offset + char.length});
        }
      }
      offset += char.length;
    }
    if (item.hasEOL) units.push({char: '\n', itemIndex: null, start: null, end: null});
  }
  const expanded = units.map(unit => unit.char).join(''), removed = new Set();
  // Only explicit PDF line breaks permit dehyphenation. No arbitrary hyphen
  // stripping, citation removal, formula conversion or fuzzy matching.
  for (const match of expanded.matchAll(/(?<=\p{L})-\s*\n\s*(?=\p{L})/gu)) {
    for (let i = match.index; i < match.index + match[0].length; i++) removed.add(i);
  }
  const normalized = [];
  for (const [i, unit] of units.entries()) {
    if (removed.has(i)) continue;
    if (/\s/u.test(unit.char)) {
      if (normalized.length && normalized.at(-1).char !== ' ') normalized.push({...unit, char: ' '});
    } else normalized.push(unit);
  }
  if (normalized.at(-1)?.char === ' ') normalized.pop();
  return {text: normalized.map(unit => unit.char).join(''), units: normalized};
}

function textItemGeometry(item, style, viewport) {
  const t = item.transform, length = Array.isArray(t) ? Math.hypot(t[0], t[1]) : 0;
  if (!Array.isArray(t) || t.length !== 6 || t.some(value => !Number.isFinite(value))
    || !length || item.dir !== 'ltr' || style?.vertical
    || !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent)
    || style.ascent <= style.descent || !Number.isFinite(item.width) || item.width <= 0) return null;
  const baseline = [item.width * t[0] / length, item.width * t[1] / length];
  const at = (advance, metric) => [t[4] + advance * baseline[0] + metric * t[2],
    t[5] + advance * baseline[1] + metric * t[3]];
  const pdfQuad = [at(0, style.descent), at(1, style.descent), at(1, style.ascent), at(0, style.ascent)];
  const quad = pdfQuad.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const bbox = [Math.min(...quad.map(p => p[0])), Math.min(...quad.map(p => p[1])),
    Math.max(...quad.map(p => p[0])), Math.max(...quad.map(p => p[1]))];
  if (bbox.some(value => !Number.isFinite(value)) || bbox[0] < 0 || bbox[1] < 0
    || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] > viewport.width || bbox[3] > viewport.height) return null;
  return {pdfQuad, viewportQuad: quad, bbox, coordinateOrigin: 'TOPLEFT',
    unit: 'raster-pixel', granularity: 'whole-text-item', humanLocatorReview: false};
}

/** Evaluator-only native extraction: independent of Roc parser output/models.
 * Unavailable font metrics or unsupported directions yield null geometry. */
export async function extractM3PdfText(bytes, sourceHash) {
  if (sha256(bytes) !== sourceHash) throw new Error('scientific_m3_evidence_source_changed');
  const loading = getDocument({data: new Uint8Array(bytes), useSystemFonts: true,
    isEvalSupported: false, verbosity: 0});
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 256) throw new Error('scientific_m3_evidence_page_budget');
    const pages = [];
    let characters = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber), viewport = page.getViewport({scale: 1});
      const content = await page.getTextContent();
      if (content.items.length > 50_000) throw new Error('scientific_m3_evidence_item_budget');
      const items = content.items.flatMap((item, originalIndex) => {
        if (typeof item.str !== 'string') return [];
        characters += item.str.length;
        const style = content.styles[item.fontName] ?? null;
        return [{originalIndex, str: item.str, dir: item.dir, transform: item.transform,
          width: item.width, height: item.height, fontName: item.fontName, hasEOL: item.hasEOL,
          style, geometry: item.str.trim() ? textItemGeometry(item, style, viewport) : null}];
      });
      if (characters > 20_000_000) throw new Error('scientific_m3_evidence_character_budget');
      pages.push({page: pageNumber, frame: {scale: 1, width: viewport.width, height: viewport.height,
        rotation: viewport.rotation, userUnit: viewport.userUnit, viewBox: viewport.viewBox,
        transform: viewport.transform}, items});
      page.cleanup();
    }
    return {sourceHash, pageCount: pages.length, pages};
  } finally {await loading.destroy();}
}

function selectedItems(page, normalized, start, end) {
  const intervals = new Map();
  for (const unit of normalized.units.slice(start, end)) {
    if (unit.itemIndex === null) continue;
    const interval = intervals.get(unit.itemIndex) ?? {start: unit.start, end: unit.end};
    interval.start = Math.min(interval.start, unit.start);
    interval.end = Math.max(interval.end, unit.end);
    intervals.set(unit.itemIndex, interval);
  }
  return [...intervals].filter(([index]) => page.items[index].str.trim()).map(([index, interval]) => {
    const item = page.items[index];
    return {itemIndex: index, originalIndex: item.originalIndex, utf16: [interval.start, interval.end],
      rawText: item.str, selectedText: item.str.slice(interval.start, interval.end),
      transform: item.transform, fontName: item.fontName, geometry: item.geometry};
  });
}

export function alignM3Evidence(label, document) {
  const evidence = label.original.evidence_reference;
  const needle = normalizedM3Text([{str: evidence, hasEOL: false}]).text;
  const identity = {id: label.id, publishedRow: label.publishedRow,
    referencePaperId: label.original.reference_arxiv_id, publishedEvidenceHash: sha256(evidence),
    normalizedEvidenceHash: sha256(needle), normalizedCharacters: needle.length};
  const result = (status, matches = []) => ({...identity, status, matches});
  if (!needle) return result('missing-published-evidence');
  if (!document) return result('source-unavailable');
  if (needle.length < m3EvidenceContract.minCharacters
    || (needle.match(/[\p{L}\p{N}]+/gu) ?? []).length < m3EvidenceContract.minWords) {
    return result('insufficient-exact-text');
  }
  const matches = [];
  for (const page of document.pages) {
    const normalized = normalizedM3Text(page.items);
    let at = 0;
    while ((at = normalized.text.indexOf(needle, at)) >= 0) {
      // Reject substring matches inside longer words at either boundary.
      const word = char => char !== undefined && /[\p{L}\p{N}]/u.test(char);
      const end = at + needle.length;
      if (!(word(needle[0]) && word(normalized.text[at - 1]))
        && !(word(needle.at(-1)) && word(normalized.text[end]))) {
        const items = selectedItems(page, normalized, at, end);
        matches.push({page: page.page, sourceHash: document.sourceHash, frame: page.frame,
          normalizedRange: [at, end], normalizedPassageHash: sha256(normalized.text.slice(at, end)),
          geometryAvailable: items.length > 0 && items.every(item => item.geometry !== null), items});
      }
      at++;
    }
  }
  if (!matches.length) return result('not-found');
  if (matches.length > 1) return result('ambiguous', matches);
  return result(matches[0].geometryAvailable ? 'unique-normalized-text-match' : 'geometry-unavailable', matches);
}

/** Compare reconstructed source-derived observations, not self-consistent
 * receipt hashes. This detects forged intervals or coordinates as well as drift. */
export function verifyM3EvidenceArtifact(actual, reconstructed) {
  if (hash(actual) !== hash(reconstructed)) throw new Error('scientific_m3_evidence_artifact_changed');
  return {verified: true, artifactHash: hash(reconstructed)};
}
