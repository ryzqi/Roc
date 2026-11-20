import type {ScientificCandidate} from '../../../shared/schemas/research-scientific-search';
import type {ScientificChunk} from './scientific-chunks';
import type {ScientificSearchPaper} from './scientific-search-snapshot';
import {researchContentHash} from './research-files';

/** Project raw object fields, never reverse-engineer cells or formula numbers from a chunk string. */
export function scientificChunkCandidate(paper: ScientificSearchPaper, chunk: ScientificChunk): Omit<ScientificCandidate, 'signals' | 'score'> {
  const {ir} = paper;
  let object: ScientificCandidate['object'] = {kind: 'text'};
  if (chunk.chunkType === 'table' || chunk.chunkType === 'table_row_group') {
    const table = ir.tables.find(t => t.id === chunk.objectId)!;
    const rows = chunk.selection.rows ?? table.data.rows.map(r => r.index);
    const included = new Set(chunk.sources.filter(s => ['header', 'cell'].includes(s.field)).map(s => s.locator.objectId));
    object = {kind: 'table', number: table.data.tableNumber ?? table.visual?.objectNumber ?? null,
      caption: table.data.caption, rows, columns: table.data.columns.map(({index, header, unit}) => ({index, header, unit})),
      cells: table.cells.filter(c => included.has(c.id)).map(c => {
        const raw = table.data.rows[c.row]!.cells.find(r => r.id === c.originalId)!;
        return {id: c.id, originalId: c.originalId, row: c.row, column: c.column, text: c.text,
          header: raw.header, rowSpan: raw.rowSpan, colSpan: raw.colSpan, sourceLocator: c.sourceLocator};
      }), footnotes: table.data.footnotes};
  } else if (chunk.chunkType === 'equation') {
    object = {kind: 'equation', data: ir.equations.find(e => e.id === chunk.objectId)!.data};
  } else if (chunk.chunkType === 'figure') {
    object = {kind: 'figure', data: ir.figures.find(f => f.id === chunk.objectId)!.data};
  } else if (chunk.chunkType === 'algorithm') {
    object = {kind: 'algorithm', stepIds: chunk.selection.steps ?? ir.algorithms.find(a => a.id === chunk.objectId)!.steps.map(s => s.id)};
  }
  return {id: `scientific-candidate:${researchContentHash(JSON.stringify([paper.generation.id, chunk.id]))}`,
    generationId: paper.generation.id, documentId: chunk.documentId, paperId: chunk.paperId, objectId: chunk.objectId,
    chunkId: chunk.id, objectType: chunk.chunkType, selection: chunk.selection, title: ir.metadata.title ?? ir.identity.paperId,
    sectionPath: chunk.sectionPath, semanticRoles: chunk.semantic.roles.map(r => r.role),
    content: chunk.content, contentHash: chunk.contentHash, sourceLocator: chunk.sourceLocator, sources: chunk.sources,
    relationIds: chunk.relationIds, object};
}

export function scientificMetadataCandidate(paper: ScientificSearchPaper): Omit<ScientificCandidate, 'signals' | 'score'> {
  const metadata = paper.ir.metadata, content = JSON.stringify(metadata), objectId = `metadata:${paper.ir.identity.paperId}`;
  return {id: `scientific-candidate:${researchContentHash(JSON.stringify([paper.generation.id, objectId]))}`,
    generationId: paper.generation.id, documentId: paper.ir.identity.documentId, paperId: paper.ir.identity.paperId,
    objectId, chunkId: null, selection: null, objectType: 'metadata',
    title: metadata.title ?? paper.ir.identity.paperId, sectionPath: [], semanticRoles: [],
    content, contentHash: researchContentHash(content), sourceLocator: null, sources: [], relationIds: [],
    object: {kind: 'metadata', metadata}};
}

export function scientificCitationCandidate(paper: ScientificSearchPaper,
  citation: Extract<ScientificCandidate['object'], {kind: 'citation'}>): Omit<ScientificCandidate, 'signals' | 'score'> {
  const content = JSON.stringify(citation.relation);
  const objectId = `citation:${researchContentHash(JSON.stringify([citation.snapshotId, citation.source, citation.relation]))}`;
  return {id: `scientific-candidate:${researchContentHash(JSON.stringify([paper.generation.id, objectId]))}`,
    generationId: paper.generation.id, documentId: paper.ir.identity.documentId, paperId: paper.ir.identity.paperId,
    objectId, chunkId: null, selection: null, objectType: 'citation',
    title: paper.ir.metadata.title ?? paper.ir.identity.paperId, sectionPath: [], semanticRoles: [],
    content, contentHash: researchContentHash(content), sourceLocator: null, sources: [], relationIds: [], object: citation};
}
