import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {chunkTokenCount} from './knowledge-chunks';

export type ScientificChunkType = 'paragraph' | 'table' | 'table_row_group' | 'figure' | 'equation' | 'algorithm' | 'caption';
export type ScientificSelection = {
  objectId: string; type: ScientificChunkType;
  span?: {start: number; end: number}; rows?: number[]; steps?: string[];
};
export type ScientificTextSource = {text: string; field: string; locator: ResearchSourceLocator};
export const scientificInputVersions: Record<ScientificChunkType, string> = {
  paragraph: 'roc-paper-text-v3', table: 'roc-paper-table-v1', table_row_group: 'roc-paper-table-rows-v1',
  figure: 'roc-paper-figure-caption-v1', equation: 'roc-paper-equation-v1',
  algorithm: 'roc-paper-algorithm-v1', caption: 'roc-paper-caption-v1'
};
export type ScientificSerializedText = {
  content: string; embeddingText: string; inputVersion: string; sources: ScientificTextSource[];
};
type Serialization = {content: string; body: string; sources: ScientificTextSource[]};
type Table = PaperIRV2['tables'][number];
type Figure = PaperIRV2['figures'][number];
type Equation = PaperIRV2['equations'][number];
type Algorithm = PaperIRV2['algorithms'][number];

function evidenceSource(ir: PaperIRV2, evidence: {blockId: string; text: string; textSpan: {start: number; end: number}},
  field: string): ScientificTextSource {
  const block = ir.blocks.find(b => b.blockId === evidence.blockId);
  if (!block || block.text.slice(evidence.textSpan.start, evidence.textSpan.end) !== evidence.text) {
    throw new Error('research_scientific_source_invalid');
  }
  return {text: evidence.text, field, locator: {...block.sourceLocator, textSpan: evidence.textSpan}};
}
function captions(ir: PaperIRV2, visual: Table['visual'] | Figure['data']): ScientificTextSource[] {
  return visual?.captions.filter(c => c.status === 'linked').map(c => evidenceSource(ir, c.evidence, 'caption')) ?? [];
}
export function serializeParagraph(ir: PaperIRV2, selection: ScientificSelection): Serialization {
  const block = ir.blocks.find(b => b.id === selection.objectId);
  if (!block) throw new Error('research_scientific_object_missing');
  const span = selection.span ?? {start: 0, end: block.text.length};
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end > block.text.length ||
      span.end < span.start) throw new Error('research_scientific_span_invalid');
  const content = block.text.slice(span.start, span.end);
  return {content, body: `Text:\n${content}`, sources: content ? [{
    text: content, field: selection.type === 'caption' ? 'caption' : 'text',
    locator: {...block.sourceLocator, textSpan: span}
  }] : []};
}
export function serializeTable(ir: PaperIRV2, table: Table, selectedRows?: readonly number[]): Serialization {
  const rows = selectedRows ?? table.data.rows.map(r => r.index);
  if (new Set(rows).size !== rows.length || rows.some(r => !table.data.rows[r])) throw new Error('research_scientific_rows_invalid');
  // Include anchors of merged cells intersecting the selected rows, even when their anchor is earlier.
  const raw = table.data.rows.flatMap(r => r.cells.map(c => ({...c, row: r.index})));
  const selected = raw.filter(c => rows.some(r => c.row <= r && r < c.row + c.rowSpan));
  const headerIds = new Set(table.data.columns.flatMap(c => c.headerCellIds));
  const headers = raw.filter(c => headerIds.has(c.id));
  const cells = new Map(table.cells.map(c => [c.originalId, c]));
  const cell = (id: string) => {
    const found = cells.get(id);
    if (!found) throw new Error('research_scientific_cell_missing');
    return found;
  };
  const sources = [...new Map([...headers, ...selected].map(c => {
    const original = cell(c.id);
    return [c.id, {text: c.text, field: headerIds.has(c.id) ? 'header' : 'cell', locator: original.sourceLocator}];
  })).values(), ...captions(ir, table.visual)];
  if (!sources.some(s => s.field === 'caption') && table.data.caption !== null) {
    sources.push({text: table.data.caption, field: 'html-caption', locator: table.sourceLocator});
  }
  for (const text of table.data.footnotes) sources.push({text, field: 'footnote', locator: table.sourceLocator});
  const content = selected.map(c => `Row ${c.row}, column ${c.column}, span ${c.rowSpan}x${c.colSpan}: ${c.text}`).join('\n');
  return {content, sources, body: [
    `Table Number: ${table.data.tableNumber ?? table.visual?.objectNumber ?? ''}`,
    `Structure: ${table.data.status}`,
    `Caption:\n${sources.filter(s => s.field.includes('caption')).map(s => s.text).join('\n')}`,
    `Columns:\n${table.data.columns.map(c => c.header).join(' | ')}`,
    `Rows:\n${content}`, `Footnotes:\n${table.data.footnotes.join('\n')}`
  ].join('\n')};
}
export function serializeTableRows(ir: PaperIRV2, table: Table, rows: readonly number[]): Serialization {
  return serializeTable(ir, table, rows);
}
export function serializeFigure(ir: PaperIRV2, figure: Figure): Serialization {
  const block = ir.blocks.find(b => b.blockId === figure.blockId)!;
  const sources = captions(ir, figure.data);
  if (block.text) sources.unshift({text: block.text, field: 'text', locator: block.sourceLocator});
  return {content: sources.map(s => s.text).join('\n'), sources,
    body: `Figure Number: ${figure.data.objectNumber ?? ''}\nCaption:\n${sources.map(s => s.text).join('\n')}`};
}
export function serializeEquation(ir: PaperIRV2, equation: Equation): Serialization {
  const content = equation.data.rawLatex ?? ir.blocks.find(b => b.blockId === equation.blockId)!.text;
  // Never split or truncate the mathematical body. Explanations are separate paragraph chunks.
  const sources: ScientificTextSource[] = [{text: content, field: 'latex', locator: equation.sourceLocator}];
  for (const variable of equation.data.variables) sources.push(evidenceSource(ir, variable.evidence, 'variable'));
  for (const context of equation.data.contexts) {
    // Bounded exact prefixes; the complete explanation remains independently indexed as original prose.
    let text = [...context.text].slice(0, 512).join('');
    while (chunkTokenCount(text) > 128) text = [...text].slice(0, Math.floor([...text].length * .75)).join('');
    if (text) sources.push(evidenceSource(ir, {...context, text,
      textSpan: {start: context.textSpan.start, end: context.textSpan.start + text.length}}, 'context'));
  }
  return {content, sources, body: `Equation Number: ${equation.data.equationNumber ?? ''}\nRecognition: ${equation.data.status}\nLaTeX:\n${content}\nVariables:\n${equation.data.variables.map(v => `${v.symbol}: ${v.definition}`).join('\n')}\nContext:\n${sources.filter(s => s.field === 'context').map(s => s.text).join('\n')}`};
}
export function serializeAlgorithm(algorithm: Algorithm, steps?: readonly string[]): Serialization {
  const selected = steps === undefined ? algorithm.steps : steps.map(id => {
    const step = algorithm.steps.find(s => s.id === id);
    if (!step) throw new Error('research_scientific_step_missing');
    return step;
  });
  if (new Set(selected.map(s => s.id)).size !== selected.length) throw new Error('research_scientific_steps_invalid');
  const content = steps === undefined ? algorithm.text : selected.map(s => s.text).join('\n');
  return {content, body: `Original Algorithm:\n${content}`,
    sources: selected.map(s => ({text: s.text, field: 'step', locator: s.sourceLocator}))};
}
export function serializeScientificChunk(ir: PaperIRV2, selection: ScientificSelection, sectionPath: readonly string[]): ScientificSerializedText {
  let value: Serialization;
  switch (selection.type) {
    case 'paragraph': case 'caption': value = serializeParagraph(ir, selection); break;
    case 'table': case 'table_row_group': {
      const table = ir.tables.find(t => t.id === selection.objectId);
      if (!table) throw new Error('research_scientific_object_missing');
      value = selection.type === 'table' ? serializeTable(ir, table) : serializeTableRows(ir, table, selection.rows ?? []);
      break;
    }
    case 'figure': {
      const object = ir.figures.find(o => o.id === selection.objectId);
      if (!object) throw new Error('research_scientific_object_missing');
      value = serializeFigure(ir, object); break;
    }
    case 'equation': {
      const object = ir.equations.find(o => o.id === selection.objectId);
      if (!object) throw new Error('research_scientific_object_missing');
      value = serializeEquation(ir, object); break;
    }
    case 'algorithm': {
      const object = ir.algorithms.find(o => o.id === selection.objectId);
      if (!object) throw new Error('research_scientific_object_missing');
      value = serializeAlgorithm(object, selection.steps); break;
    }
  }
  return {content: value.content, sources: value.sources, inputVersion: scientificInputVersions[selection.type],
    embeddingText: `Paper: ${ir.metadata.title ?? ''}\nSection: ${sectionPath.join(' / ')}\nType: ${selection.type}\n${value.body}`};
}
