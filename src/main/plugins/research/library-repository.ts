import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from 'better-sqlite3';
import type { z } from 'zod';
import { researchLiteratureSchema } from '../../../shared/schemas/research';
import {
  researchBibliographyEntrySchema, researchLibraryItemSchema, type researchLibraryListRequestSchema
} from '../../../shared/schemas/research-library';
import type { ResearchLiterature } from '../../../shared/types';
import { citationKeySet } from './cite-key';
import { bibliographyIdentity, literatureIdentity, normalizeResearchDoi } from './literature-identity';
import { groupLiteratureIdentities } from './literature-identity-graph';
import {providerIdentifierObservations} from './literature-provider-identifiers';
import {literatureReadIdentifiersSchema, literatureProviderIdentifierRecordSchema,
  type LiteratureProviderIdentifierRecord, type literatureIdentifierRecordsResultSchema} from '../../../shared/schemas/literature-identifiers';
import type { ResearchRepository } from './repository';
import {literatureReadReviewsSchema, literatureReviewRecordSchema, type LiteratureReviewRecord,
  type literatureReviewRecordsResultSchema} from '../../../shared/schemas/literature-review';

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

  findByIdentity(identity: string, aliases: readonly string[] = []): LibraryItem | null {
    const keys = [...new Set([identity, ...aliases])];
    const rows = this.db.prepare(`SELECT DISTINCT l.id,l.identity_key FROM research_library_aliases a
      JOIN research_library l ON l.id=a.item_id WHERE a.identity IN (${keys.map(() => '?').join(',')})
      ORDER BY (l.identity_key=?) DESC,(l.identity_key NOT LIKE 'doi:%') DESC,l.id LIMIT 3`)
      .all(...keys, identity) as Array<{id: string; identity_key: string}>;
    const candidates = identity.startsWith('doi:') ? rows.filter(row => row.identity_key === identity || !row.identity_key.startsWith('doi:')) : rows;
    const competingAnchor = identity.startsWith('doi:') && candidates.length > 0 &&
      !candidates.some(row => row.identity_key === identity) && rows.some(row => row.identity_key.startsWith('doi:') && row.identity_key !== identity);
    if (candidates.length > 1 || competingAnchor) throw new Error('research_literature_identity_ambiguous');
    return candidates.length === 0 ? null : this.get(candidates[0].id);
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

  getIdentifiers(input: z.infer<typeof literatureReadIdentifiersSchema>): z.infer<typeof literatureIdentifierRecordsResultSchema> {
    const request = literatureReadIdentifiersSchema.parse(input);
    if (this.db.prepare('SELECT id FROM research_library WHERE id=?').get(request.id) === undefined) throw new Error('research_library_item_not_found');
    const total = (this.db.prepare('SELECT COUNT(*) FROM research_library_provider_identifiers WHERE item_id=?').pluck().get(request.id) as number);
    const rows = this.db.prepare(`SELECT metadata_hash,execution_id,source,external_id,rank,retrieved_at,raw_json,mapped_json
      FROM research_library_provider_identifiers WHERE item_id=?
      ORDER BY retrieved_at DESC,execution_id,source,rank LIMIT ? OFFSET ?`)
      .all(request.id, request.limit, request.offset) as Array<{metadata_hash: string; execution_id: string; source: string;
        external_id: string; rank: number; retrieved_at: string; raw_json: string; mapped_json: string}>;
    const records = rows.map(row => literatureProviderIdentifierRecordSchema.parse({metadataHash: row.metadata_hash,
      executionId: row.execution_id, source: row.source, externalId: row.external_id, rank: row.rank, retrievedAt: row.retrieved_at,
      raw: readJsonColumn(row.raw_json), identifiers: readJsonColumn(row.mapped_json)}));
    return {itemId: request.id, records, total, nextOffset: request.offset + request.limit < total ? request.offset + request.limit : null};
  }

  getReviews(input: z.infer<typeof literatureReadReviewsSchema>): z.infer<typeof literatureReviewRecordsResultSchema> {
    const request = literatureReadReviewsSchema.parse(input);
    if (this.db.prepare('SELECT id FROM research_library WHERE id=?').get(request.id) === undefined) throw new Error('research_library_item_not_found');
    const total = this.db.prepare('SELECT COUNT(*) FROM research_library_provider_reviews WHERE item_id=?').pluck().get(request.id) as number;
    const records = (this.db.prepare(`SELECT record_json FROM research_library_provider_reviews WHERE item_id=?
      ORDER BY retrieved_at DESC,execution_id,source,rank LIMIT ? OFFSET ?`).pluck()
      .all(request.id, request.limit, request.offset) as string[]).map(value => literatureReviewRecordSchema.parse(readJsonColumn(value)));
    return {itemId: request.id, records, total, nextOffset: request.offset + request.limit < total ? request.offset + request.limit : null};
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

  import(entries: readonly { metadata: ResearchLiterature; bibliography: BibliographyEntry; providerRecord?: ResearchLiterature;
    identifierRecord?: LiteratureProviderIdentifierRecord; reviewRecord?: LiteratureReviewRecord }[], projectId: string | null,
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
      const identity = literatureIdentity(metadata);
      const providerRecord = entry.providerRecord === undefined ? null : researchLiteratureSchema.parse(entry.providerRecord);
      if (providerRecord !== null && literatureIdentity(providerRecord) !== identity) throw new Error('research_library_metadata_mismatch');
      const identifierRecord = entry.identifierRecord === undefined ? null : literatureProviderIdentifierRecordSchema.parse(entry.identifierRecord);
      if (identifierRecord !== null) {
        if (providerRecord === null || identifierRecord.metadataHash !== createHash('sha256').update(JSON.stringify(providerRecord)).digest('hex') ||
            identifierRecord.source !== providerRecord.source || identifierRecord.externalId !== providerRecord.externalId ||
            identifierRecord.retrievedAt !== providerRecord.importedAt ||
            JSON.stringify(identifierRecord.identifiers) !== JSON.stringify(providerIdentifierObservations(providerRecord.source, identifierRecord.raw))) {
          throw new Error('research_library_identifier_observation_mismatch');
        }
      }
      const identifiers = identifierRecord === null ? [] : identifierRecord.identifiers;
      const reviewRecord = entry.reviewRecord === undefined ? null : literatureReviewRecordSchema.parse(entry.reviewRecord);
      if (reviewRecord !== null && (providerRecord === null ||
          reviewRecord.metadataHash !== createHash('sha256').update(JSON.stringify(providerRecord)).digest('hex') ||
          reviewRecord.source !== providerRecord.source || reviewRecord.externalId !== providerRecord.externalId ||
          reviewRecord.retrievedAt !== providerRecord.importedAt)) throw new Error('research_library_review_observation_mismatch');
      return { metadata, bibliography, identity, providerRecord, identifierRecord, reviewRecord, identifiers, aliases: [] as string[] };
    });
    for (const group of groupLiteratureIdentities(parsed.map(entry => ({record: entry.metadata, identifiers: entry.identifiers})))) {
      for (const index of group.indexes) Object.assign(parsed[index], {identity: group.identity, aliases: group.aliases});
    }
    const imported = this.db.transaction(() => {
      let createdCount = 0;
      let duplicateCount = 0;
      const ids: string[] = [];
      const restoredIds = new Set<string>();
      for (const entry of parsed) {
        if (entry.metadata.doi === null && entry.identity.startsWith('doi:')) {
          const observed = this.findByIdentity(literatureIdentity(entry.metadata), entry.identifiers.filter(value => value.kind !== 'doi').map(value => value.identity));
          if (observed !== null && observed.metadata.doi !== null && literatureIdentity(observed.metadata) !== entry.identity) {
            throw new Error('research_literature_identity_ambiguous');
          }
        }
        const existing = this.findByIdentity(entry.identity, entry.aliases);
        const storedIdentity = existing === null ? null :
          this.db.prepare('SELECT identity_key FROM research_library WHERE id=?').pluck().get(existing.id) as string;
        const canonicalIdentity = existing !== null && existing.metadata.doi !== null ? literatureIdentity(existing.metadata) :
          entry.identity.startsWith('doi:') ? entry.identity : storedIdentity ?? entry.identity;
        const canonicalDoi = canonicalIdentity.startsWith('doi:') ? canonicalIdentity.slice(4) : null;
        const timestamp = this.now();
        let id: string;
        if (existing === null) {
          id = `paper_${randomUUID()}`;
          this.db.prepare(`INSERT INTO research_library (id,identity_key,metadata_json,bibliography_json,sources_json,revision,archived,created_at,updated_at)
            VALUES (?,?,?,?,?,1,0,?,?)`).run(id, canonicalIdentity, JSON.stringify({...entry.metadata, doi: canonicalDoi}),
              JSON.stringify({...entry.bibliography, doi: canonicalDoi,
                fields: {...entry.bibliography.fields, ...(canonicalDoi === null ? {} : {doi: canonicalDoi})},
                csl: entry.bibliography.csl === null ? null : {...entry.bibliography.csl, ...(canonicalDoi === null ? {} : {DOI: canonicalDoi})}}),
              JSON.stringify([{ metadata: entry.metadata, bibliography: entry.bibliography, providerRecord: entry.providerRecord }]), timestamp, timestamp);
          createdCount += 1;
        } else {
          id = existing.id;
          const current = existing;
          if (current.archived && options.skipArchived === true) throw new Error('research_library_item_archived');
          if (current.archived) restoredIds.add(id);
          const sources = [...current.sources];
          const fingerprint = bibliographyIdentity(entry.bibliography);
          if (!sources.some((source) => sameMetadata(source.metadata, entry.metadata) && bibliographyIdentity(source.bibliography) === fingerprint
              && JSON.stringify(source.providerRecord) === JSON.stringify(entry.providerRecord))) {
            sources.push({ metadata: entry.metadata, bibliography: entry.bibliography, providerRecord: entry.providerRecord });
          }
          const metadata = { ...current.metadata,
            doi: current.metadata.doi ?? canonicalDoi,
            authors: current.metadata.authors.length === 0 ? entry.metadata.authors : current.metadata.authors,
            abstract: current.metadata.abstract?.trim() ? current.metadata.abstract : entry.metadata.abstract,
            publishedYear: current.metadata.publishedYear ?? entry.metadata.publishedYear,
            citationCount: current.metadata.citationCount ?? entry.metadata.citationCount,
            url: current.metadata.url ?? entry.metadata.url, openAccessUrl: current.metadata.openAccessUrl ?? entry.metadata.openAccessUrl };
          const fields = { ...current.bibliography.fields };
          if (current.metadata.doi === null && metadata.doi !== null) fields.doi = metadata.doi;
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
          if (csl !== null && metadata.doi !== null) csl = {...csl, DOI: metadata.doi};
          const bibliography = { ...current.bibliography, fields,
            doi: metadata.doi,
            authors: metadata.authors, abstract: metadata.abstract, publishedYear: metadata.publishedYear, url: metadata.url,
            entryType: current.bibliography.entryType === 'misc' ? entry.bibliography.entryType : current.bibliography.entryType,
            preambles: [...new Set([...current.bibliography.preambles, ...entry.bibliography.preambles])], csl };
          if (current.archived || JSON.stringify(sources) !== JSON.stringify(current.sources) || !sameMetadata(current.metadata, metadata)
              || JSON.stringify(bibliography) !== JSON.stringify(current.bibliography) || storedIdentity !== canonicalIdentity) {
            this.db.prepare(`UPDATE research_library SET identity_key = ?, metadata_json = ?, bibliography_json = ?, sources_json = ?,
              archived = 0, revision = revision + 1, updated_at = ? WHERE id = ?`)
              .run(canonicalIdentity, JSON.stringify(metadata), JSON.stringify(bibliography), JSON.stringify(sources), timestamp, id);
          }
          duplicateCount += 1;
        }
        const insertAlias = this.db.prepare('INSERT INTO research_library_aliases(item_id,identity) VALUES (?,?) ON CONFLICT DO NOTHING');
        for (const alias of new Set([canonicalIdentity, ...entry.aliases])) insertAlias.run(id, alias);
        if (entry.identifierRecord !== null) {
          const observation = entry.identifierRecord;
          const previous = this.db.prepare(`SELECT item_id,metadata_hash,external_id,retrieved_at,raw_json,mapped_json
            FROM research_library_provider_identifiers WHERE execution_id=? AND source=? AND rank=?`)
            .get(observation.executionId, observation.source, observation.rank) as {
              item_id: string; metadata_hash: string; external_id: string; retrieved_at: string; raw_json: string; mapped_json: string
            } | undefined;
          if (previous !== undefined) {
            if (previous.item_id !== id || previous.metadata_hash !== observation.metadataHash || previous.external_id !== observation.externalId ||
                previous.retrieved_at !== observation.retrievedAt || !isDeepStrictEqual(readJsonColumn(previous.raw_json), observation.raw) ||
                !isDeepStrictEqual(readJsonColumn(previous.mapped_json), observation.identifiers)) {
              throw new Error('research_library_identifier_observation_conflict');
            }
          } else {
            this.db.prepare(`INSERT INTO research_library_provider_identifiers
              (item_id,execution_id,source,rank,metadata_hash,external_id,retrieved_at,raw_json,mapped_json)
              VALUES (?,?,?,?,?,?,?,?,?)`)
              .run(id, observation.executionId, observation.source, observation.rank, observation.metadataHash,
                observation.externalId, observation.retrievedAt, JSON.stringify(observation.raw), JSON.stringify(observation.identifiers));
          }
        }
        if (entry.reviewRecord !== null) {
          const observation = entry.reviewRecord;
          const previous = this.db.prepare(`SELECT item_id,record_json FROM research_library_provider_reviews
            WHERE execution_id=? AND source=? AND rank=?`).get(observation.executionId, observation.source, observation.rank) as
            {item_id: string; record_json: string} | undefined;
          if (previous !== undefined) {
            if (previous.item_id !== id || !isDeepStrictEqual(readJsonColumn(previous.record_json), observation)) {
              throw new Error('research_library_review_observation_conflict');
            }
          } else {
            this.db.prepare(`INSERT INTO research_library_provider_reviews(item_id,execution_id,source,rank,retrieved_at,record_json)
              VALUES (?,?,?,?,?,?)`).run(id, observation.executionId, observation.source, observation.rank,
                observation.retrievedAt, JSON.stringify(observation));
          }
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
