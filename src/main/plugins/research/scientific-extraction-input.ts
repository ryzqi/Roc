import type {ScientificExtractionBatch} from './scientific-extraction-batches';

type CellReferences = {encode: Map<string, string>; decode: Map<string, string>};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** UTF-16 boundaries retain all original whitespace between selected non-whitespace tokens. */
export function scientificNameTokens(text: string): Array<{text: string; start: number; end: number}> {
  return [...text.matchAll(/\S+/gu)].map(match =>
    ({text: match[0], start: match.index, end: match.index + match[0].length}));
}
function nameTokenInventory(input: Record<string, unknown>, text: string, direction: 'encode' | 'decode'): Record<string, unknown> {
  const nameTokens = scientificNameTokens(text).map((token, index) => [index, token.text]);
  if (direction === 'encode') return {...input, nameTokens};
  if (JSON.stringify(input.nameTokens) !== JSON.stringify(nameTokens)) {
    throw new Error('research_scientific_extraction_name_input_invalid');
  }
  const {nameTokens: _, ...original} = input;
  return original;
}

/** Cell handles are private to one complete table. Original IDs and source validation stay server-owned. */
export function scientificExtractionInput(batch: Pick<ScientificExtractionBatch, 'blocks' | 'objects'>,
  options: {textSelections?: boolean; nameSelections?: boolean} = {}): {
  encode: (input: unknown) => unknown; decode: (output: unknown) => unknown;
  cellHandle: (tableId: string, cellId: string) => string;
} {
  const textSources = new Map<string, {kind: 'text'; blockId: string; start: number; end: number; quote: string}>();
  if (options.textSelections) {
    for (const [index, block] of batch.blocks.entries()) {
      if (!block.text) continue;
      if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 0 ||
        block.end - block.start !== block.text.length) {
        throw new Error('research_scientific_extraction_text_input_invalid');
      }
      textSources.set(`text-${index}`, {kind: 'text', blockId: block.blockId,
        start: block.start, end: block.end, quote: block.text});
    }
  }
  const tables = new Map<string, CellReferences>();
  for (const object of batch.objects) {
    if (object.objectType !== 'Table') continue;
    if (!record(object.content) || !Array.isArray(object.content.cells) || tables.has(object.objectId)) {
      throw new Error('research_scientific_extraction_table_input_invalid');
    }
    const encode = new Map<string, string>(), decode = new Map<string, string>();
    for (const [index, cell] of object.content.cells.entries()) {
      if (!record(cell) || typeof cell.id !== 'string' || encode.has(cell.id)) {
        throw new Error('research_scientific_extraction_table_input_invalid');
      }
      const handle = `cell-${index}`;
      encode.set(cell.id, handle); decode.set(handle, cell.id);
    }
    tables.set(object.objectId, {encode, decode});
  }
  const transform = (input: unknown, direction: 'encode' | 'decode', table?: CellReferences): unknown => {
    if (Array.isArray(input)) return input.map(item => transform(item, direction, table));
    if (!record(input)) return input;
    if (direction === 'decode' && options.textSelections && input.kind === 'text_span') {
      const source = typeof input.textId === 'string' ? textSources.get(input.textId) : undefined;
      if (!source || Object.keys(input).length !== 2) {
        throw new Error('research_scientific_extraction_text_not_supplied');
      }
      return {...source};
    }
    const result: Record<string, unknown> = {...input};
    const sourceTable = typeof input.tableId === 'string' ? tables.get(input.tableId) : undefined;
    for (const [key, value] of Object.entries(input)) {
      if (key === 'blocks' && options.textSelections && Array.isArray(value)) {
        result[key] = value.map((block, index) => {
          if (!record(block)) throw new Error('research_scientific_extraction_text_input_invalid');
          const textId = `text-${index}`, source = textSources.get(textId);
          if (!source) return transform(block, direction, table);
          if (block.blockId !== source.blockId || block.start !== source.start || block.end !== source.end ||
            block.text !== source.quote) throw new Error('research_scientific_extraction_text_input_invalid');
          if (direction === 'encode') return options.nameSelections ?
            nameTokenInventory({...block, textId}, source.quote, direction) : {...block, textId};
          if (block.textId !== textId) throw new Error('research_scientific_extraction_text_input_invalid');
          const {textId: _, ...original} = block;
          return options.nameSelections ? nameTokenInventory(original, source.quote, direction) : original;
        });
      } else if (key === 'cellId' && sourceTable && typeof value === 'string') {
        const resolved = sourceTable[direction].get(value);
        if (resolved === undefined) throw new Error('research_scientific_extraction_cell_not_supplied');
        result[key] = resolved;
      } else if (key === 'resultEvidenceScopes' && Array.isArray(value)) {
        result[key] = value.map(scope => {
          if (!record(scope) || typeof scope.tableId !== 'string' || !tables.has(scope.tableId)) {
            throw new Error('research_scientific_extraction_table_input_invalid');
          }
          return transform(scope, direction, tables.get(scope.tableId));
        });
      } else if (key === 'content' && input.objectType === 'Table' && typeof input.objectId === 'string') {
        const content = transform(value, direction, tables.get(input.objectId));
        if (!record(content) || !Array.isArray(content.cells)) {
          throw new Error('research_scientific_extraction_table_input_invalid');
        }
        if (direction === 'encode') {
          result[key] = {...content, cellDefaults: {rowSpan: 1, colSpan: 1, header: false},
            cells: content.cells.map(cell => {
              if (!record(cell)) throw new Error('research_scientific_extraction_table_input_invalid');
              const compact = {...cell};
              if (cell.rowSpan === 1) delete compact.rowSpan;
              if (cell.colSpan === 1) delete compact.colSpan;
              if (cell.header === false) delete compact.header;
              if (options.nameSelections) {
                if (typeof cell.text !== 'string') throw new Error('research_scientific_extraction_table_input_invalid');
                return nameTokenInventory(compact, cell.text, direction);
              }
              return compact;
            })};
        } else {
          const {cellDefaults, ...original} = content;
          if (!record(cellDefaults) || cellDefaults.rowSpan !== 1 || cellDefaults.colSpan !== 1 ||
            cellDefaults.header !== false || Object.keys(cellDefaults).length !== 3) {
            throw new Error('research_scientific_extraction_table_input_invalid');
          }
          result[key] = {...original, cells: content.cells.map(cell => {
            if (!record(cell)) throw new Error('research_scientific_extraction_table_input_invalid');
            if (options.nameSelections) {
              if (typeof cell.text !== 'string') throw new Error('research_scientific_extraction_table_input_invalid');
              return {...cellDefaults, ...nameTokenInventory(cell, cell.text, direction)};
            }
            return {...cellDefaults, ...cell};
          })};
        }
      } else if (table && key === 'id' && typeof value === 'string') {
        result[key] = table[direction].get(value) ?? value;
      } else if (table && ['cells', 'headerCellIds', 'conditionCellIds', 'cellIds'].includes(key) && Array.isArray(value)) {
        result[key] = value.map(item => {
          if (typeof item !== 'string') return transform(item, direction, table);
          const resolved = table[direction].get(item);
          if (resolved === undefined) throw new Error('research_scientific_extraction_cell_not_supplied');
          return resolved;
        });
      } else {
        result[key] = transform(value, direction, table);
      }
    }
    return result;
  };
  return {
    encode: input => transform(input, 'encode'),
    decode: output => transform(output, 'decode'),
    cellHandle: (tableId, cellId) => {
      const handle = tables.get(tableId)?.encode.get(cellId);
      if (handle === undefined) throw new Error('research_scientific_extraction_cell_not_supplied');
      return handle;
    }
  };
}
