import {hash} from './common.mjs';

/** Source/relationship verifier; does not import the production classifier or call a model. */
export function verifyScientificDocumentReading(originalBlocks, pages, annotatedBlocks) {
  const source = annotatedBlocks.map(({reading: _reading, ...block}) => block);
  const original = originalBlocks.map(({reading: _reading, ...block}) => block);
  if (hash(source) !== hash(original)) throw new Error('scientific_reading_source_changed');
  const frames = new Map(pages.filter(p => p.coordinateFrame?.kind === 'pdf').map(p => [p.page, p.coordinateFrame]));
  const ids = new Map(annotatedBlocks.map(b => [b.id, b]));
  if (ids.size !== annotatedBlocks.length) throw new Error('scientific_reading_duplicate_id');
  const roles = {}, links = [];
  for (const block of annotatedBlocks) {
    const a = block.reading;
    if (!a || a.version !== 1 || a.source !== 'rule' ||
        !['body', 'heading', 'caption', 'object', 'page_header', 'page_footer', 'page_number', 'unknown'].includes(a.role) ||
        !(a.ruleScore === null || Number.isFinite(a.ruleScore) && a.ruleScore >= 0 && a.ruleScore <= 1) ||
        !Array.isArray(a.signals) || a.signals.length > 8 || a.signals.some(s => typeof s !== 'string' || !s)) {
      throw new Error('scientific_reading_annotation_invalid');
    }
    roles[a.role] = (roles[a.role] ?? 0) + 1;
    if (a.role.startsWith('page_')) {
      const loc = block.locations.length === 1 && block.locations[0], frame = loc && frames.get(loc.page);
      if (!frame || loc.coordinateOrigin !== 'TOPLEFT' ||
          !(loc.bbox[3] <= frame.height * .12 || loc.bbox[1] >= frame.height * .88)) {
        throw new Error('scientific_reading_margin_geometry_invalid');
      }
    }
    if (a.role === 'object' && !['table', 'figure', 'formula'].includes(block.kind)) throw new Error('scientific_reading_object_invalid');
    for (const key of ['continuesFrom', 'continuesTo']) {
      const id = a[key];
      if (id === null) continue;
      const other = ids.get(id), forward = key === 'continuesTo';
      const here = block.locations.length === 1 && block.locations[0], there = other?.locations.length === 1 && other.locations[0];
      if (!other || id === block.id || a.role !== 'body' || other.reading?.role !== 'body' || !here || !there ||
          there.page !== here.page + (forward ? 1 : -1) || !frames.has(here.page) || !frames.has(there.page) ||
          other.reading[forward ? 'continuesFrom' : 'continuesTo'] !== block.id) throw new Error('scientific_reading_link_invalid');
      const first = forward ? block : other, second = forward ? other : block;
      const narrative = page => annotatedBlocks.filter(b => b.locations[0]?.page === page && b.text.trim() &&
        !b.reading.role.startsWith('page_'));
      if (narrative(first.locations[0].page).at(-1)?.id !== first.id || narrative(second.locations[0].page)[0]?.id !== second.id) {
        throw new Error('scientific_reading_link_boundary_invalid');
      }
      if (forward) links.push({from: first.id, to: second.id, pages: [here.page, there.page]});
    }
  }
  return {sourceHash: hash(original), annotationHash: hash(annotatedBlocks.map(b => ({id: b.id, reading: b.reading}))),
    blocks: annotatedBlocks.length, roles, links};
}
