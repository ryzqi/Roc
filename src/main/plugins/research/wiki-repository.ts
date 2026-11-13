import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  wikiCreateSchema, wikiSaveSchema, wikiRollbackSchema, wikiRevisionSchema, wikiSummarySchema,
  type WikiSection, type WikiDependency, type WikiRevision, type WikiPage, type WikiSummary
} from '../../../shared/schemas/research-wiki-pages';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchEvidenceRepository} from './evidence-repository';
import {relationSourceDigest, relationClaimHash} from './evidence-relation-repository';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type PageRow = {id: string; project_id: string; kind: WikiSummary['kind']; title: string; source_document_id: string | null;
  selection_json: string; revision: number; updated_at: string};
type Selection = {evidenceIds: string[]; claimIds: string[]};

/** Derived drafts only. No write path here can create evidence or approve scientific relations. */
export class ResearchWikiRepository {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  constructor(private readonly db: Database, private readonly evidence: ResearchEvidenceRepository,
    private readonly requireProject: (id: string) => void, private readonly now: () => string) {}

  search(projectId: string, query = '', offset = 0): WikiSummary[] {
    this.requireProject(projectId);
    return (this.db.prepare(`SELECT * FROM research_wiki_pages WHERE project_id=?
      AND (?='' OR instr(lower(title||char(10)||search_text),lower(?))>0)
      ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?`).all(projectId, query, query, offset) as PageRow[]).map(row => this.summary(row));
  }

