import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {WikiSection, WikiSearchResult} from '../../../shared/schemas/research-wiki-pages';
import type {ResearchEmbeddingService} from './embedding-service';
import {keywordQueryV1, keywordTextV1} from './knowledge-keywords';
import {vectorToBlob} from './embedding-vectors';

const inputVersion = 'wiki-section-v1';
type SectionRow = {id: number; page_id: string; revision: number; section_id: string; title: string; body: string; vector_blob?: Buffer};
type Navigation = Omit<WikiSearchResult, 'pages'> & {hits: Array<{pageId: string; revision: number;
  matches: WikiSearchResult['pages'][number]['matches']}>};

/** Only current Wiki sections are indexed. Cached derived vectors never enter the raw knowledge index. */
export class ResearchWikiSearch {
  private embeddings: Pick<ResearchEmbeddingService, 'embedTexts' | 'selectedConfiguration'> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly controller = new AbortController();
  private retryAfter = 0;
  private failed = false;
  private configuration = '';
  constructor(private readonly db: Database) {}

  configure(embeddings: NonNullable<ResearchWikiSearch['embeddings']>): void {
    this.embeddings = embeddings;
    if (!this.timer) {this.timer = setInterval(() => this.wake(), 5000); this.timer.unref();}
    this.wake();
  }

  replace(pageId: string, revision: number, title: string, sections: WikiSection[]): void {
    this.db.prepare('DELETE FROM research_wiki_sections WHERE page_id=?').run(pageId);
    const insert = this.db.prepare(`INSERT INTO research_wiki_sections
      (page_id,revision,section_id,title,body,input_text,input_hash) VALUES (?,?,?,?,?,?,?)`);
    for (const section of sections) {
      const text = `${title}\n${section.title}\n${section.body}`;
      insert.run(pageId, revision, section.id, keywordTextV1(`${title}\n${section.title}`), keywordTextV1(section.body),
        text, createHash('sha256').update(text).digest('hex'));
    }
    queueMicrotask(() => this.wake());
  }

