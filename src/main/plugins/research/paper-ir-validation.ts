import {paperIrV2Schema, paperObjectId, type PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {assertPaperStructure} from '../../../shared/schemas/research-paper-structure';
import {assertPaperTableBlock} from '../../../shared/schemas/research-paper-table';
import {assertPaperEquationBlock, assertEquationEvidence} from '../../../shared/schemas/research-paper-equation';
import {assertPaperVisualBlock, assertPaperVisualEvidence} from '../../../shared/schemas/research-paper-visual';

export function paperIRObjects(ir: PaperIRV2) {
  return [...ir.sections, ...ir.blocks, ...ir.tables, ...ir.tables.flatMap(t => t.cells), ...ir.figures,
    ...ir.equations, ...ir.algorithms, ...ir.algorithms.flatMap(a => a.steps), ...ir.citations, ...ir.references];
}
/** Verify internal source bindings even when reading an artifact without its original parse in memory. */
export function validatePaperIR(input: unknown): PaperIRV2 {
  const ir = paperIrV2Schema.parse(input), objects = paperIRObjects(ir), ids = new Set(objects.map(o => o.id));
  const raw = ir.blocks.map(b => ({id: b.blockId, text: b.text, kind: b.kind, locator: b.sourceLocator.rawLocator,
    locations: b.sourceLocator.locations}));
  const blocks = new Map(raw.map(b => [b.id, b]));
  const fail = (): never => {throw new Error('research_paper_ir_binding_invalid');};
  if (ids.size !== objects.length || blocks.size !== raw.length) fail();
  assertPaperStructure(ir.structure, raw);
  const objectId = (kind: string, originalId: string) => paperObjectId(kind, ir.identity.parseId, originalId);
  const checkLocator = (l: ResearchSourceLocator, objectId?: string): void => {
    const b = blocks.get(l.blockId);
    if (!b || l.documentId !== ir.identity.documentId || l.parseId !== ir.identity.parseId ||
        l.knowledgeDocumentId !== ir.identity.knowledgeDocumentId || l.sourceHash !== ir.identity.sourceHash ||
        l.parseHash !== ir.identity.parseHash || l.parserFingerprint !== ir.identity.parserFingerprint ||
        l.rawLocator !== b.locator || l.parentBlockId !== b.id || objectId && l.objectId !== objectId ||
        !l.objectId || !ids.has(l.objectId) ||
        l.textSpan && (l.textSpan.end > b.text.length || l.textSpan.start >= l.textSpan.end)) fail();
  };
  for (const o of objects) {
    checkLocator(o.sourceLocator, o.id);
    if (o.blockId !== o.sourceLocator.blockId) fail();
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const cellIds = new Set(ir.tables.flatMap(t => t.cells.map(c => c.id)));
  for (const o of objects) if (!cellIds.has(o.id) &&
      !same(o.sourceLocator.locations, blocks.get(o.blockId)!.locations)) fail();
  for (const b of ir.blocks) {
    const annotation = ir.structure.blocks.find(a => a.blockId === b.blockId)!;
    if (b.id !== objectId('block', b.blockId) || b.originalId !== b.blockId ||
        !same(b.sectionIds, annotation.sectionIds.map(id => objectId('section', id))) ||
        !same(b.semantic, annotation.semantic) || b.sourceLocator.textSpan) fail();
  }
  for (const s of ir.sections) {
    const source = ir.structure.sections.find(v => v.id === s.originalId);
    if (!source || s.id !== objectId('section', source.id) || s.blockId !== source.blockId ||
        s.title !== source.title || s.level !== source.level || s.category !== source.category ||
        s.parentId !== (source.parentId === null ? null : objectId('section', source.parentId)) ||
        !same(s.sourceLocator.textSpan, {start: source.start, end: source.end})) fail();
  }
  if (ir.sections.length !== ir.structure.sections.length) fail();
  for (const t of ir.tables) {
    const b = blocks.get(t.blockId)!;
    if (t.id !== objectId('table', b.id) || !same(t.sourceLocator.locations, b.locations)) fail();
    assertPaperTableBlock({...b, table: t.data});
    const cells = t.data.rows.flatMap(r => r.cells.map(c => ({...c, row: r.index})));
    if (t.cells.length !== cells.length) fail();
    for (const [i, c] of t.cells.entries()) {
      const source = cells[i]!;
      if (c.id !== objectId('cell', source.id) || c.originalId !== source.id || c.text !== source.text ||
          c.row !== source.row || c.column !== source.column || c.blockId !== b.id ||
          c.sourceLocator.textSpan || c.geometry !== (source.bbox === null ? 'unknown' : 'cell') || !same(c.sourceLocator.locations,
            [{page: t.data.source.page, bbox: source.bbox, coordinateOrigin: source.bbox ? t.data.source.coordinateOrigin : null}])) fail();
    }
  }
  const visuals = [...ir.figures.map(f => ({...blocks.get(f.blockId)!, visual: f.data})),
    ...ir.tables.flatMap(t => t.visual ? [{...blocks.get(t.blockId)!, visual: t.visual}] : [])];
  for (const f of ir.figures) if (f.id !== objectId('figure', f.blockId) ||
      !same(f.sourceLocator.locations, blocks.get(f.blockId)!.locations)) fail();
  visuals.forEach(assertPaperVisualBlock);
  assertPaperVisualEvidence(raw.map(b => ({...b, visual: visuals.find(v => v.id === b.id)?.visual})));
  for (const e of ir.equations) {
    const b = blocks.get(e.blockId)!;
    if (e.id !== objectId('equation', b.id) || !same(e.sourceLocator.locations, b.locations)) fail();
    assertPaperEquationBlock({...b, equation: e.data});
    for (const evidence of [...e.data.contexts, ...e.data.references.map(r => r.evidence),
      ...e.data.variables.map(v => v.evidence), ...(e.data.numberEvidence?.kind === 'block' ? [e.data.numberEvidence.evidence] : [])]) {
      assertEquationEvidence(evidence, raw);
    }
  }
  for (const a of ir.algorithms) {
    if (a.id !== objectId('algorithm', a.blockId) || a.text !== blocks.get(a.blockId)!.text) fail();
    const lines = [...a.text.matchAll(/(?:^|\n)([^\n]+)/gu)].filter(m => m[1]!.trim());
    if (a.steps.length !== lines.length) fail();
    for (const [i, step] of a.steps.entries()) {
      const line = lines[i]!, start = line.index + line[0].length - line[1]!.length;
      if (!same(step.sourceLocator.textSpan, {start, end: start + line[1]!.length})) fail();
    }
    for (const step of a.steps) if (step.id !== objectId('algorithm-step', `${a.blockId}:${step.sourceLocator.textSpan?.start}`) ||
        step.blockId !== a.blockId || !step.sourceLocator.textSpan ||
        a.text.slice(step.sourceLocator.textSpan.start, step.sourceLocator.textSpan.end) !== step.text) fail();
  }
  for (const c of [...ir.citations, ...ir.references]) {
    const b = blocks.get(c.blockId)!, span = c.sourceLocator.textSpan;
    if (!span || b.text.slice(span.start, span.end) !== c.text) fail();
    if (c.origin === 'original-numbered') {
      const kind = 'number' in c ? 'reference' : 'citation';
      if (c.id !== objectId(kind, `${c.blockId}:${span!.start}`)) fail();
      if ('number' in c && c.number !== /^\s*\[(\d{1,5})\]/u.exec(c.text)?.[1]) fail();
    }
  }
  const referenceIds = new Set(ir.references.map(r => r.id));
  for (const c of ir.citations) if (c.targetIds.some(id => !referenceIds.has(id)) ||
    c.status === 'linked' && (!c.targetIds.length || c.unresolvedTargets.length)) fail();
  if (new Set(ir.relations.map(r => r.id)).size !== ir.relations.length) fail();
  const objectsById = new Map(objects.map(object => [object.id, object]));
  for (const r of ir.relations) {
    checkLocator(r.sourceLocator);
    const source = objectsById.get(r.sourceLocator.objectId!);
    if (!source || source.blockId !== r.sourceLocator.blockId ||
        !same(source.sourceLocator.locations, r.sourceLocator.locations)) fail();
    if (!ids.has(r.fromId) || !ids.has(r.toId) || r.fromId === r.toId) fail();
    if (r.id !== objectId('relation', `${r.type}:${r.fromId}:${r.toId}:${r.sourceLocator.textSpan?.start ?? ''}`)) fail();
  }
  return ir;
}