  create(input: z.infer<typeof wikiCreateSchema>): WikiPage {
    const request = wikiCreateSchema.parse(input);
    this.requireProject(request.projectId);
    const id = `wiki_${randomUUID()}`;
    this.db.transaction(() => {
      this.dependencies(request.projectId, request.evidenceIds, request.claimIds);
      this.db.prepare(`INSERT INTO research_wiki_pages(id,project_id,kind,title,selection_json,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(id, request.projectId, request.kind, request.title, JSON.stringify({evidenceIds: request.evidenceIds, claimIds: request.claimIds}), this.now());
      this.enqueue(id);
      // Seed dependencies before the first worker runs, so edits/deletes cannot escape the outbox.
      this.indexDependencies(id, this.dependencies(request.projectId, request.evidenceIds, request.claimIds));
    })();
    this.wake();
    return this.read(request.projectId, id);
  }

  read(projectId: string, pageId: string): WikiPage {
    return this.db.transaction(() => {
      const row = this.row(projectId, pageId), current = row.revision === 0 ? null : this.revision(projectId, pageId, row.revision);
      const lint: WikiPage['lint'] = [], sources: WikiPage['sources'] = [], links: WikiSummary[] = [];
      const sections = current?.sections.map(section => ({...section})) ?? [];
      const dependencyStates = new Map<string, string | null>();
      for (const section of sections) {
        if (section.evidenceIds.length === 0) lint.push({code: 'uncited', sectionId: section.id, message: '此章节没有原始证据引用；不能据此确认科学支持。'});
        for (const dep of section.dependencies) {
          const key = `${dep.kind}:${dep.id}`;
          if (!dependencyStates.has(key)) dependencyStates.set(key, this.currentDigest(projectId, dep));
          const actual = dependencyStates.get(key);
          if (actual !== dep.digest) {
            section.status = 'stale';
            lint.push({code: actual === null ? 'missing' : 'stale', sectionId: section.id,
              message: actual === null ? `依据已缺失：${dep.id}` : `依据版本已改变：${dep.id}`});
          }
        }
        for (const evidenceId of section.evidenceIds) {
          if (sources.some(source => source.evidenceId === evidenceId)) continue;
          if (!this.exists('research_evidence', evidenceId, projectId)) {section.status = 'stale'; continue;}
          const source = this.evidence.inspectEvidence(evidenceId, projectId);
          sources.push({evidenceId, title: source.evidence.title, locator: source.evidence.locator,
            excerpt: source.evidence.excerpt, sourceDigest: relationSourceDigest(source), status: source.referenceStatus});
          if (source.referenceStatus === 'superseded') {
            section.status = 'stale';
            lint.push({code: 'stale', sectionId: section.id, message: `原始证据已失效：${evidenceId}`});
          }
        }
        for (const link of section.links) {
          if (links.some(page => page.id === link)) continue;
          const target = this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? AND id=?').get(projectId, link) as PageRow | undefined;
          if (target === undefined) lint.push({code: 'broken_link', sectionId: section.id, message: `页面链接已缺失：${link}`});
          else links.push(this.summary(target));
        }
        for (const claimId of section.claimIds) {
          const relations = this.evidence.relations.list({projectId, claimId});
          if (relations.some(relation => relation.kind === 'contradicts' && ['proposed', 'confirmed'].includes(relation.status))) {
            lint.push({code: 'conflict_candidate', sectionId: section.id, message: `主张存在反对关系，请查看原始审核记录：${claimId}`});
          }
        }
      }
      if (links.length === 0) lint.push({code: 'isolated', sectionId: null, message: '此页尚无到其他 Wiki 页面的链接。'});
      if (row.kind === 'source' && this.sourceCount(row) > 50) lint.push({code: 'source_limit', sectionId: null,
        message: '此来源超过 50 条捕获证据，本页仅编译最近的 50 条；其余证据请通过原始检索读取。'});
      return {page: this.summary(row), current: current ? {...current, sections} : null,
        basisDigest: hash([...dependencyStates].sort()), lint, sources, links};
    })();
  }

  revision(projectId: string, pageId: string, revision: number): WikiRevision {
    this.row(projectId, pageId);
    const row = this.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?').get(pageId, revision) as {snapshot_json: string} | undefined;
    if (row === undefined) throw new Error('wiki_revision_not_found');
    return wikiRevisionSchema.parse(JSON.parse(row.snapshot_json));
  }

  history(projectId: string, pageId: string, offset = 0): Array<Omit<WikiRevision, 'sections'>> {
    this.row(projectId, pageId);
    return (this.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? ORDER BY revision DESC LIMIT 50 OFFSET ?')
      .all(pageId, offset) as Array<{snapshot_json: string}>).map(row => {
      const {sections: _sections, ...summary} = wikiRevisionSchema.parse(JSON.parse(row.snapshot_json)); return summary;
    });
  }

  follow(projectId: string, pageId: string, expectedRevision: number, targetPageId: string): WikiPage {
    return this.db.transaction(() => {
      const row = this.row(projectId, pageId);
      if (row.revision !== expectedRevision) throw new Error('wiki_revision_conflict');
      const from = this.revision(projectId, pageId, expectedRevision);
      if (!from.sections.some(section => section.links.includes(targetPageId))) throw new Error('wiki_link_not_found');
      return this.read(projectId, targetPageId);
    })();
  }

  save(input: z.infer<typeof wikiSaveSchema>, owner: 'human' | 'assistant'): WikiPage {
    const request = wikiSaveSchema.parse(input);
    if (owner === 'human') requireResearchHuman('research.wiki.save', request.projectId);
    return this.db.transaction(() => {
      const page = this.read(request.projectId, request.pageId), row = this.row(request.projectId, request.pageId);
      if (row.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
      if (page.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
      const sections = page.current!.sections, previous = sections.find(section => section.id === request.section.id);
      if (owner === 'assistant' && previous?.owner === 'human') throw new Error('wiki_human_section_protected');
      // Assistant synthesis may use only this page's read, current source set; new sources need a new page selection.
      const allowed = new Set(page.sources.filter(source => source.status === 'recorded').map(source => source.evidenceId));
      if (owner === 'assistant' && (request.section.evidenceIds.length === 0 || request.section.evidenceIds.some(id => !allowed.has(id)) ||
        request.section.claimIds.some(id => !sections.some(section => section.claimIds.includes(id))))) throw new Error('wiki_current_sources_required');
      for (const link of request.section.links) this.row(request.projectId, link);
      const section: WikiSection = {...request.section, owner, status: 'current',
        dependencies: this.dependencies(request.projectId, request.section.evidenceIds, request.section.claimIds)};
      this.publish(row, [...sections.filter(item => item.id !== section.id), section], owner === 'human' ? 'human' : 'assistant');
      return this.read(request.projectId, request.pageId);
    })();
  }

  rollback(input: z.infer<typeof wikiRollbackSchema>): WikiPage {
    const request = wikiRollbackSchema.parse(input);
    requireResearchHuman('research.wiki.rollback', request.projectId);
    return this.db.transaction(() => {
      const row = this.row(request.projectId, request.pageId);
      if (row.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
      const old = this.revision(request.projectId, request.pageId, request.targetRevision);
      this.publish(row, old.sections, 'rollback'); // Preserve old dependencies. Rollback never blesses stale evidence.
      return this.read(request.projectId, request.pageId);
    })();
  }

  recompile(projectId: string, pageId: string, expectedRevision: number): WikiSummary {
    const row = this.row(projectId, pageId);
    if (row.revision !== expectedRevision) throw new Error('wiki_revision_conflict');
    this.enqueue(pageId); this.wake(); return this.summary(row);
  }

  start(): void {
    this.db.prepare("UPDATE research_wiki_jobs SET status='queued',error=NULL WHERE status='running'").run();
    this.stopped = false;
    if (this.timer === null) {this.timer = setInterval(() => this.wake(), 1000); this.timer.unref();}
    this.wake();
  }
  wake(): void {
    if (this.stopped || this.running !== null) return;
    this.running = Promise.resolve().then(async () => {
      while (!this.stopped && this.compileNext()) await new Promise<void>(resolve => setImmediate(resolve));
    }).finally(() => {this.running = null;});
  }
  async idle(): Promise<void> {await this.running;}
  async shutdown(): Promise<void> {this.stopped = true; if (this.timer !== null) clearInterval(this.timer); this.timer = null; await this.running;}

  /** Each compilation publishes a complete snapshot within one SQLite transaction. */
  compileNext(): boolean {
    const job = this.db.prepare("SELECT page_id,generation FROM research_wiki_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {page_id: string; generation: string} | undefined;
    if (job === undefined) return false;
    this.db.prepare("UPDATE research_wiki_jobs SET status='running' WHERE page_id=? AND generation=?").run(job.page_id, job.generation);
    try {
      this.db.transaction(() => {
        const row = this.db.prepare('SELECT * FROM research_wiki_pages WHERE id=?').get(job.page_id) as PageRow;
        const previous = this.read(row.project_id, row.id).current?.sections ?? [];
        const retained = previous.filter(section => section.owner !== 'system');
        const selection = JSON.parse(row.selection_json) as Selection;
        const evidenceIds = new Set(row.kind === 'source' ? this.sourceIds(row) : selection.evidenceIds);
        const generated: WikiSection[] = [];
        for (const claimId of selection.claimIds) {
          if (!this.exists('research_claims', claimId, row.project_id)) continue;
          const claim = this.evidence.getClaim(claimId);
          if (claim.projectId !== row.project_id) throw new Error('wiki_project_mismatch');
          for (const id of claim.evidenceIds) evidenceIds.add(id);
          generated.push({id: `claim:${claimId}`, title: '主张摘录 · 科学支持请查看人工审核', body: claim.content.slice(0, 6000),
            owner: 'system', status: 'current', evidenceIds: claim.evidenceIds, claimIds: [claimId], links: [],
            dependencies: this.dependencies(row.project_id, claim.evidenceIds, [claimId])});
        }
        if (evidenceIds.size > 50) throw new Error('wiki_source_limit');
        for (const evidenceId of evidenceIds) {
          if (!this.exists('research_evidence', evidenceId, row.project_id)) continue;
          const source = this.evidence.inspectEvidence(evidenceId, row.project_id);
          const target = this.db.prepare('SELECT id FROM research_wiki_pages WHERE project_id=? AND source_document_id=? AND id<>?')
            .get(row.project_id, source.evidence.documentId, row.id) as {id: string} | undefined;
          generated.push({id: `evidence:${evidenceId}`, title: source.evidence.title.slice(0, 300),
            body: `${source.referenceStatus === 'superseded' ? '【历史来源，已失效】\n' : ''}${source.evidence.excerpt.slice(0, 5800)}`,
            owner: 'system', status: source.referenceStatus === 'superseded' ? 'stale' : 'current',
            evidenceIds: [evidenceId], claimIds: [], links: target ? [target.id] : [],
            dependencies: this.dependencies(row.project_id, [evidenceId], [])});
        }
        const refreshed = generated.filter(section => !retained.some(saved => saved.id === section.id));
        const remaining = 100000 - retained.reduce((size, section) => size + section.body.length, 0);
        const perSection = Math.floor(remaining / Math.max(1, refreshed.length));
        if (refreshed.length > 0 && perSection < 100) throw new Error('wiki_page_too_large');
        this.publish(row, [...refreshed.map(section => ({...section, body: section.body.slice(0, perSection)})), ...retained], 'compile');
        this.db.prepare("UPDATE research_wiki_jobs SET status='ready',error=NULL WHERE page_id=? AND generation=?")
          .run(row.id, job.generation);
      })();
    } catch (error) {
      this.db.prepare("UPDATE research_wiki_jobs SET status='failed',error=? WHERE page_id=? AND generation=?")
        .run(error instanceof Error && error.message === 'wiki_source_limit' ? '引用超过 50 条，请缩小主题范围。' : '编译失败，请检查原始证据与主张是否仍可读取，然后重试。', job.page_id, job.generation);
    }
    return true;
  }

  private publish(row: PageRow, sections: WikiSection[], reason: WikiRevision['reason']): void {
    const snapshot = wikiRevisionSchema.parse({pageId: row.id, revision: row.revision + 1, sections, reason, createdAt: this.now()});
    if (sections.reduce((size, section) => size + section.body.length, 0) > 100000) throw new Error('wiki_page_too_large');
    this.db.prepare('INSERT INTO research_wiki_revisions(page_id,revision,snapshot_json) VALUES (?,?,?)')
      .run(row.id, snapshot.revision, JSON.stringify(snapshot));
    const update = this.db.prepare('UPDATE research_wiki_pages SET revision=?,search_text=?,updated_at=? WHERE id=? AND revision=?')
      .run(snapshot.revision, sections.map(section => `${section.title}\n${section.body}`).join('\n'), snapshot.createdAt, row.id, row.revision);
    if (update.changes !== 1) throw new Error('wiki_revision_conflict');
    this.db.prepare('DELETE FROM research_wiki_dependencies WHERE page_id=?').run(row.id);
    this.indexDependencies(row.id, sections.flatMap(section => section.dependencies));
    // Retain selection dependencies even when a human override removes the generated section.
    const selection = JSON.parse(row.selection_json) as Selection;
    for (const [kind, ids] of [['evidence', selection.evidenceIds], ['claim', selection.claimIds], ['relations', selection.claimIds]] as const) {
      for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(row.id, kind, id);
    }
  }
  private dependencies(projectId: string, evidenceIds: string[], claimIds: string[]): WikiDependency[] {
    const dependencies: WikiDependency[] = [];
    for (const id of evidenceIds) dependencies.push({kind: 'evidence', id, digest: relationSourceDigest(this.evidence.inspectEvidence(id, projectId))});
    for (const id of claimIds) {
      const claim = this.evidence.getClaim(id);
      if (claim.projectId !== projectId) throw new Error('wiki_project_mismatch');
      dependencies.push({kind: 'claim', id, digest: relationClaimHash(claim)},
        {kind: 'relations', id, digest: hash(this.evidence.relations.list({projectId, claimId: id}))});
    }
    return dependencies;
  }
  private currentDigest(projectId: string, dependency: WikiDependency): string | null {
    if (!this.exists(dependency.kind === 'evidence' ? 'research_evidence' : 'research_claims', dependency.id, projectId)) return null;
    return this.dependencies(projectId, dependency.kind === 'evidence' ? [dependency.id] : [], dependency.kind !== 'evidence' ? [dependency.id] : [])
      .find(item => item.kind === dependency.kind)!.digest;
  }
  private exists(table: 'research_evidence' | 'research_claims', id: string, projectId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND project_id=?`).get(id, projectId) !== undefined;
  }
  private indexDependencies(pageId: string, dependencies: WikiDependency[]): void {
    for (const dep of dependencies) this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(pageId, dep.kind, dep.id);
  }
  private enqueue(pageId: string): void {
    this.db.prepare(`INSERT INTO research_wiki_jobs VALUES (?,?,'queued',NULL) ON CONFLICT(page_id)
      DO UPDATE SET generation=excluded.generation,status='queued',error=NULL`).run(pageId, randomUUID());
  }
  private row(projectId: string, pageId: string): PageRow {
    this.requireProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? AND id=?').get(projectId, pageId) as PageRow | undefined;
    if (row === undefined) throw new Error('wiki_page_not_found');
    return row;
  }
  private summary(row: PageRow): WikiSummary {
    const job = this.db.prepare('SELECT generation,status,error FROM research_wiki_jobs WHERE page_id=?').get(row.id) ?? null;
    return wikiSummarySchema.parse({id: row.id, projectId: row.project_id, title: row.title, kind: row.kind,
      revision: row.revision, updatedAt: row.updated_at, job});
  }
  private sourceIds(row: PageRow): string[] {
    return (this.db.prepare('SELECT id FROM research_evidence WHERE project_id=? AND document_id=? ORDER BY invalidated_at IS NOT NULL,rowid DESC LIMIT 50')
      .all(row.project_id, row.source_document_id) as Array<{id: string}>).map(item => item.id);
  }
  private sourceCount(row: PageRow): number {
    return this.db.prepare('SELECT COUNT(*) FROM research_evidence WHERE project_id=? AND document_id=?').pluck().get(row.project_id, row.source_document_id) as number;
  }
}
