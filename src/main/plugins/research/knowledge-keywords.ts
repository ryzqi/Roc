import type {Database} from 'better-sqlite3';

/** Frozen v1: Han characters are positional tokens; a quoted sequence preserves substring order. */
export function keywordTextV1(text: string): string {
  return text.replace(/\p{Script=Han}+/gu, run=>` ${Array.from(run).join(' ')} `);
}
export function keywordQueryV1(query: string): string {
  return (query.match(/\p{Script=Han}+|[^\s\p{Script=Han}]+/gu) ?? [])
    .map(term=>keywordTextV1(term.replace(/"/gu,'')).trim()).filter(Boolean).map(term=>`"${term}"`).join(' OR ');
}
export function backfillKnowledgeKeywordsV1(db: Database): void {
  const insert=db.prepare('INSERT INTO research_knowledge_keywords(rowid,content,title) VALUES (?,?,?)');
  let after = -1;
  const read=db.prepare('SELECT c.rowid,c.content,d.title FROM research_knowledge_chunks c JOIN research_knowledge_documents d ON d.id=c.document_id WHERE c.rowid>? ORDER BY c.rowid LIMIT 256');
  for (;;) {
    const rows=read.all(after) as Array<{rowid:number;content:string;title:string}>;
    if (!rows.length) break;
    for (const row of rows) {
      insert.run(row.rowid, keywordTextV1(row.content), keywordTextV1(row.title));
      after=row.rowid;
    }
  }
}
