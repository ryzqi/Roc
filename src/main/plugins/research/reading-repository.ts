import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {readingNoteSchema, readingHighlightSchema, readingNoteSaveSchema, readingHighlightSaveSchema,
  type ReadingNote, type ReadingHighlight} from '../../../shared/schemas/research-reading';
import type {ResearchRepository} from './repository';

/** Personal notes are mutable; they never mutate or approve scientific evidence. */
export class ReadingRepository {
  constructor(readonly db: Database, readonly research: ResearchRepository,
    readonly now: () => string = () => new Date().toISOString()) {}
  scope(projectId: string, write = false): void {
    const project = this.research.getProject(projectId);
    if (write && project.status === 'archived') throw new Error('已归档项目不能修改阅读资料。');
  }
  notes(projectId: string): ReadingNote[] {
    this.scope(projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_reading_notes WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as {snapshot_json: string}[])
      .map(row => readingNoteSchema.parse(JSON.parse(row.snapshot_json)));
  }
  saveNote(raw: z.infer<typeof readingNoteSaveSchema>): ReadingNote {
    const input = readingNoteSaveSchema.parse(raw);
    this.scope(input.projectId, true);
    if (input.itemId !== null && !this.research.library.get(input.itemId).projectIds.includes(input.projectId))
      throw new Error('笔记关联文献不属于当前项目。');
    return this.db.transaction(() => {
      const prior = this.notes(input.projectId).find(note => note.id === input.id);
      if ((prior?.revision ?? 0) !== input.expectedRevision) throw new Error('笔记已在其他窗口修改，请重读后再保存；当前草稿仍保留。');
      const titleKey = input.title.normalize('NFKC').toLocaleLowerCase();
      if (!input.archived && this.notes(input.projectId).some(note => note.id !== input.id && !note.archived &&
        note.title.normalize('NFKC').toLocaleLowerCase() === titleKey)) throw new Error('此项目已有同名笔记，请使用不同标题。');
      const {expectedRevision, ...body} = input;
      const note = readingNoteSchema.parse({...body, revision: expectedRevision + 1, createdAt: prior?.createdAt ?? this.now(),
        updatedAt: this.now(), links: [...new Set([...input.markdown.matchAll(/\[\[([^\]\n]+)\]\]/gu)].map(match => match[1]!.trim()))]});
      this.db.prepare(`INSERT INTO research_reading_notes(id,project_id,revision,updated_at,snapshot_json) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,snapshot_json=excluded.snapshot_json
        WHERE research_reading_notes.project_id=excluded.project_id`).run(note.id,note.projectId,note.revision,note.updatedAt,JSON.stringify(note));
      const stored = this.notes(input.projectId).find(value => value.id === input.id);
      if (stored === undefined) throw new Error('笔记 ID 已用于其他项目。');
      return stored;
    })();
  }
  highlights(projectId: string, documentId: string, sourceHash: string): ReadingHighlight[] {
    this.scope(projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_reading_highlights WHERE project_id=? AND document_id=? AND source_hash=?')
      .all(projectId, documentId, sourceHash) as {snapshot_json: string}[]).map(row => readingHighlightSchema.parse(JSON.parse(row.snapshot_json)));
  }
  saveHighlight(raw: z.infer<typeof readingHighlightSaveSchema>): ReadingHighlight {
    const input = readingHighlightSaveSchema.parse(raw);
    this.scope(input.projectId, true);
    const document = this.research.documents.get(input.documentId);
    if (document.sourceHash !== input.sourceHash || !this.research.library.get(document.libraryItemId).projectIds.includes(input.projectId))
      throw new Error('原文版本已变化或不属于当前项目。');
    return this.db.transaction(() => {
      const prior = this.highlights(input.projectId, input.documentId, input.sourceHash).find(value => value.id === input.id);
      if ((prior?.revision ?? 0) !== input.expectedRevision) throw new Error('高亮已更新，请重读。');
      const {expectedRevision, ...body} = input;
      const value = readingHighlightSchema.parse({...body, revision: expectedRevision + 1, createdAt: prior?.createdAt ?? this.now()});
      const result = this.db.prepare(`INSERT INTO research_reading_highlights(id,project_id,document_id,source_hash,snapshot_json) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json WHERE research_reading_highlights.project_id=excluded.project_id
        AND research_reading_highlights.document_id=excluded.document_id AND research_reading_highlights.source_hash=excluded.source_hash`)
        .run(value.id,value.projectId,value.documentId,value.sourceHash,JSON.stringify(value));
      if (result.changes !== 1) throw new Error('高亮 ID 冲突。');
      return value;
    })();
  }
}
