import {z} from 'zod';

export const paperTableVersion = 'roc-paper-table/1';
export const paperTableLimits = {maxHtmlChars: 4 * 1024 * 1024, maxCells: 10_000, maxAxis: 1000} as const;
const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(b => b[0] <= b[2] && b[1] <= b[3], 'research_table_coordinates_invalid');
const cell = z.object({
  id: z.string().min(1), column: z.number().int().nonnegative(), text: z.string(),
  rowSpan: z.number().int().min(1).max(paperTableLimits.maxAxis),
  colSpan: z.number().int().min(1).max(paperTableLimits.maxAxis),
  header: z.boolean(), bbox: bbox.nullable()
}).strict();
const tableShape = z.object({
  version: z.literal(paperTableVersion), id: z.string().min(1), blockId: z.string().min(1),
  status: z.enum(['parsed', 'missing', 'invalid']),
  rawHtml: z.string().max(paperTableLimits.maxHtmlChars).nullable(),
  htmlSource: z.enum(['matched', 'structure', 'html', 'missing']),
  tableNumber: z.string().nullable(), caption: z.string().nullable(),
  columns: z.array(z.object({index: z.number().int().nonnegative(), header: z.string(),
    headerCellIds: z.array(z.string()), unit: z.string().nullable()}).strict()).max(paperTableLimits.maxAxis),
  rows: z.array(z.object({index: z.number().int().nonnegative(), cells: z.array(cell).max(paperTableLimits.maxCells)}).strict())
    .max(paperTableLimits.maxAxis),
  footnotes: z.array(z.string()).max(paperTableLimits.maxAxis),
  assetId: z.string().nullable(), imagePath: z.string().nullable(),
  source: z.object({locator: z.string(), page: z.number().int().positive(),
    bbox, coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT'])}).strict(),
  warnings: z.array(z.string()).max(100)
}).strict();
export type NormalizedPaperTable = z.infer<typeof tableShape>;
/** Only units explicitly printed in header parentheses/brackets; conflicting units stay unknown. */
export function paperTableHeaderUnit(headers: readonly string[]): string | null {
  const units = [...new Set(headers.map(header => header.match(
    /(?:\((%|ms|s|kg|g|mm|cm|m|K|°C|MB|GB|Hz)\)|\[([^\][\n]{1,30})\])\s*$/u
  )?.slice(1).find(Boolean)).filter((unit): unit is string => Boolean(unit)))];
  return units.length === 1 ? units[0]! : null;
}
export const paperTableSchema = tableShape.superRefine((value, context) => {
  try {validateGrid(value);}
  catch (error) {context.addIssue({code: 'custom', message: (error as Error).message});}
});

function validateGrid(value: NormalizedPaperTable): void {
  if (value.id !== `table:${value.blockId}` ||
      (value.status !== 'parsed' && (value.rows.length || value.columns.length)) ||
      (value.status === 'parsed' && (!value.rows.length || !value.columns.length || !value.rawHtml)) ||
      (value.status === 'missing' && (value.rawHtml !== null || value.htmlSource !== 'missing')) ||
      (value.status !== 'missing' && (!value.rawHtml || value.htmlSource === 'missing'))) throw new Error('research_table_binding_invalid');
  const occupied = new Set<string>(), ids = new Set<string>();
  for (const [r, row] of value.rows.entries()) {
    if (row.index !== r) throw new Error('research_table_grid_invalid');
    for (const cell of row.cells) {
      if (ids.has(cell.id) || cell.id !== `${value.id}:cell:${r}:${cell.column}` ||
          r + cell.rowSpan > value.rows.length || cell.column + cell.colSpan > value.columns.length) throw new Error('research_table_grid_invalid');
      ids.add(cell.id);
      if (cell.bbox && (cell.bbox[0] < value.source.bbox[0] || cell.bbox[1] < value.source.bbox[1] ||
          cell.bbox[2] > value.source.bbox[2] || cell.bbox[3] > value.source.bbox[3] ||
          cell.bbox[0] >= cell.bbox[2] || cell.bbox[1] >= cell.bbox[3])) throw new Error('research_table_coordinates_invalid');
      for (let y = r; y < r + cell.rowSpan; y++) for (let x = cell.column; x < cell.column + cell.colSpan; x++) {
        const key = `${y}:${x}`;
        if (occupied.has(key)) throw new Error('research_table_grid_invalid');
        occupied.add(key);
      }
    }
  }
  if (ids.size > paperTableLimits.maxCells || value.columns.some((c, i) => {
    const headers = value.rows.flatMap(r => r.cells.filter(cell => cell.header && cell.column <= i && i < cell.column + cell.colSpan));
    return c.index !== i || JSON.stringify(c.headerCellIds) !== JSON.stringify(headers.map(h => h.id)) ||
      c.header !== headers.map(h => h.text).filter(Boolean).join(' / ') ||
      c.unit !== paperTableHeaderUnit(headers.map(h => h.text));
  })) throw new Error('research_table_grid_invalid');
}

/** Validate identity and measured source geometry wherever a table accompanies its block. */
export function assertPaperTable(table: NormalizedPaperTable, blockId: string, locator: string): void {
  const value = paperTableSchema.parse(table);
  if (value.blockId !== blockId || value.source.locator !== locator) throw new Error('research_table_binding_invalid');
}
export function assertPaperTableBlock(block: {id: string; kind: string; locator: string; table?: NormalizedPaperTable;
  locations?: Omit<NormalizedPaperTable['source'], 'locator'>[]; imagePath?: string | null; imageAssetId?: string | null}): void {
  if (!block.table) return; // Historical parses retain their original contract.
  assertPaperTable(block.table, block.id, block.locator);
  if (block.kind !== 'table' || (block.locations && !block.locations.some(location =>
    location.page === block.table!.source.page && location.coordinateOrigin === block.table!.source.coordinateOrigin &&
    location.bbox.every((v, i) => v === block.table!.source.bbox[i]))) ||
    (block.imagePath !== undefined && (block.table.imagePath !== block.imagePath || block.table.assetId !== null)) ||
    (block.imageAssetId !== undefined && block.table.assetId !== block.imageAssetId)) throw new Error('research_table_binding_invalid');
}
