import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { z } from 'zod';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import {
  researchBibliographyEntrySchema, researchLibraryItemSchema, type researchLibraryListRequestSchema
} from '../../../shared/schemas/research-library';
import type { ResearchLiterature } from '../../../shared/types';
import { citationKeySet } from './cite-key';
import { bibliographyIdentity, literatureIdentity, normalizeResearchDoi } from './literature-identity';
import type { ResearchRepository } from './repository';

export type LibraryItem = z.infer<typeof researchLibraryItemSchema>;
export type BibliographyEntry = z.infer<typeof researchBibliographyEntrySchema>;
type LibraryRow = { id: string; identity_key: string; metadata_json: string; bibliography_json: string; sources_json: string;
  revision: number; archived: number; created_at: string; updated_at: string };

/** 库里的 JSON 列：先按结构收窄，形状由各处的 zod schema 决定。 */
type JsonColumn = string | number | boolean | null | JsonColumn[] | { [key: string]: JsonColumn };

/**
 * 读一个 JSON 列。
 *
 * `JSON.parse` 会抛，而「库里有一条被写坏的记录」不该以 `SyntaxError` 的形式冒到界面上：
 * 它是存储层的领域错误（`research_library_storage_invalid`），调用方按 `degraded` 处理。
 */
function readJsonColumn(value: string): JsonColumn {
  try { return JSON.parse(value) as JsonColumn; }
  catch { throw new Error('research_library_storage_invalid'); }
}

export class ResearchLibraryRepository {
  onChanged?: (items: LibraryItem[], changeKind: 'import' | 'link' | 'archive' | 'citation_key') => void;

  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  findByIdentity(identity: string): LibraryItem | null {
    const row = this.db.prepare('SELECT id FROM research_library WHERE identity_key = ?').get(identity) as { id: string } | undefined;
    return row === undefined ? null : this.get(row.id);
  }

  flushIndex(): void { this.research.flushKnowledgeFromSource(); }

  get(id: string): LibraryItem {
    const row = this.db.prepare('SELECT * FROM research_library WHERE id = ?').get(id) as LibraryRow | undefined;
    if (row === undefined) throw new Error('research_library_item_not_found');
    return researchLibraryItemSchema.parse({ id: row.id, metadata: readJsonColumn(row.metadata_json), bibliography: readJsonColumn(row.bibliography_json),
      sources: readJsonColumn(row.sources_json), revision: row.revision, archived: row.archived === 1, createdAt: row.created_at, updatedAt: row.updated_at,
      projectIds: this.db.prepare('SELECT project_id FROM research_library_projects WHERE item_id = ? ORDER BY project_id').all(id)
        .map((entry) => (entry as { project_id: string }).project_id) });
  }

  resolveCitationKey(projectId: string, citationKey: string): LibraryItem {
    this.research.getProject(projectId);
    const rows = this.db.prepare(`SELECT l.id, EXISTS (
      SELECT 1 FROM research_library_projects p WHERE p.item_id = l.id AND p.project_id = ?
    ) AS linked FROM research_library l WHERE l.archived = 0 AND json_extract(l.bibliography_json, '$.citationKey') = ?
      ORDER BY linked DESC,l.id`).all(projectId, citationKey) as Array<{ id: string; linked: number }>;
    if (rows.length === 0) throw new Error('research_library_citation_key_missing');
    const candidates = rows.filter((row) => row.linked === rows[0].linked);
    if (candidates.length !== 1) throw new Error('research_library_citation_key_ambiguous');
    return this.get(candidates[0].id);
  }

