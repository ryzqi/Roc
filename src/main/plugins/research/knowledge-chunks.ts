import {Tiktoken} from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';
import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {keywordTextV1} from './knowledge-keywords';

export const knowledgeChunkVersion = 'roc-structure-cl100k-1';
export const knowledgeChunkTokens = 512;
let tokenizer: Tiktoken | undefined;
export function chunkTokenCount(text: string): number {
  return (tokenizer ??= new Tiktoken(ranks)).encode(text, [], []).length;
}

export type TextSpan = {start: number; end: number; section: string | null};

/** Exact UTF-16 spans. Paragraph/heading boundaries are preferred; long lines remain bounded.
 * cl100k is a reproducible indexing budget, not a promise about every provider's tokenizer. */
export function structuredSpans(text: string, inheritedSection: string | null = null): TextSpan[] {
  const boundaries = new Set<number>([text.length]);
  const headings = new Map<number, string>();
  const hierarchy: string[] = [];
  for (const match of text.matchAll(/^([ \t]*#{1,6})[ \t]+([^\r\n]+)|\\(subsubsection|subsection|section)\{([^}]+)\}|(?:\r?\n|\r)[ \t]*(?:\r?\n|\r)/gmu)) {
    if (match[1] || match[3]) {
      const level = match[1] ? match[1].trim().length : ({section: 1, subsection: 2, subsubsection: 3}[match[3]!] ?? 1);
      hierarchy.length = level - 1;
      hierarchy[level - 1] = (match[2] ?? match[4]!).trim();
      headings.set(match.index, hierarchy.filter(Boolean).join(' / ').slice(0, 2000));
      boundaries.add(match.index);
    } else boundaries.add(match.index + match[0].length);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const spans: TextSpan[] = [];
  const headingPoints = [...headings.keys()];
  let start = 0, section = inheritedSection, boundaryIndex = 0, headingIndex = 0;
  while (start < text.length) {
    section = headings.get(start) ?? section;
    while (points[boundaryIndex]! <= start) boundaryIndex++;
    let end = Math.min(start + 2000, text.length);
    while (headingPoints[headingIndex] !== undefined && headingPoints[headingIndex]! <= start) headingIndex++;
    const nextHeading = headingPoints[headingIndex];
    if (nextHeading !== undefined) end = Math.min(end, nextHeading);
    const safeEnd = (value: number): number => value < text.length && /[\uD800-\uDBFF]/u.test(text[value - 1]!) ? value - 1 : value;
    end = safeEnd(end);
    const probeEnd = safeEnd(Math.min(start + 512, end));
    if (probeEnd < end && chunkTokenCount(text.slice(start, probeEnd)) > 160) end = probeEnd;
    while (chunkTokenCount(text.slice(start, end)) > knowledgeChunkTokens) end = safeEnd(start + Math.floor((end - start) * 0.75));
    // Prefer a whole paragraph when it fits; no decode/re-encode can alter original characters.
    let preferred = end;
    for (let i = boundaryIndex; points[i] !== undefined && points[i]! <= end; i++) preferred = points[i]!;
    if (preferred > start) end = preferred;
    spans.push({start, end, section});
    start = end;
  }
  return spans;
}

export function spanLocator(locator: string | null, span: Pick<TextSpan, 'start' | 'end'>): string {
  return `${locator ?? 'text'}; UTF-16 ${span.start + 1}-${span.end}`;
}

/** Add retrieval children without deleting historical parent identities or evidence. */
export function backfillStructuredChunks(db: Database): void {
  const maximum = db.prepare('SELECT coalesce(max(rowid),0) FROM research_knowledge_chunks').pluck().get() as number;
  let cursor = 0;
  while (cursor < maximum) {
    const rows = db.prepare(`SELECT c.rowid,c.*,d.title FROM research_knowledge_chunks c
      JOIN research_knowledge_documents d ON d.id=c.document_id WHERE c.rowid>? AND c.rowid<=? ORDER BY c.rowid LIMIT 128`)
      .all(cursor, maximum) as Array<{rowid: number; id: string; document_id: string; project_id: string | null;
        content: string; locator: string | null; created_at: string; title: string}>;
    if (!rows.length) break;
    for (const row of rows) {
      const spans = structuredSpans(row.content);
      if (!row.content.length) continue;
      db.prepare('INSERT INTO research_knowledge_chunk_structure VALUES (?,?,0,?,?)').run(row.id, null, row.content.length, spans[0]?.section ?? null);
      if (spans.length <= 1) continue;
      let index = db.prepare('SELECT max(chunk_index)+1 FROM research_knowledge_chunks WHERE document_id=?').pluck().get(row.document_id) as number;
      for (const span of spans) {
        const content = row.content.slice(span.start, span.end);
        if (!content.trim()) continue;
        const id = `${row.document_id}:chunk:${index}`;
        const inserted = db.prepare(`INSERT INTO research_knowledge_chunks
          (id,document_id,project_id,chunk_index,content,locator,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, row.document_id, row.project_id, index++, content, spanLocator(row.locator, span), createHash('sha256').update(content).digest('hex'), row.created_at);
        db.prepare('INSERT INTO research_knowledge_keywords(rowid,content,title) VALUES (?,?,?)')
          .run(inserted.lastInsertRowid, keywordTextV1(content), keywordTextV1(row.title));
        db.prepare('INSERT INTO research_knowledge_chunk_structure VALUES (?,?,?,?,?)').run(id, row.id, span.start, span.end, span.section);
      }
    }
    cursor = rows.at(-1)!.rowid;
  }
  // Every embedding input now includes document/section context, including short chunks.
  // Workspace files retain their own queue and selected configuration.
  db.prepare('DELETE FROM research_knowledge_embeddings').run();
  db.prepare(`INSERT INTO research_knowledge_jobs
    SELECT id,? || ':' || id,'queued',0,NULL,indexed_at FROM research_knowledge_documents
    WHERE coalesce(json_extract(metadata_json,'$.type'),'') <> 'project-index'
    ON CONFLICT(document_id) DO UPDATE SET generation=excluded.generation,status='queued',attempts=0,error=NULL,updated_at=excluded.updated_at`)
    .run(knowledgeChunkVersion);
  db.prepare("UPDATE research_index_files SET embedding_key='none'").run();
  db.prepare('UPDATE research_index_projects SET scan_requested=1').run();
}
