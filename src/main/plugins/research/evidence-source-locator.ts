import {spanLocator} from './knowledge-chunks';
import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {ResearchEvidence} from '../../../shared/types';
import {researchSourceLocatorSchema, type ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {storedDocumentContentSchema} from './document-repository';

/** Read the actual current indexed document/parse/block association without publishing evidence. */
export function readCurrentEvidenceSourceLocator(db: Database, evidence: ResearchEvidence): ResearchSourceLocator | null {
  const row = db.prepare(`SELECT p.id AS parse_id, p.document_id, p.status, p.data_json,
    d.source_hash, d.library_item_id, d.current_parse_id, c.chunk_index
    FROM research_document_parses p JOIN research_documents d ON d.id=p.document_id
    JOIN research_knowledge_chunks c ON c.document_id='document:' || p.id
    WHERE c.id=? AND c.document_id=?`).get(evidence.chunkId, evidence.documentId) as {
      parse_id: string; document_id: string; status: string; data_json: string | null;
      source_hash: string; library_item_id: string; current_parse_id: string | null; chunk_index: number
    } | undefined;
  if (row === undefined) return null;
  if (evidence.sourceType !== 'file' || evidence.sourceId !== row.library_item_id) {
    throw new Error('research_evidence_source_identity_invalid');
  }
  if (row.status !== 'ready' || row.data_json === null || row.current_parse_id !== row.parse_id) {
    throw new Error('research_evidence_source_parse_stale');
  }
  const parsed = storedDocumentContentSchema.parse(JSON.parse(row.data_json));
  if (parsed.content.sourceHash !== row.source_hash) throw new Error('research_evidence_source_hash_invalid');
  const structured = db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_knowledge_chunk_structure'").get();
  const child = structured ? db.prepare(`SELECT s.start_utf16,s.end_utf16,p.chunk_index,p.content,p.locator
    FROM research_knowledge_chunk_structure s JOIN research_knowledge_chunks p ON p.id=s.parent_chunk_id
    WHERE s.chunk_id=? AND p.document_id=?`).get(evidence.chunkId, evidence.documentId) as {
      start_utf16: number; end_utf16: number; chunk_index: number; content: string; locator: string
    } | undefined : undefined;
  const block = parsed.content.blocks.filter(block => block.text.trim())[child?.chunk_index ?? row.chunk_index];
  const textSpan = child ? {start: child.start_utf16, end: child.end_utf16} : undefined;
  if (block === undefined || (child && (child.content !== block.text || child.locator !== block.locator ||
      child.start_utf16 < 0 || child.end_utf16 > block.text.length || child.end_utf16 <= child.start_utf16)) ||
      (textSpan ? block.text.slice(textSpan.start, textSpan.end) : block.text) !== evidence.excerpt ||
      (textSpan ? spanLocator(block.locator, textSpan) : block.locator) !== evidence.locator) {
    throw new Error('research_evidence_source_block_invalid');
  }
  const locations = block.locations.map(location => {
    if (location.page > parsed.content.pageCount) throw new Error('research_evidence_source_page_invalid');
    // HTML blocks currently carry a zero box: it is a logical page, not a
    // measured rectangle. Preserve the page without claiming a usable region.
    const [left, top, right, bottom] = location.bbox;
    if (right === left && bottom === top) return {page: location.page, bbox: null, coordinateOrigin: null};
    if (right <= left || bottom <= top) throw new Error('research_evidence_source_region_invalid');
    return location;
  });
  return researchSourceLocatorSchema.parse({
    documentId: row.document_id, parseId: row.parse_id, knowledgeDocumentId: evidence.documentId,
    blockId: block.id, sourceHash: row.source_hash, parseHash: hash(JSON.stringify(parsed.content)),
    parserFingerprint: parsed.content.parserFingerprint, rawLocator: evidence.locator,
    locations, ...(textSpan ? {textSpan} : {})
  });
}

/** Capture only an actual managed document/parse/block association. Other sources stay unlocated. */
export function captureEvidenceSourceLocator(db: Database, evidence: ResearchEvidence, timestamp: string): void {
  const locator = readCurrentEvidenceSourceLocator(db, evidence);
  if (locator === null) return;
  const existing = inspectEvidenceSourceLocator(db, evidence.id);
  if (existing !== null && JSON.stringify(existing) !== JSON.stringify(locator)) {
    throw new Error('research_evidence_source_locator_conflict');
  }
  if (existing === null) {
    db.prepare('INSERT INTO research_evidence_source_locators (evidence_id,locator_json,captured_at) VALUES (?,?,?)')
      .run(evidence.id, JSON.stringify(locator), timestamp);
  }
}

/** Read the immutable captured location even after its old parse has been invalidated. */
export function inspectEvidenceSourceLocator(db: Database, evidenceId: string): ResearchSourceLocator | null {
  const row = db.prepare('SELECT locator_json FROM research_evidence_source_locators WHERE evidence_id=?')
    .get(evidenceId) as {locator_json: string} | undefined;
  return row === undefined ? null : researchSourceLocatorSchema.parse(JSON.parse(row.locator_json));
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
