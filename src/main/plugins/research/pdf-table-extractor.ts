import {parseDocument} from 'htmlparser2';
import {paperTableLimits, paperTableSchema, paperTableVersion, assertPaperTable, paperTableHeaderUnit,
  type NormalizedPaperTable} from '../../../shared/schemas/research-paper-table';

type HtmlNode = {name?: string; type?: string; data?: string; attribs?: Record<string, string>; children?: HtmlNode[]};
type TableBlock = {id: string; kind: string; text: string; locator: string; imagePath?: string | null;
  locations: Omit<NormalizedPaperTable['source'], 'locator'>[]};
type TableRegion = {id: string; table?: unknown; tableMatches?: unknown; rawHtml?: string};
const record = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input)
  ? input as Record<string, unknown> : {};
const text = (node: HtmlNode): string => ['script', 'style', 'template'].includes(node.name ?? '') ? ''
  : node.type === 'text' ? node.data ?? '' : (node.children ?? []).map(n => n.name === 'br' ? '\n' : text(n)).join('');
const clean = (node: HtmlNode): string => text(node).replace(/\s+/gu, ' ').trim();
function descendants(node: HtmlNode, name: string, depth = 0): HtmlNode[] {
  if (depth > 100) throw new Error('research_table_html_invalid');
  return [...(node.name === name ? [node] : []), ...(node.children ?? []).flatMap(n => descendants(n, name, depth + 1))];
}