  wake(): void {
    if (!this.embeddings || this.controller.signal.aborted) return;
    const selected = this.embeddings.selectedConfiguration(null);
    const configuration = selected ? `${selected.configId}:${selected.revision}` : '';
    if (configuration !== this.configuration) {this.configuration = configuration; this.failed = false; this.retryAfter = 0;}
    if (!selected || this.running || Date.now() < this.retryAfter) return;
    this.running = Promise.resolve().then(async () => {
      while (!this.controller.signal.aborted) {
        const config = this.embeddings!.selectedConfiguration(null);
        if (!config) return;
        const rows = this.db.prepare(`SELECT DISTINCT s.input_text FROM research_wiki_sections s
          LEFT JOIN research_embedding_cache c ON c.config_id=? AND c.revision=? AND c.input_version=? AND c.input_hash=s.input_hash
          WHERE c.input_hash IS NULL LIMIT 16`).all(config.configId, config.revision, inputVersion) as Array<{input_text: string}>;
        if (!rows.length) {this.failed = false; return;}
        await this.embeddings!.embedTexts(rows.map(row => row.input_text), inputVersion, this.controller.signal);
      }
    }).catch(() => {
      if (configuration === this.configuration) {this.failed = true; this.retryAfter = Date.now() + 60000;}
    }).finally(() => {this.running = null; if (configuration !== this.configuration) this.wake();});
  }
  async idle(): Promise<void> {while (this.running) await this.running;}
  async shutdown(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async search(projectId: string, query: string, offset: number): Promise<Navigation> {
    const totalSections = this.db.prepare(`SELECT COUNT(*) FROM research_wiki_sections s
      JOIN research_wiki_pages p ON p.id=s.page_id AND p.revision=s.revision WHERE p.project_id=?`).pluck().get(projectId) as number;
    const keywords = keywordQueryV1(query);
    const lexical = keywords ? this.db.prepare(`SELECT s.* FROM research_wiki_fts
      JOIN research_wiki_sections s ON s.id=research_wiki_fts.rowid
      JOIN research_wiki_pages p ON p.id=s.page_id AND p.revision=s.revision
      WHERE research_wiki_fts MATCH ? AND p.project_id=? ORDER BY bm25(research_wiki_fts,3,1),s.id`)
      .all(keywords, projectId) as SectionRow[] : [];
    let degradation: Navigation['degradation'] = 'config_missing';
    let semantic: SectionRow[] = [], indexedSections = 0, searchedSemantic = false;
    const config = this.embeddings?.selectedConfiguration(null);
    if (config) {
      this.wake();
      const indexed = this.db.prepare(`SELECT s.*,c.vector_blob FROM research_wiki_sections s
        JOIN research_wiki_pages p ON p.id=s.page_id AND p.revision=s.revision
        JOIN research_embedding_cache c ON c.config_id=? AND c.revision=? AND c.input_version=? AND c.input_hash=s.input_hash
        WHERE p.project_id=?`).all(config.configId, config.revision, inputVersion, projectId) as SectionRow[];
      indexedSections = indexed.length;
      degradation = this.failed ? 'embedding_failed' : indexedSections < totalSections ? 'index_pending' : null;
      if (indexed.length) {
        let vector: Buffer | null = null;
        try {
          const embedded = await this.embeddings!.embedTexts([query], 'wiki-query-v1', this.controller.signal);
          if (embedded.configId !== config.configId || embedded.revision !== config.revision) throw new Error('research_embedding_config_changed');
          vector = vectorToBlob(embedded.vectors[0]!);
        } catch (error) {
          const selected = this.embeddings!.selectedConfiguration(null);
          if (this.controller.signal.aborted || selected?.configId !== config.configId || selected.revision !== config.revision ||
            (error instanceof Error && 'code' in error && error.code === 'research_embedding_cancelled')) throw error;
          degradation = 'embedding_failed';
        }
        // An await can cross a publication: discard every section no longer at this page revision.
        if (vector) {
          searchedSemantic = true;
          const latest = new Map((this.db.prepare('SELECT id,revision FROM research_wiki_pages WHERE project_id=?')
            .all(projectId) as Array<{id: string; revision: number}>).map(page => [page.id, page.revision]));
          semantic = indexed.filter(row => latest.get(row.page_id) === row.revision)
            .map(row => {
              const blob = row.vector_blob!;
              if (blob.length !== vector.length) throw new Error('embedding_vector_invalid');
              let score = 0;
              for (let i = 0; i < blob.length; i += 4) score += blob.readFloatLE(i) * vector.readFloatLE(i);
              return {row, score};
            }).filter(hit => hit.score > 0.25).sort((a, b) => b.score - a.score || a.row.id - b.row.id).map(hit => hit.row);
        }
      }
    }
    const ranked = new Map<number, {row: SectionRow; score: number}>();
    for (const rows of [lexical, semantic]) rows.forEach((row, rank) => {
      const hit = ranked.get(row.id) ?? {row, score: 0}; hit.score += 1 / (60 + rank + 1); ranked.set(row.id, hit);
    });
    const pages = new Map<string, Navigation['hits'][number]>();
    for (const {row} of [...ranked.values()].sort((a, b) => b.score - a.score || a.row.id - b.row.id)) {
      const current = this.db.prepare('SELECT revision FROM research_wiki_pages WHERE id=? AND project_id=?').pluck().get(row.page_id, projectId);
      if (current !== row.revision) continue;
      const hit = pages.get(row.page_id) ?? {pageId: row.page_id, revision: row.revision, matches: []};
      if (hit.matches.length < 3) {
        const section = (JSON.parse(this.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
          .pluck().get(row.page_id, row.revision) as string) as {sections: WikiSection[]}).sections.find(value => value.id === row.section_id)!;
        hit.matches.push({sectionId: section.id, title: section.title, snippet: section.body.slice(0, 320)});
      }
      pages.set(row.page_id, hit);
    }
    const hits = [...pages.values()];
    return {hits: hits.slice(offset, offset + 50), mode: searchedSemantic ? 'hybrid' : 'bm25', degradation,
      indexedSections, totalSections, nextOffset: hits.length > offset + 50 ? offset + 50 : null};
  }
}