  list(request: z.infer<typeof researchLibraryListRequestSchema>): LibraryItem[] {
    if (request.projectId !== null) this.research.getProject(request.projectId);
    const query = `%${request.query.trim().replace(/[\\%_]/gu, '\\$&')}%`;
    // 搜索同时看元数据与**引用键**：用户最常见的动作是从模板/旧稿里复制一个 `\cite{smith2020}`
    // 里的键，然后想知道库里是哪一篇。只看 metadata_json 时这类搜索永远零命中。
    return (this.db.prepare(`SELECT l.id FROM research_library l WHERE (? = 1 OR archived = 0)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM research_library_projects p WHERE p.item_id = l.id AND p.project_id = ?))
      AND (metadata_json LIKE ? ESCAPE '\\' OR json_extract(bibliography_json, '$.citationKey') LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC, id LIMIT ?`)
      .all(request.includeArchived ? 1 : 0, request.projectId, request.projectId, query, query, request.limit) as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  import(entries: readonly { metadata: ResearchLiterature; bibliography: BibliographyEntry }[], projectId: string | null,
    options: { flush?: boolean; notify?: boolean; skipArchived?: boolean } = {}): {
    items: LibraryItem[]; createdCount: number; duplicateCount: number;
  } {
    this.validateDestination(projectId);
    const parsed = entries.map((entry) => {
      const metadata = researchLiteratureSchema.parse(entry.metadata);
      const bibliography = researchBibliographyEntrySchema.parse(entry.bibliography);
      metadata.doi = metadata.doi === null ? null : normalizeResearchDoi(metadata.doi);
      bibliography.doi = bibliography.doi === null ? null : normalizeResearchDoi(bibliography.doi);
      if (metadata.doi !== bibliography.doi || metadata.title !== bibliography.title) throw new Error('research_library_metadata_mismatch');
      return { metadata, bibliography, identity: literatureIdentity(metadata) };
    });
    const imported = this.db.transaction(() => {
      let createdCount = 0;
      let duplicateCount = 0;
      const ids: string[] = [];
      const restoredIds = new Set<string>();
      for (const entry of parsed) {
        const existing = this.db.prepare('SELECT id FROM research_library WHERE identity_key = ?').get(entry.identity) as { id: string } | undefined;
        const timestamp = this.now();
        let id: string;
        if (existing === undefined) {
          id = `paper_${randomUUID()}`;
          this.db.prepare(`INSERT INTO research_library (id,identity_key,metadata_json,bibliography_json,sources_json,revision,archived,created_at,updated_at)
            VALUES (?,?,?,?,?,1,0,?,?)`).run(id, entry.identity, JSON.stringify(entry.metadata), JSON.stringify(entry.bibliography),
              JSON.stringify([{ metadata: entry.metadata, bibliography: entry.bibliography }]), timestamp, timestamp);
          createdCount += 1;
        } else {
          id = existing.id;
          const current = this.get(id);
          if (current.archived && options.skipArchived === true) throw new Error('research_library_item_archived');
          if (current.archived) restoredIds.add(id);
          const sources = [...current.sources];
          const fingerprint = bibliographyIdentity(entry.bibliography);
          if (!sources.some((source) => sameMetadata(source.metadata, entry.metadata) && bibliographyIdentity(source.bibliography) === fingerprint)) {
            sources.push({ metadata: entry.metadata, bibliography: entry.bibliography });
          }
          const metadata = { ...current.metadata,
            authors: current.metadata.authors.length === 0 ? entry.metadata.authors : current.metadata.authors,
            abstract: current.metadata.abstract?.trim() ? current.metadata.abstract : entry.metadata.abstract,
            publishedYear: current.metadata.publishedYear ?? entry.metadata.publishedYear,
            citationCount: current.metadata.citationCount ?? entry.metadata.citationCount,
            url: current.metadata.url ?? entry.metadata.url, openAccessUrl: current.metadata.openAccessUrl ?? entry.metadata.openAccessUrl };
          const fields = { ...current.bibliography.fields };
          const dateFields = new Set(['date', 'year', 'month', 'day']);
          if (current.bibliography.publishedYear === null && entry.bibliography.publishedYear !== null) {
            for (const key of dateFields) delete fields[key];
          }
          for (const [key, value] of Object.entries(entry.bibliography.fields)) {
            if (dateFields.has(key) && current.bibliography.publishedYear !== null) continue;
            if ((key === 'journal' || key === 'journaltitle') && (current.bibliography.fields.journal?.trim() || current.bibliography.fields.journaltitle?.trim())) continue;
            if (!fields[key]?.trim()) fields[key] = value;
          }
          let csl = current.bibliography.csl;
          if (entry.bibliography.csl !== null) {
            csl = { ...csl };
            for (const [key, value] of Object.entries(entry.bibliography.csl)) {
              if (csl[key] === undefined || csl[key] === null) csl[key] = value;
            }
          }
          const bibliography = { ...current.bibliography, fields,
            authors: metadata.authors, abstract: metadata.abstract, publishedYear: metadata.publishedYear, url: metadata.url,
            entryType: current.bibliography.entryType === 'misc' ? entry.bibliography.entryType : current.bibliography.entryType,
            preambles: [...new Set([...current.bibliography.preambles, ...entry.bibliography.preambles])], csl };
          if (current.archived || JSON.stringify(sources) !== JSON.stringify(current.sources) || !sameMetadata(current.metadata, metadata)
              || JSON.stringify(bibliography) !== JSON.stringify(current.bibliography)) {
            this.db.prepare(`UPDATE research_library SET metadata_json = ?, bibliography_json = ?, sources_json = ?,
              archived = 0, revision = revision + 1, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify(metadata), JSON.stringify(bibliography), JSON.stringify(sources), timestamp, id);
          }
          duplicateCount += 1;
        }
        if (projectId !== null) this.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(id, projectId);
        if (!ids.includes(id)) ids.push(id);
      }
      const items = ids.map((id) => this.get(id));
      for (const item of items) this.indexMetadata(item);
      for (const id of restoredIds) this.research.documents.syncLibraryIndex(id);
      return { items, createdCount, duplicateCount };
    })();
    if (options.notify !== false) this.onChanged?.(imported.items, 'import');
    if (options.flush !== false) this.research.flushKnowledgeFromSource();
    return imported;
  }

  link(id: string, projectId: string, linked: boolean): LibraryItem {
    this.validateDestination(projectId);
    const item = this.get(id);
    if (linked && item.archived) throw new Error('research_library_item_archived');
    if (linked) this.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(id, projectId);
    else this.db.prepare('DELETE FROM research_library_projects WHERE item_id = ? AND project_id = ?').run(id, projectId);
    const linkedItem = this.get(id);
    this.onChanged?.([{ ...linkedItem, projectIds: [...new Set([...item.projectIds, projectId])] }], 'link');
    return linkedItem;
  }

  archive(id: string, expectedRevision: number, archived: boolean): LibraryItem {
    const archivedItem = this.db.transaction(() => {
      this.get(id);
      const result = this.db.prepare('UPDATE research_library SET archived = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
        .run(archived ? 1 : 0, this.now(), id, expectedRevision);
      if (result.changes !== 1) throw new Error('research_library_version_conflict');
      const item = this.get(id);
      if (archived) this.db.prepare('DELETE FROM research_knowledge_documents WHERE id = ?').run(`library:${id}`);
      else this.indexMetadata(item);
      this.research.documents.syncLibraryIndex(id);
      return item;
    })();
    this.onChanged?.([archivedItem], 'archive');
    this.research.flushKnowledgeFromSource();
    return archivedItem;
  }

  /**
   * 当前库里所有引用键（小写）。
   *
   * 引用键生成（`cite-key.ts`）必须知道已占用的键才能追加消歧后缀；把这次查询放在仓库层，
   * 是因为「哪些键存在」是库的事实，不是调用方的猜测。已归档条目也算：它们在导出里仍可能
   * 被恢复引用，键冲突不该等到那一刻才暴露。
   */
  usedCitationKeys(): Set<string> {
    const rows = this.db.prepare("SELECT json_extract(bibliography_json, '$.citationKey') AS key FROM research_library").all() as Array<{ key: string | null }>;
    return citationKeySet(rows.flatMap((row) => (typeof row.key === 'string' && row.key.length > 0 ? [row.key] : [])));
  }

  setCitationKey(id: string, expectedRevision: number, citationKey: string): LibraryItem {
    const current = this.get(id);
    const bibliography = researchBibliographyEntrySchema.parse({ ...current.bibliography, citationKey });
    const result = this.db.prepare('UPDATE research_library SET bibliography_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(JSON.stringify(bibliography), this.now(), id, expectedRevision);
    if (result.changes !== 1) throw new Error('research_library_version_conflict');
    const item = this.get(id);
    this.onChanged?.([item], 'citation_key');
    return item;
  }

  validateDestination(id: string | null): void {
    if (id !== null && this.research.getProject(id).status === 'archived') throw new Error('research_project_archived');
  }

  private indexMetadata(item: LibraryItem): void {
    const chunks = [{ content: [item.metadata.title, item.metadata.authors.join('; '), item.metadata.doi].filter(Boolean).join('\n'), locator: 'bibliographic metadata' }];
    if (item.metadata.abstract?.trim()) chunks.push({ content: item.metadata.abstract, locator: 'abstract' });
    const content = chunks.map((chunk) => chunk.content).join('\n\n');
    const existing = this.db.prepare('SELECT title,content,project_id,source_id,source_type FROM research_knowledge_documents WHERE id = ?')
      .get(`library:${item.id}`) as { title: string; content: string; project_id: string | null; source_id: string; source_type: string } | undefined;
    if (existing !== undefined && existing.project_id === null && existing.source_id === item.id
        && existing.source_type === 'literature' && existing.title === item.metadata.title && existing.content === content) return;
    const input = { id: `library:${item.id}`, projectId: null as string | null, sourceType: 'literature' as const, sourceId: item.id,
      title: item.metadata.title, content, chunks, embeddingPolicy: 'none' as const };
    this.research.knowledge.upsertFromSource(input);
    this.research.queueKnowledgeFromSource(input);
  }
}

function sameMetadata(left: ResearchLiterature, right: ResearchLiterature): boolean {
  const { importedAt: _leftImported, updatedAt: _leftUpdated, ...leftContent } = left;
  const { importedAt: _rightImported, updatedAt: _rightUpdated, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}