/** Mechanical HTML grid extraction. No numeric values, labels or PDF boxes are inferred from text. */
export function extractPaperTable(block: TableBlock, region: TableRegion | null): NormalizedPaperTable {
  const location = block.locations[0];
  if (block.kind !== 'table' || !location || region && region.id !== block.id) throw new Error('research_table_binding_invalid');
  const structure = record(region?.table), matched = record(region?.tableMatches);
  const choices = [[matched.fullHtml, 'matched'], [matched.html, 'matched'],
    [structure.fullHtml, 'structure'], [structure.html, 'structure'],
    [region?.rawHtml, 'html']] as const;
  const choice = choices.find(([value]) => typeof value === 'string' && value.trim());
  const rawHtml = choice?.[0] as string | undefined;
  const result: NormalizedPaperTable = {version: paperTableVersion, id: `table:${block.id}`, blockId: block.id,
    status: rawHtml ? 'parsed' : 'missing', rawHtml: rawHtml ?? null, htmlSource: choice?.[1] ?? 'missing',
    tableNumber: null, caption: null, columns: [], rows: [], footnotes: [],
    assetId: null, imagePath: block.imagePath ?? null, source: {...location, locator: block.locator}, warnings: []};
  if (!rawHtml) {result.warnings.push('research_table_structure_missing'); return paperTableSchema.parse(result);}
  if (rawHtml.length > paperTableLimits.maxHtmlChars) throw new Error('research_table_html_too_large');
  try {
    const document = parseDocument(rawHtml) as HtmlNode;
    const tables = descendants(document, 'table');
    if (tables.length > 1) throw new Error('research_table_html_invalid');
    const root = tables[0] ?? document;
    if (tables.length && descendants(root, 'tr').length !== descendants(document, 'tr').length) throw new Error('research_table_html_invalid');
    const caption = descendants(root, 'caption');
    if (caption.length > 1) throw new Error('research_table_html_invalid');
    result.caption = caption[0] ? clean(caption[0]) || null : null;
    result.tableNumber = result.caption?.match(/^(?:Table|Tab\.?|表)\s*([A-Z]?\d+(?:[.-]\d+)*|[IVX]+)/iu)?.[1] ?? null;
    result.footnotes = descendants(root, 'tfoot').flatMap(n => descendants(n, 'tr').map(clean)).filter(Boolean);
    const footRows = new Set(descendants(root, 'tfoot').flatMap(n => descendants(n, 'tr')));
    const headerRows = new Set(descendants(root, 'thead').flatMap(n => descendants(n, 'tr')));
    const rows = descendants(root, 'tr').filter(n => !footRows.has(n));
    if (!rows.length || rows.length > paperTableLimits.maxAxis) throw new Error('research_table_grid_invalid');
    const occupied = new Set<string>(); let cellCount = 0, width = 0;
    for (const [rowIndex, row] of rows.entries()) {
      const cells: NormalizedPaperTable['rows'][number]['cells'] = []; let column = 0;
      for (const n of (row.children ?? []).filter(n => ['td', 'th'].includes(n.name ?? ''))) {
        if (++cellCount > paperTableLimits.maxCells) throw new Error('research_table_grid_invalid');
        while (occupied.has(`${rowIndex}:${column}`)) column++;
        const span = (key: string): number => {
          const raw = n.attribs?.[key] ?? '1';
          if (!/^[1-9]\d*$/u.test(raw)) throw new Error('research_table_grid_invalid');
          const value = Number(raw);
          if (value > paperTableLimits.maxAxis) throw new Error('research_table_grid_invalid');
          return value;
        };
        const rowSpan = span('rowspan'), colSpan = span('colspan');
        if (rowIndex + rowSpan > rows.length || column + colSpan > paperTableLimits.maxAxis) throw new Error('research_table_grid_invalid');
        for (let y = rowIndex; y < rowIndex + rowSpan; y++) for (let x = column; x < column + colSpan; x++) {
          if (occupied.has(`${y}:${x}`)) throw new Error('research_table_grid_invalid');
          occupied.add(`${y}:${x}`);
        }
        cells.push({id: `${result.id}:cell:${rowIndex}:${column}`, column, text: clean(n), rowSpan, colSpan,
          header: n.name === 'th' || headerRows.has(row), bbox: null});
        width = Math.max(width, column + colSpan); column += colSpan;
      }
      result.rows.push({index: rowIndex, cells});
    }
    if (!cellCount) throw new Error('research_table_grid_invalid');
    result.columns = Array.from({length: width}, (_, index) => {
      const headers = result.rows.flatMap(r => r.cells.filter(c => c.header && c.column <= index && index < c.column + c.colSpan));
      const header = headers.map(c => c.text).filter(Boolean).join(' / ');
      return {index, header, headerCellIds: headers.map(c => c.id),
        unit: paperTableHeaderUnit(headers.map(c => c.text))};
    });
    if (occupied.size < rows.length * width) result.warnings.push('research_table_ragged_grid');
    // SLANet boxes are measured in the region crop. Map only when every anchor cell has a box.
    const boxes = structure.bbox, anchors = result.rows.flatMap(r => r.cells);
    if (Array.isArray(boxes) && boxes.length === anchors.length && block.imagePath && location.bbox && location.coordinateOrigin === 'TOPLEFT') {
      for (const [i, cell] of anchors.entries()) {
        const box: unknown = boxes[i];
        if (!Array.isArray(box) || ![4, 8].includes(box.length) || box.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
          result.warnings.push('research_table_cell_coordinates_invalid'); break;
        }
        const xs = box.length === 4 ? [box[0], box[2]] : box.filter((_, i) => i % 2 === 0);
        const ys = box.length === 4 ? [box[1], box[3]] : box.filter((_, i) => i % 2 !== 0);
        const bbox: [number, number, number, number] = [Math.min(...xs) + location.bbox[0], Math.min(...ys) + location.bbox[1],
          Math.max(...xs) + location.bbox[0], Math.max(...ys) + location.bbox[1]];
        if (bbox[0] < location.bbox[0] || bbox[1] < location.bbox[1] || bbox[2] > location.bbox[2] ||
            bbox[3] > location.bbox[3] || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
          result.warnings.push('research_table_cell_coordinates_invalid'); break;
        }
        cell.bbox = bbox;
      }
      if (result.warnings.includes('research_table_cell_coordinates_invalid')) anchors.forEach(c => {c.bbox = null;});
    } else result.warnings.push('research_table_cell_coordinates_missing');
    result.warnings = [...new Set(result.warnings)];
    assertPaperTable(result, block.id, block.locator);
    return paperTableSchema.parse(result);
  } catch {
    return paperTableSchema.parse({...result, status: 'invalid', columns: [], rows: [], footnotes: [],
      caption: null, tableNumber: null, warnings: ['research_table_structure_invalid']});
  }
}

/** Bind saved structured regions by original block ID; missing structures remain explicit. */
export function attachPaperTables<T extends TableBlock>(blocks: readonly T[], pages: readonly {regions: unknown[]}[]): (T & {table?: NormalizedPaperTable})[] {
  const regions = new Map<string, TableRegion>();
  for (const page of pages) for (const value of page.regions) {
    const region = record(value);
    if (typeof region.id !== 'string') continue;
    if (regions.has(region.id)) throw new Error('research_table_binding_invalid');
    regions.set(region.id, region as TableRegion);
  }
  return blocks.map(block => block.kind === 'table'
    ? {...block, table: extractPaperTable(block, regions.get(block.id) ?? null)} : {...block});
}
