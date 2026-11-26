import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  wikiCreateSchema, wikiSaveSchema, wikiRollbackSchema, wikiRevisionSchema, wikiSummarySchema, wikiSectionSchema, wikiSectionReadSchema, wikiResynthesizeSchema, wikiUpdateSourcesSchema,
  type WikiSection, type WikiDependency, type WikiRevision, type WikiPage, type WikiSummary, type WikiSearchResult,
  type WikiPaperKnowledgeSource, type WikiSearchFilters, type WikiTemplate
} from '../../../shared/schemas/research-wiki-pages';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchEvidenceRepository} from './evidence-repository';
import {relationSourceDigest, relationClaimHash} from './evidence-relation-repository';
import type {ResearchKnowledgeRepository} from './knowledge-repository';
import {paperCardRoles, type PaperSource} from '../../../shared/schemas/research-paper-card';
import type {WikiSynthesizer} from './wiki-synthesis';
import {ResearchWikiSearch} from './wiki-search';
import type {ResearchEmbeddingService} from './embedding-service';
import type {ResearchProcessingObserver, ResearchProcessingTrace} from './processing-trace';
import {wikiPaperKnowledgeDigest, type WikiPaperKnowledgeProvider} from './wiki-paper-knowledge';
import {paperCardKnowledgeSchema} from '../../../shared/schemas/research-paper-card-knowledge';
import {assertScientificWikiSection, type ScientificWikiBasis} from './wiki-scientific-synthesis';
import {scientificTopicSections, scientificComparisonSections} from './wiki-scientific-pages';
import {wikiClassification, wikiMatchesFilters} from './wiki-templates';
import {projectWikiRelations} from './wiki-relations';
import {acquisitionWikiBatchSchema, acquisitionWikiPageId, acquisitionWikiSections,
  type AcquisitionWikiBatchInput, type AcquisitionWikiBatch, type AcquisitionWikiSelection,
  type AcquisitionWikiSnapshot, type AcquisitionWikiSource} from './literature-acquisition-wiki';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type PageRow = {id: string; project_id: string; kind: WikiSummary['kind']; title: string; source_document_id: string | null;
  selection_json: string; revision: number; updated_at: string};
type Selection = {evidenceIds: string[]; claimIds: string[]; paperKnowledgeSources?: WikiPaperKnowledgeSource[];
  acquisitionBatch?: AcquisitionWikiSelection; template?: WikiTemplate};
type AcquisitionKnowledge = {id: string; title: string; metadata_json: string};

/** Derived drafts only. No write path here can create evidence or approve scientific relations. */
export class ResearchWikiRepository {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private dirty = false;
  private running: Promise<void> | null = null;
  private synthesizer: WikiSynthesizer | null = null;
  private paperKnowledge: WikiPaperKnowledgeProvider | null = null;
  private readonly knowledgeInvalidations = new Map<string, {basis: string; generation: string}>();
  private readonly synthesisController = new AbortController();
  private readonly syntheses = new Set<Promise<WikiPage>>();
  readonly navigation: ResearchWikiSearch;
  constructor(private readonly db: Database, private readonly evidence: ResearchEvidenceRepository,
    private readonly requireProject: (id: string) => void, private readonly now: () => string,
    private readonly knowledge: ResearchKnowledgeRepository,
    private readonly processing: ResearchProcessingObserver = knowledge.processing) {this.navigation = new ResearchWikiSearch(db);}

  configureSynthesis(synthesizer: WikiSynthesizer): void {this.synthesizer = synthesizer;}
  configureKnowledge(provider: WikiPaperKnowledgeProvider): void {this.paperKnowledge = provider;}
  configureSearch(embeddings: ResearchEmbeddingService): void {this.navigation.configure(embeddings);}
  ensurePaperPage(projectId: string, documentId: string, title: string): void {
    this.requireProject(projectId);
    const changed = this.db.prepare(`INSERT INTO research_wiki_pages(id,project_id,kind,title,source_document_id,selection_json,updated_at)
      VALUES (?,?,'source',?,?,'{"evidenceIds":[],"claimIds":[]}',?)
      ON CONFLICT(project_id,source_document_id) DO UPDATE SET title=excluded.title
      WHERE research_wiki_pages.title<>excluded.title`).run(`wiki_${randomUUID()}`, projectId, title.slice(0, 300), documentId, this.now());
    if (changed.changes) this.paperChanged(documentId);
  }

  /** Only already-published, project-visible parsed knowledge can create an acquisition source page. */
  prepareAcquisitionSource(projectId: string | null, documentId: string): {knowledgeId: string} | null {
    const source = this.acquisitionKnowledge(projectId, documentId);
    if (!source) return null;
    if (projectId !== null) this.ensurePaperPage(projectId, documentId, source.title);
    return {knowledgeId: source.id};
  }

  acquisitionLibrarySource(documentId: string): {receipt: AcquisitionWikiSource; sections: WikiSection[]} {
    const source = this.acquisitionKnowledge(null, documentId);
    const card = source ? this.db.prepare('SELECT knowledge_id,generation,status,snapshot_json FROM research_paper_cards WHERE document_id=?')
      .get(documentId) as {knowledge_id: string; generation: string; status: string; snapshot_json: string | null} | undefined : undefined;
    const ready = !!card && this.currentPaperVersion(null, documentId) !== null;
    const status = !source ? 'missing' : !card ? 'pending' : card.status === 'failed' ? 'failed' :
      card.status !== 'ready' ? 'pending' : ready ? 'ready' : 'stale';
    return {receipt: {documentId, pageId: null, revision: 0, publication: 'paper_card', generation: card?.generation ?? null,
      ready, status, error: ready ? null : {code: status === 'missing' ? 'wiki_source_missing' : status === 'failed'
        ? 'wiki_paper_card_failed' : status === 'stale' ? 'wiki_source_stale' : 'wiki_paper_card_pending', retryable: true}},
      sections: ready ? (JSON.parse(card!.snapshot_json!) as unknown[]).map(section => wikiSectionSchema.parse(section)) : []};
  }

  retryAcquisitionLibrarySource(documentId: string): void {
    const source = this.acquisitionKnowledge(null, documentId);
    if (!source) return;
    this.db.prepare("UPDATE research_paper_cards SET generation=?,status='queued',error=NULL WHERE document_id=? AND knowledge_id=?")
      .run(randomUUID(), documentId, source.id);
    this.paperChanged(documentId);
  }

  acquisitionSource(projectId: string | null, documentId: string): {receipt: AcquisitionWikiSource; snapshot: AcquisitionWikiSnapshot | null} {
    if (projectId === null) return {receipt: this.acquisitionLibrarySource(documentId).receipt, snapshot: null};
    this.requireProject(projectId);
    const source = this.acquisitionKnowledge(projectId, documentId);
    const row = source ? this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? AND source_document_id=?')
      .get(projectId, documentId) as PageRow | undefined : undefined;
    const receipt: AcquisitionWikiSource = {documentId, pageId: row?.id ?? null, revision: row?.revision ?? 0,
      ready: false, status: 'missing', publication: 'wiki_page', generation: null,
      error: {code: 'wiki_source_missing', retryable: true}};
    const fail = (status: AcquisitionWikiSource['status'], code: NonNullable<AcquisitionWikiSource['error']>['code']) =>
      ({receipt: {...receipt, status, error: {code, retryable: true}}, snapshot: null});
    if (!source) return {receipt, snapshot: null};
    const card = this.db.prepare('SELECT knowledge_id,version,generation,status,snapshot_json FROM research_paper_cards WHERE document_id=?')
      .get(documentId) as {knowledge_id: string; version: string; generation: string; status: string; snapshot_json: string | null} | undefined;
    if (!card) return fail('pending', 'wiki_paper_card_pending');
    receipt.generation = card.generation;
    if (card.knowledge_id !== source.id) return fail('stale', 'wiki_source_stale');
    if (card.status === 'failed') return fail('failed', 'wiki_paper_card_failed');
    if (card.status !== 'ready') return fail('pending', 'wiki_paper_card_pending');
    if (!row || row.revision === 0) return fail('pending', 'wiki_source_pending');
    try {
      const page = this.read(projectId, row.id);
      if (page.page.job?.status === 'failed') return fail('failed', 'wiki_source_failed');
      if (page.page.job?.status !== 'ready') return fail('pending', 'wiki_source_pending');
      if (this.currentPaperVersion(projectId, documentId) !== card.version) return fail('stale', 'wiki_source_invalid');
      const stored = (JSON.parse(card.snapshot_json!) as unknown[]).map(section => wikiSectionSchema.parse(section));
      const sections = stored.map(section => page.current?.sections.find(item => item.id === section.id));
      if (stored.length !== 6 || !paperCardRoles.every(role => stored.some(section => section.id === `paper:${role}`)) || sections.some((section, index) =>
        !section || section.status !== 'current' || !section.dependencies.some(dep => dep.kind === 'paper' && dep.id === documentId && dep.digest === card.version) ||
        (section.body !== 'unknown' && !section.paperSources?.length) ||
        (section.owner === 'system' && hash(section) !== hash(stored[index])))) return fail('stale', 'wiki_source_stale');
      const current = sections as WikiSection[];
      const references = [...new Map(current.flatMap(section => section.paperSources ?? []).map(ref => [ref.chunkId, ref])).values()];
      if (!references.length || references.some(ref => !this.paperSourceCurrent(projectId, documentId, source.id, ref))) {
        return fail('stale', 'wiki_source_stale');
      }
      const ready: AcquisitionWikiSource = {...receipt, ready: true, status: 'ready', error: null};
      return {receipt: ready, snapshot: {receipt: ready, page, version: card.version, sections: current,
        originals: references.map(ref => ({source: ref, text: this.db.prepare('SELECT content FROM research_knowledge_chunks WHERE id=?')
          .pluck().get(ref.chunkId) as string}))}};
    } catch {return fail('failed', 'wiki_source_invalid');}
  }

  /** Union newly-ready candidates into one durable operation selection; verification decides actual coverage. */
  reconcileAcquisitionBatch(input: AcquisitionWikiBatchInput): AcquisitionWikiBatch {
    const request = acquisitionWikiBatchSchema.parse(input);
    if (new Set(request.readyDocumentIds).size > request.total) throw new Error('wiki_batch_source_limit');
    if (request.projectId === null) {
      const sources = [...new Set(request.readyDocumentIds)].map(documentId => this.acquisitionLibrarySource(documentId).receipt);
      return {pageId: null, revision: 0, ready: false, status: 'blocked', sources,
        coverage: {total: request.total, readySources: sources.filter(source => source.ready).length, covered: 0,
          missing: request.total, complete: false}, error: {code: 'wiki_project_required', retryable: false}};
    }
    const projectId = request.projectId;
    this.requireProject(projectId);
    const pageId = acquisitionWikiPageId(projectId, request.batchId);
    this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? AND id=?')
        .get(projectId, pageId) as PageRow | undefined;
      const old = previous ? (JSON.parse(previous.selection_json) as Selection).acquisitionBatch : undefined;
      if (previous && (!old || old.batchId !== request.batchId)) throw new Error('wiki_batch_identity_conflict');
      const documentIds = [...new Set([...(old?.documentIds ?? []), ...request.readyDocumentIds])].sort();
      if (documentIds.length > 50 || documentIds.length > request.total) throw new Error('wiki_batch_source_limit');
      const selection: Selection = {evidenceIds: [], claimIds: [], acquisitionBatch: {
        batchId: request.batchId, total: request.total, documentIds}};
      const json = JSON.stringify(selection);
      this.db.prepare(`INSERT INTO research_wiki_pages(id,project_id,kind,title,selection_json,updated_at) VALUES (?,?,'topic',?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,selection_json=excluded.selection_json`)
        .run(pageId, projectId, request.title, json, this.now());
      if (!previous || previous.title !== request.title || previous.selection_json !== json ||
        !this.summary(previous).job || this.summary(previous).job?.status === 'failed') this.enqueue(pageId);
      this.indexDependencies(pageId, documentIds.map(documentId => ({kind: 'paper', id: documentId, digest: ''})));
    })();
    try {
      this.db.transaction(() => {
        const row = this.row(projectId, pageId);
        this.compileAcquisitionBatch(row, (JSON.parse(row.selection_json) as Selection).acquisitionBatch!);
        this.db.prepare("UPDATE research_wiki_jobs SET status='ready',error=NULL WHERE page_id=?").run(pageId);
      })();
    } catch {
      this.db.prepare("UPDATE research_wiki_jobs SET status='failed',error='专题生成失败，可单独重试 Wiki。' WHERE page_id=?").run(pageId);
    }
    return this.readAcquisitionBatch(projectId, request.batchId)!;
  }

  readAcquisitionBatch(projectId: string, batchId: string): AcquisitionWikiBatch | null {
    this.requireProject(projectId);
    const pageId = acquisitionWikiPageId(projectId, batchId);
    const row = this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? AND id=?').get(projectId, pageId) as PageRow | undefined;
    if (!row) return null;
    const selection = (JSON.parse(row.selection_json) as Selection).acquisitionBatch;
    if (!selection || selection.batchId !== batchId) throw new Error('wiki_batch_identity_conflict');
    const states = selection.documentIds.map(documentId => this.acquisitionSource(projectId, documentId));
    const snapshots = states.flatMap(state => state.snapshot ? [state.snapshot] : []), page = this.read(projectId, pageId);
    const sections = page.current?.sections ?? [], generated = sections.filter(section => section.owner === 'system');
    const expected = acquisitionWikiSections(selection, snapshots).map(section => wikiSectionSchema.parse(section));
    const overridden = expected.filter(section => sections.some(item => item.id === section.id && item.owner !== 'system'));
    const current = expected.filter(section => !overridden.some(item => item.id === section.id))
      .every(section => generated.some(item => item.status === 'current' && hash(item) === hash(section))) &&
      generated.every(section => expected.some(item => item.id === section.id));
    const included = new Set(generated.filter(section => section.status === 'current').flatMap(section => section.paperSources ?? [])
      .map(ref => ref.documentId));
    const covered = snapshots.filter(snapshot => included.has(snapshot.receipt.documentId)).length;
    const ready = page.page.job?.status === 'ready' && current && covered > 0 && covered === snapshots.length &&
      !overridden.some(section => section.id === 'acquisition:coverage');
    const failed = page.page.job?.status === 'failed', stale = !current || sections.some(section => section.owner === 'system' && section.status === 'stale');
    return {pageId, revision: page.page.revision, ready,
      status: failed ? 'failed' : ready ? covered === selection.total ? 'ready' : 'partial' : stale ? 'stale' : 'pending',
      coverage: {total: selection.total, readySources: snapshots.length, covered, missing: selection.total - covered,
        complete: ready && covered === selection.total},
      sources: states.map(state => state.receipt), error: failed ? {code: 'wiki_topic_failed', retryable: true} : ready ? null :
        overridden.length ? {code: 'wiki_topic_human_override', retryable: false} : stale ? {code: 'wiki_topic_stale', retryable: true} : null};
  }
  paperChanged(documentId: string): void {
    const pages = this.db.prepare(`SELECT id FROM research_wiki_pages WHERE source_document_id=?
      OR id IN (SELECT page_id FROM research_wiki_dependencies WHERE kind='paper' AND dependency_id=?)`)
      .all(documentId, documentId) as Array<{id: string}>;
    for (const page of pages) this.enqueue(page.id);
    this.wake();
  }

  /** Queue affected pages once per observed knowledge basis; historical sections keep their old dependencies. */
  paperKnowledgeChanged(projectId: string, documentId: string | null): void {
    const pages = this.db.prepare(`SELECT DISTINCT p.id,p.revision FROM research_wiki_pages p
      JOIN research_wiki_dependencies d ON d.page_id=p.id
      WHERE p.project_id=? AND d.kind='paper_knowledge' AND (? IS NULL OR d.dependency_id=?)`)
      .all(projectId, documentId, documentId) as Array<{id: string; revision: number}>;
    let queued = false;
    for (const page of pages) {
      if (page.revision === 0) continue;
      const dependencies = this.revision(projectId, page.id, page.revision).sections
        .flatMap(section => section.dependencies.filter(dep => dep.kind === 'paper_knowledge'));
      const actual = [...new Map(dependencies.map(dep => [dep.id, this.currentDigest(projectId, dep)])).entries()].sort();
      if (!dependencies.some(dep => actual.find(([id]) => id === dep.id)?.[1] !== dep.digest)) continue;
      const basis = hash(actual), observed = this.knowledgeInvalidations.get(page.id);
      const job = this.db.prepare('SELECT generation FROM research_wiki_jobs WHERE page_id=?').get(page.id) as {generation: string} | undefined;
      // A transaction rollback also rolls back the job; an in-memory observation alone cannot suppress it.
      if (observed?.basis === basis && observed.generation === job?.generation) continue;
      const generation = this.enqueue(page.id);
      this.knowledgeInvalidations.set(page.id, {basis, generation});
      queued = true;
    }
    if (queued) this.wake();
  }

  refreshPaperKnowledgeDependencies(): void {
    const projects = this.db.prepare(`SELECT DISTINCT p.project_id FROM research_wiki_pages p
      JOIN research_wiki_dependencies d ON d.page_id=p.id WHERE d.kind='paper_knowledge'`).all() as Array<{project_id: string}>;
    for (const {project_id} of projects) this.paperKnowledgeChanged(project_id, null);
  }

  async search(projectId: string, query = '', offset = 0, filters: WikiSearchFilters = {}): Promise<WikiSearchResult> {
    this.requireProject(projectId);
    if (!query.trim()) {
      const rows = (this.db.prepare('SELECT * FROM research_wiki_pages WHERE project_id=? ORDER BY updated_at DESC,id')
        .all(projectId) as PageRow[]).map(row => this.summary(row)).filter(page => wikiMatchesFilters(page, filters));
      return {pages: rows.slice(offset, offset + 50).map(page => ({...page, matches: []})), mode: 'list', degradation: null,
        indexedSections: 0, totalSections: 0, nextOffset: rows.length > offset + 50 ? offset + 50 : null};
    }
    const verified = new Map<string, Promise<WikiPage>>();
    const {hits, ...receipt} = await this.navigation.search(projectId, query, offset, filters, async (pageId, sectionId) => {
      let current = verified.get(pageId);
      if (!current) {current = this.readCurrent(projectId, pageId); verified.set(pageId, current);}
      return (await current).current?.sections.some(section => section.id === sectionId && section.status === 'current') ?? false;
    });
    return {...receipt, pages: hits.flatMap(hit => {
      const row = this.row(projectId, hit.pageId);
      return row.revision === hit.revision ? [{...this.summary(row), matches: hit.matches}] : [];
    })};
  }

  create(input: z.infer<typeof wikiCreateSchema>): WikiPage {
    const request = wikiCreateSchema.parse(input);
    this.requireProject(request.projectId);
    const id = `wiki_${randomUUID()}`;
    this.db.transaction(() => {
      this.dependencies(request.projectId, request.evidenceIds, request.claimIds);
      const scientific = this.knowledgeDependencies(request.projectId, request.paperKnowledgeSources ?? []);
      this.db.prepare(`INSERT INTO research_wiki_pages(id,project_id,kind,title,selection_json,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(id, request.projectId, request.kind, request.title, JSON.stringify({
          evidenceIds: request.evidenceIds, claimIds: request.claimIds,
          ...(request.template ? {template: request.template} : {}),
          ...(request.paperKnowledgeSources ? {paperKnowledgeSources: request.paperKnowledgeSources} : {})}), this.now());
      this.enqueue(id);
      // Seed dependencies before the first worker runs, so edits/deletes cannot escape the outbox.
      this.indexDependencies(id, [...this.dependencies(request.projectId, request.evidenceIds, request.claimIds), ...scientific]);
    })();
    this.wake();
    return this.read(request.projectId, id);
  }

  read(projectId: string, pageId: string, verifiedKnowledge?: ReadonlyMap<string, string | null>): WikiPage {
    return this.db.transaction(() => {
      const row = this.row(projectId, pageId), current = row.revision === 0 ? null : this.revision(projectId, pageId, row.revision);
      const lint: WikiPage['lint'] = [], sources: WikiPage['sources'] = [], links: WikiSummary[] = [];
      const sections = current?.sections.map(section => ({...section})) ?? [];
      const dependencyStates = new Map<string, string | null>();
      for (const section of sections) {
        if (section.evidenceIds.length === 0) lint.push({code: 'uncited', sectionId: section.id, message: section.paperKnowledgeSources?.length
          ? '结构化科研知识是来源校验后的未审核抽取；请回到原始 PDF 核查科学支持。' : section.paperSources?.length
          ? '论文卡片是未审核派生理解；请回到原文并捕获 Evidence 后核查科学支持。' : '此章节没有原始证据引用；不能据此确认科学支持。'});
        for (const dep of section.dependencies) {
          const key = `${dep.kind}:${dep.id}`;
          if (!dependencyStates.has(key)) dependencyStates.set(key, dep.kind === 'paper_knowledge' && verifiedKnowledge?.has(dep.id)
            ? verifiedKnowledge.get(dep.id)! : this.currentDigest(projectId, dep));
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
        paperJob: row.source_document_id ? this.db.prepare('SELECT generation,status,error FROM research_paper_cards WHERE document_id=?').get(row.source_document_id) as WikiPage['paperJob'] ?? null : null,
        basisDigest: hash([...dependencyStates].sort()), lint, sources, links};
    })();
  }

  /** Public reads verify bytes afresh. Synchronous reads remain available for the transaction-local CAS fence. */
  async readCurrent(projectId: string, pageId: string, signal = new AbortController().signal): Promise<WikiPage> {
    const page = this.read(projectId, pageId);
    const sources = this.knowledgeSources(page.current?.sections ?? []);
    const verified = await this.verifyKnowledgeSources(projectId, sources, signal, false);
    signal.throwIfAborted();
    if (this.row(projectId, pageId).revision !== page.page.revision) throw new Error('wiki_revision_conflict');
    return this.read(projectId, pageId, verified);
  }

  async createCurrent(input: z.infer<typeof wikiCreateSchema>, signal = new AbortController().signal): Promise<WikiPage> {
    const request = wikiCreateSchema.parse(input);
    this.requireProject(request.projectId);
    await this.verifyKnowledgeSources(request.projectId, request.paperKnowledgeSources ?? [], signal, true);
    signal.throwIfAborted();
    return this.create(request);
  }

  async readRelationsCurrent(projectId: string, pageId: string, signal = new AbortController().signal) {
    const page = await this.readCurrent(projectId, pageId, signal);
    const sources = this.knowledgeSources(page.current?.sections.filter(section => section.status === 'current') ?? []);
    if (!sources.length) return [];
    const relations = projectWikiRelations(await this.readScientificBasis(projectId, sources, signal));
    if (this.row(projectId, pageId).revision !== page.page.revision || this.read(projectId, pageId).basisDigest !== page.basisDigest) {
      throw new Error('wiki_basis_changed');
    }
    return relations;
  }

  /** Explicitly enroll new papers in selected sections; unrelated prose and human ownership are immutable. */
  async updateSourcesCurrent(input: z.infer<typeof wikiUpdateSourcesSchema>, signal = new AbortController().signal): Promise<WikiPage> {
    const request = wikiUpdateSourcesSchema.parse(input);
    const page = await this.readCurrent(request.projectId, request.pageId, signal);
    if (page.page.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
    if (page.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
    if (page.page.kind === 'source') throw new Error('wiki_topic_required');
    const targets = request.sectionIds.map(id => page.current?.sections.find(section => section.id === id));
    if (targets.some(section => !section || section.owner !== 'assistant')) throw new Error('wiki_human_section_protected');
    await this.verifyKnowledgeSources(request.projectId, request.paperKnowledgeSources, signal, true);
    const verified = await this.readCurrent(request.projectId, request.pageId, signal);
    if (verified.page.revision !== request.expectedRevision || verified.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
    signal.throwIfAborted();
    return this.db.transaction(() => {
      signal.throwIfAborted();
      const row = this.row(request.projectId, request.pageId), current = this.read(request.projectId, request.pageId);
      if (row.revision !== request.expectedRevision || current.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
      const dependencies = this.knowledgeDependencies(request.projectId, request.paperKnowledgeSources);
      const selection = JSON.parse(row.selection_json) as Selection;
      const all = [...new Map([...(selection.paperKnowledgeSources ?? []), ...request.paperKnowledgeSources]
        .map(source => [source.documentId, source])).values()];
      if (all.length > 12) throw new Error('wiki_source_limit');
      const sections = current.current!.sections.map(section => request.sectionIds.includes(section.id) ? {
        ...section, status: 'stale' as const,
        // Dependencies track the old prose. New selected inputs are pending, never retroactive validation.
        paperKnowledgeSources: [...new Map([...(section.paperKnowledgeSources ?? []), ...request.paperKnowledgeSources]
          .map(source => [source.documentId, source])).values()]
      } : section);
      for (const source of request.paperKnowledgeSources) {
        const id = `knowledge:${source.documentId}`, existing = sections.find(section => section.id === id);
        if (existing?.owner === 'human') continue;
        const fresh: WikiSection = {id, title: '结构化科研知识 · 原始来源',
          body: '新增来源已登记；选定章节待重新综合。来源校验不代表科学结论已确认。',
          owner: 'system', status: 'current', evidenceIds: [], claimIds: [], links: [],
          paperKnowledgeSources: [source], dependencies: dependencies.filter(dep => dep.id === source.documentId)};
        if (existing) sections[sections.indexOf(existing)] = fresh;
        else sections.push(fresh);
      }
      this.db.prepare('UPDATE research_wiki_pages SET selection_json=? WHERE id=?')
        .run(JSON.stringify({...selection, paperKnowledgeSources: all}), row.id);
      this.publish({...row, selection_json: JSON.stringify({...selection, paperKnowledgeSources: all})}, sections, 'compile');
      return this.read(request.projectId, request.pageId);
    })();
  }

  async saveCurrent(input: z.infer<typeof wikiSaveSchema>, owner: 'human' | 'assistant',
    signal = new AbortController().signal): Promise<WikiPage> {
    const request = wikiSaveSchema.parse(input);
    this.row(request.projectId, request.pageId);
    const scientific = request.section.scientificStatements
      ? await this.readScientificBasis(request.projectId, request.section.paperKnowledgeSources ?? [], signal) : undefined;
    if (owner === 'assistant' && scientific === undefined) {
      await this.verifyKnowledgeSources(request.projectId, request.section.paperKnowledgeSources ?? [], signal, true);
    }
    signal.throwIfAborted();
    return this.save(request, owner, scientific);
  }

  async readSectionCurrent(input: z.infer<typeof wikiSectionReadSchema>, signal = new AbortController().signal) {
    const request = wikiSectionReadSchema.parse(input), page = await this.readCurrent(request.projectId, request.pageId, signal);
    if (page.page.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
    const section = page.current?.sections.find(item => item.id === request.sectionId);
    if (!section) throw new Error('wiki_section_not_found');
    const end = request.offset + request.maxChars;
    return {page: page.page, basisDigest: page.basisDigest, section: {...section, body: section.body.slice(request.offset, end)},
      nextOffset: section.body.length > end ? end : null};
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

  save(input: z.infer<typeof wikiSaveSchema>, owner: 'human' | 'assistant', scientific?: ScientificWikiBasis): WikiPage {
    const request = wikiSaveSchema.parse(input);
    if (owner === 'human') requireResearchHuman('research.wiki.save', request.projectId);
    return this.db.transaction(() => {
      const page = this.read(request.projectId, request.pageId), row = this.row(request.projectId, request.pageId);
      if (row.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
      if (page.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
      const sections = page.current!.sections, previous = sections.find(section => section.id === request.section.id);
      if (owner === 'assistant' && previous?.owner === 'human') throw new Error('wiki_human_section_protected');
      if (request.section.scientificStatements) {
        if (!scientific) throw new Error('wiki_scientific_sources_unverified');
        assertScientificWikiSection(request.section, scientific);
      } else if (owner === 'assistant' && previous?.scientificStatements) throw new Error('wiki_scientific_synthesis_required');
      // Assistant synthesis may use only this page's read, current source set; new sources need a new page selection.
      const allowed = new Set(page.sources.filter(source => source.status === 'recorded').map(source => source.evidenceId));
      const paperSources = request.section.paperSources ?? [];
      const scientificSources = request.section.paperKnowledgeSources ?? [];
      for (const source of scientificSources) {
        if (!sections.some(section => section.paperKnowledgeSources?.some(item =>
          item.documentId === source.documentId && item.generationId === source.generationId))) {
          throw new Error('wiki_current_sources_required');
        }
      }
      for (const source of paperSources) {
        if (!sections.some(section => section.paperSources?.some(item => JSON.stringify(item) === JSON.stringify(source)))) throw new Error('wiki_current_sources_required');
        if (owner === 'assistant' && this.knowledge.chunkVersion(source.chunkId, request.projectId).indexedVersion !== source.indexedVersion) throw new Error('wiki_current_sources_required');
      }
      if (owner === 'assistant' && (request.section.evidenceIds.length + paperSources.length + scientificSources.length === 0 || request.section.evidenceIds.some(id => !allowed.has(id)) ||
        request.section.claimIds.some(id => !sections.some(section => section.claimIds.includes(id))))) throw new Error('wiki_current_sources_required');
      for (const link of request.section.links) this.row(request.projectId, link);
      const section: WikiSection = {...request.section, owner, status: 'current',
        dependencies: [...this.dependencies(request.projectId, request.section.evidenceIds, request.section.claimIds),
          ...(owner === 'human' ? sections.filter(item => item.paperSources?.some(source => paperSources.some(ref => ref.chunkId === source.chunkId)))
            .flatMap(item => item.dependencies.filter(dep => dep.kind === 'paper')) : this.paperDependencies(request.projectId, paperSources)),
          ...(owner === 'human' ? sections.filter(item => item.paperKnowledgeSources?.some(source => scientificSources.some(ref =>
            ref.documentId === source.documentId && ref.generationId === source.generationId)))
            .flatMap(item => item.dependencies.filter(dep => dep.kind === 'paper_knowledge' && scientificSources.some(ref => ref.documentId === dep.id)))
            : this.knowledgeDependencies(request.projectId, scientificSources))]};
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

  readSection(input: z.infer<typeof wikiSectionReadSchema>): {page: WikiSummary; basisDigest: string; section: WikiSection; nextOffset: number | null} {
    const request = wikiSectionReadSchema.parse(input), page = this.read(request.projectId, request.pageId);
    if (page.page.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
    const section = page.current?.sections.find(item => item.id === request.sectionId);
    if (!section) throw new Error('wiki_section_not_found');
    const end = request.offset + request.maxChars;
    return {page: page.page, basisDigest: page.basisDigest, section: {...section, body: section.body.slice(request.offset, end)},
      nextOffset: section.body.length > end ? end : null};
  }

  async resynthesize(input: z.infer<typeof wikiResynthesizeSchema>, requestSignal = new AbortController().signal): Promise<WikiPage> {
    const request = wikiResynthesizeSchema.parse(input);
    const signal = AbortSignal.any([requestSignal, this.synthesisController.signal, AbortSignal.timeout(60000)]);
    signal.throwIfAborted();
    const trace = this.compilationTrace(this.row(request.projectId, request.pageId), `synthesis:${randomUUID()}`);
    const task = trace.run('wiki_compile', async () => await this.resynthesizeImpl(request, signal),
      {inputCount: request.sectionIds.length, unit: 'sections'}, () => request.sectionIds.length);
    this.syntheses.add(task);
    try {return await task;} finally {this.syntheses.delete(task);}
  }

  private async resynthesizeImpl(request: z.infer<typeof wikiResynthesizeSchema>, signal: AbortSignal): Promise<WikiPage> {
    const page = await this.readCurrent(request.projectId, request.pageId, signal);
    if (page.page.revision !== request.expectedRevision) throw new Error('wiki_revision_conflict');
    if (page.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
    const sections = request.sectionIds.map(id => page.current?.sections.find(section => section.id === id));
    if (sections.some(section => !section || section.owner !== 'assistant' || section.status !== 'stale')) throw new Error('wiki_stale_assistant_required');
    if (!this.synthesizer) throw new Error('wiki_model_unavailable');
    const sources = page.sources.filter(source => source.status === 'recorded').slice(0, 12);
    const paperSources = [...new Map(page.current!.sections.filter(section => section.status === 'current')
      .flatMap(section => section.paperSources ?? []).map(source => [source.chunkId, source])).values()].slice(0, 12);
    const originals = paperSources.map(source => ({source, text: this.knowledge.chunkContext(request.projectId, source.chunkId, 1200).content}));
    const requestedDocuments = new Set(sections.flatMap(section => section?.paperKnowledgeSources?.map(source => source.documentId) ?? []));
    const knowledgeSources = this.knowledgeSources(page.current!.sections.filter(section => section.status === 'current'))
      .filter(source => requestedDocuments.size === 0 || requestedDocuments.has(source.documentId));
    if (sections.some(section => section?.paperKnowledgeSources?.some(old =>
      !knowledgeSources.some(source => source.documentId === old.documentId)))) throw new Error('wiki_current_sources_required');
    const scientific = knowledgeSources.length ? await this.readScientificBasis(request.projectId, knowledgeSources, signal) : undefined;
    const proposals = await this.synthesizer({sections: sections as WikiSection[],
      evidence: sources.map(source => ({...source, excerpt: source.excerpt.slice(0, 1200)})), originals,
      ...(scientific ? {scientific} : {})},
    signal);
    signal.throwIfAborted();
    if (proposals.length !== sections.length || new Set(proposals.map(section => section.id)).size !== sections.length ||
        proposals.some(section => !request.sectionIds.includes(section.id))) throw new Error('wiki_section_selection_changed');
    if (scientific) for (const section of proposals) assertScientificWikiSection(section, scientific);
    // Read the actual PDF/IR bytes again after inference, then keep only synchronous fences in the publication transaction.
    const currentScientific = scientific
      ? await this.readScientificBasis(request.projectId, knowledgeSources, signal) : undefined;
    const verified = await this.readCurrent(request.projectId, request.pageId, signal);
    if (verified.page.revision !== request.expectedRevision || verified.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
    signal.throwIfAborted();
    return this.db.transaction(() => {
      signal.throwIfAborted();
      let current = this.read(request.projectId, request.pageId);
      if (current.page.revision !== request.expectedRevision || current.basisDigest !== request.expectedBasisDigest) throw new Error('wiki_basis_changed');
      for (const section of proposals) current = this.save({
        projectId: request.projectId, pageId: request.pageId, expectedRevision: current.page.revision,
        expectedBasisDigest: current.basisDigest, section}, 'assistant', currentScientific);
      return current;
    })();
  }

  start(): void {
    this.db.prepare("UPDATE research_wiki_jobs SET status='queued',error=NULL WHERE status='running'").run();
    this.stopped = false;
    if (this.timer === null) {this.timer = setInterval(() => this.wake(), 1000); this.timer.unref();}
    this.wake();
  }
  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.running !== null) return;
    this.running = Promise.resolve().then(async () => {
      do {
        this.dirty = false;
        while (!this.stopped && this.compileNext()) await new Promise<void>(resolve => setImmediate(resolve));
      } while (!this.stopped && this.dirty);
    }).finally(() => {
      this.running = null;
      if (!this.stopped && this.dirty) this.wake();
    });
  }
  async idle(): Promise<void> {while (this.running) await this.running; await this.navigation.idle();}
  async shutdown(): Promise<void> {
    this.stopped = true; this.dirty = false; this.synthesisController.abort();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null; await this.running;
    await Promise.allSettled([...this.syntheses]); await this.navigation.shutdown();
  }

  /** Each compilation publishes a complete snapshot within one SQLite transaction. */
  compileNext(): boolean {
    const job = this.db.prepare("SELECT page_id,generation FROM research_wiki_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {page_id: string; generation: string} | undefined;
    if (job === undefined) return false;
    this.db.prepare("UPDATE research_wiki_jobs SET status='running' WHERE page_id=? AND generation=?").run(job.page_id, job.generation);
    const row = this.db.prepare('SELECT * FROM research_wiki_pages WHERE id=?').get(job.page_id) as PageRow;
    const trace = this.compilationTrace(row, job.generation);
    const previousCount = this.db.prepare(`SELECT json_array_length(snapshot_json,'$.sections')
      FROM research_wiki_revisions WHERE page_id=? AND revision=?`).pluck().get(row.id, row.revision);
    const span = trace.start('wiki_compile', {inputCount: typeof previousCount === 'number' ? previousCount : 0, unit: 'sections'});
    try {
      const count = this.db.transaction(() => {
        const selection = JSON.parse(row.selection_json) as Selection;
        if (selection.acquisitionBatch) {
          const count = this.compileAcquisitionBatch(row, selection.acquisitionBatch);
          this.db.prepare("UPDATE research_wiki_jobs SET status='ready',error=NULL WHERE page_id=? AND generation=?")
            .run(row.id, job.generation);
          return count;
        }
        const previous = this.read(row.project_id, row.id).current?.sections ?? [];
        const retained = previous.filter(section => section.owner !== 'system');
        const evidenceIds = new Set(row.kind === 'source' ? this.sourceIds(row) : selection.evidenceIds);
        const generated: WikiSection[] = [];
        const card = this.db.prepare('SELECT snapshot_json FROM research_paper_cards WHERE document_id=?').pluck().get(row.source_document_id);
        if (typeof card === 'string') generated.push(...(JSON.parse(card) as unknown[]).map(section => wikiSectionSchema.parse(section)));
        for (const selected of selection.paperKnowledgeSources ?? []) {
          const state = this.paperKnowledge?.state(row.project_id, selected.documentId);
          const source = state?.state === 'current' && state.generationId && state.digest
            ? {documentId: selected.documentId, generationId: state.generationId} : null;
          const old = previous.find(section => section.id === `knowledge:${selected.documentId}`);
          if (source) generated.push({
            id: `knowledge:${source.documentId}`, title: '结构化科研知识 · 原始来源',
            body: '实体、事实、关系与完整科学对象独立保存在此来源的抽取代次中。此页引用未审核的来源校验结果；数值和实验条件请回到原始 PDF 核查。',
            owner: 'system', status: 'current', evidenceIds: [], claimIds: [], links: [],
            paperKnowledgeSources: [source], dependencies: this.knowledgeDependencies(row.project_id, [source])
          });
          else if (old) generated.push({...old, status: 'stale'});
          else throw new Error('wiki_current_sources_required');
        }
        if (['topic', 'comparison'].includes(row.kind) && selection.paperKnowledgeSources?.length) {
          const sources = generated.filter(section => section.status === 'current').flatMap(section => section.paperKnowledgeSources ?? []);
          if (sources.length === selection.paperKnowledgeSources.length) {
            generated.push(...(row.kind === 'topic' ? scientificTopicSections : scientificComparisonSections)(
              sources, this.knowledgeDependencies(row.project_id, sources), selection.template));
          }
        }
        for (const claimId of selection.claimIds) {
          if (!this.exists('research_claims', claimId, row.project_id)) continue;
          const claim = this.evidence.getClaim(claimId);
          if (claim.projectId !== row.project_id) throw new Error('wiki_project_mismatch');
          for (const id of claim.evidenceIds) evidenceIds.add(id);
          generated.push({id: `claim:${claimId}`, title: '主张摘录 · 科学支持请查看人工审核',
            body: `实验条件（unknown 表示原文未记录）：\n${JSON.stringify(claim.experiment, null, 2)}\n\n${claim.content}`.slice(0, 6000),
            owner: 'system', status: 'current', evidenceIds: claim.evidenceIds, claimIds: [claimId], links: [],
            dependencies: this.dependencies(row.project_id, claim.evidenceIds, [claimId])});
        }
        if (evidenceIds.size > 50) throw new Error('wiki_source_limit');
        for (const evidenceId of evidenceIds) {
          if (!this.exists('research_evidence', evidenceId, row.project_id)) continue;
          const source = this.evidence.inspectEvidence(evidenceId, row.project_id);
          const target = this.db.prepare(`SELECT id FROM research_wiki_pages WHERE project_id=? AND id<>? AND source_document_id IN
            (?,json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=?),'$.documentId'),
            json_extract((SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id=?),'$.fileId'))`)
            .get(row.project_id, row.id, source.evidence.documentId, evidenceId, evidenceId) as {id: string} | undefined;
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
        this.publish(row, [...refreshed.map(section => {
          if (section.scientificStatements) {
            if (section.body.length > perSection) throw new Error('wiki_scientific_section_budget');
            return section;
          }
          return {...section, body: section.body.slice(0, perSection)};
        }), ...retained], 'compile');
        this.db.prepare("UPDATE research_wiki_jobs SET status='ready',error=NULL WHERE page_id=? AND generation=?")
          .run(row.id, job.generation);
        // Card publication can queue a topic before its source page is compiled. Revisit it afterwards.
        this.enqueueAcquisitionTopics(row);
        return refreshed.length + retained.length;
      })();
      span.finish(undefined, {outputCount: count});
    } catch (error) {
      span.fail(error);
      this.db.prepare("UPDATE research_wiki_jobs SET status='failed',error=? WHERE page_id=? AND generation=?")
        .run(error instanceof Error && error.message === 'wiki_source_limit' ? '引用超过 50 条，请缩小主题范围。' : '编译失败，请检查原始证据与主张是否仍可读取，然后重试。', job.page_id, job.generation);
    }
    return true;
  }

  private compilationTrace(row: PageRow, generation: string): ResearchProcessingTrace {
    const knowledgeId = row.source_document_id ? this.db.prepare(
      'SELECT knowledge_id FROM research_paper_cards WHERE document_id=?').pluck().get(row.source_document_id) : null;
    const related = this.db.prepare(`SELECT DISTINCT k.id FROM research_wiki_dependencies d
      JOIN research_evidence e ON e.id=d.dependency_id
      JOIN research_knowledge_chunks c ON c.id=e.chunk_id
      JOIN research_knowledge_documents k ON k.id=c.document_id
      WHERE d.page_id=? AND d.kind='evidence' ORDER BY k.id LIMIT 50`).all(row.id) as Array<{id: string}>;
    const relatedPapers = related.map(({id}) => {
      const context = this.knowledge.processingContext(id);
      return {paper_id: context.paper_id ?? null, document_id: context.document_id ?? null,
        source_hash: context.source_hash ?? null, parse_id: context.parse_id ?? null,
        parser_fingerprint: context.parser_fingerprint ?? null};
    });
    return this.processing.trace({...(typeof knowledgeId === 'string' ? this.knowledge.processingContext(knowledgeId) : {
      document_id: row.source_document_id}),
      trace_id: `wiki:${row.id}:${generation}`, project_id: row.project_id, wiki_generation: generation,
      related_papers: relatedPapers});
  }

  private publish(row: PageRow, sections: WikiSection[], reason: WikiRevision['reason']): void {
    const snapshot = wikiRevisionSchema.parse({pageId: row.id, revision: row.revision + 1, sections, reason, createdAt: this.now()});
    if (sections.reduce((size, section) => size + section.body.length, 0) > 100000) throw new Error('wiki_page_too_large');
    this.db.prepare('INSERT INTO research_wiki_revisions(page_id,revision,snapshot_json) VALUES (?,?,?)')
      .run(row.id, snapshot.revision, JSON.stringify(snapshot));
    const update = this.db.prepare('UPDATE research_wiki_pages SET revision=?,updated_at=? WHERE id=? AND revision=?')
      .run(snapshot.revision, snapshot.createdAt, row.id, row.revision);
    if (update.changes !== 1) throw new Error('wiki_revision_conflict');
    this.navigation.replace(row.id, snapshot.revision, row.title, sections);
    this.db.prepare('DELETE FROM research_wiki_dependencies WHERE page_id=?').run(row.id);
    this.indexDependencies(row.id, sections.flatMap(section => section.dependencies));
    // Retain selection dependencies even when a human override removes the generated section.
    const selection = JSON.parse(row.selection_json) as Selection;
    for (const documentId of selection.acquisitionBatch?.documentIds ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(row.id, 'paper', documentId);
    }
    for (const source of selection.paperKnowledgeSources ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(row.id, 'paper_knowledge', source.documentId);
    }
    for (const [kind, ids] of [['evidence', selection.evidenceIds], ['claim', selection.claimIds], ['relations', selection.claimIds]] as const) {
      for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(row.id, kind, id);
    }
    if (reason !== 'compile') this.enqueueAcquisitionTopics(row);
  }

  private enqueueAcquisitionTopics(row: PageRow): void {
    if (!row.source_document_id) return;
    const topics = this.db.prepare(`SELECT p.id FROM research_wiki_pages p JOIN research_wiki_dependencies d ON d.page_id=p.id
      WHERE p.project_id=? AND p.kind='topic' AND d.kind='paper' AND d.dependency_id=?
      AND json_type(p.selection_json,'$.acquisitionBatch')='object'`).all(row.project_id, row.source_document_id) as Array<{id: string}>;
    for (const topic of topics) this.enqueue(topic.id);
    if (topics.length) this.wake();
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
    if (dependency.kind === 'paper_knowledge') return this.paperKnowledge?.state(projectId, dependency.id).digest ?? null;
    if (dependency.kind === 'paper') return this.currentPaperVersion(projectId, dependency.id);
    if (!this.exists(dependency.kind === 'evidence' ? 'research_evidence' : 'research_claims', dependency.id, projectId)) return null;
    return this.dependencies(projectId, dependency.kind === 'evidence' ? [dependency.id] : [], dependency.kind !== 'evidence' ? [dependency.id] : [])
      .find(item => item.kind === dependency.kind)!.digest;
  }

  private acquisitionKnowledge(projectId: string | null, documentId: string): AcquisitionKnowledge | null {
    if (projectId !== null) this.requireProject(projectId);
    const document = this.db.prepare('SELECT * FROM research_documents WHERE id=?').get(documentId) as {
      library_item_id: string; status: string; current_parse_id: string | null; active_parse_id: string | null; source_hash: string;
    } | undefined;
    if (document && (document.status !== 'ready' || document.active_parse_id || !document.current_parse_id ||
      (projectId !== null && !this.db.prepare('SELECT 1 FROM research_library_projects WHERE item_id=? AND project_id=?')
        .get(document.library_item_id, projectId)))) return null;
    const rows = this.db.prepare(`SELECT id,title,metadata_json FROM research_knowledge_documents k
      WHERE (json_extract(metadata_json,'$.documentId')=? OR json_extract(metadata_json,'$.fileId')=? OR id=?)
      AND json_type(metadata_json,'$.parseId')='text'
      AND (project_id IS ? OR (? IS NOT NULL AND project_id IS NULL AND EXISTS
        (SELECT 1 FROM research_library_projects WHERE item_id=k.source_id AND project_id=?)))
      ORDER BY rowid DESC`).all(documentId, documentId, documentId, projectId, projectId, projectId) as AcquisitionKnowledge[];
    return rows.find(row => {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      return !document || (metadata.parseId === document.current_parse_id && metadata.sourceHash === document.source_hash);
    }) ?? null;
  }

  private paperSourceCurrent(projectId: string | null, documentId: string, knowledgeId: string, source: PaperSource): boolean {
    try {
      if (source.documentId !== documentId || source.knowledgeDocumentId !== knowledgeId) return false;
      const current = this.knowledge.chunkVersion(source.chunkId, projectId);
      if (current.documentId !== knowledgeId || current.indexedVersion !== source.indexedVersion || current.locator !== source.locator) return false;
      const semantic = this.knowledge.chunkSemantic(source.chunkId);
      // Compare fields by name, independent of JSON property order in historical publications.
      if (!semantic || Object.entries(semantic).some(([key, value]) => hash(value) !== hash(source[key as keyof PaperSource]))) return false;
      const metadata = JSON.parse(this.db.prepare('SELECT metadata_json FROM research_knowledge_documents WHERE id=?')
        .pluck().get(knowledgeId) as string) as Record<string, unknown>;
      return metadata.parseId === source.parseId && metadata.sourceHash === source.sourceHash;
    } catch {return false;}
  }

  private currentPaperVersion(projectId: string | null, documentId: string): string | null {
    const source = this.acquisitionKnowledge(projectId, documentId);
    if (!source) return null;
    const card = this.db.prepare("SELECT knowledge_id,version,snapshot_json FROM research_paper_cards WHERE document_id=? AND status='ready'")
      .get(documentId) as {knowledge_id: string; version: string; snapshot_json: string | null} | undefined;
    if (!card?.snapshot_json || card.knowledge_id !== source.id) return null;
    try {
      const sections = (JSON.parse(card.snapshot_json) as unknown[]).map(section => wikiSectionSchema.parse(section));
      if (sections.length !== 6 || !paperCardRoles.every(role => sections.some(section => section.id === `paper:${role}`)) ||
        sections.some(section => section.status !== 'current' || section.owner !== 'system' ||
          !section.dependencies.some(dep => dep.kind === 'paper' && dep.id === documentId && dep.digest === card.version) ||
          (section.body !== 'unknown' && !section.paperSources?.length))) return null;
      const references = sections.flatMap(section => section.paperSources ?? []);
      return references.length && references.every(ref => this.paperSourceCurrent(projectId, documentId, source.id, ref)) ? card.version : null;
    } catch {return null;}
  }

  private compileAcquisitionBatch(row: PageRow, selection: AcquisitionWikiSelection): number {
    const snapshots = selection.documentIds.flatMap(documentId => {
      const {snapshot} = this.acquisitionSource(row.project_id, documentId);
      return snapshot ? [snapshot] : [];
    });
    const previous = row.revision ? this.revision(row.project_id, row.id, row.revision).sections : [];
    const retained = previous.filter(section => section.owner !== 'system');
    const generated = acquisitionWikiSections(selection, snapshots).filter(section => !retained.some(item => item.id === section.id));
    const sections = [...generated, ...retained].map(section => wikiSectionSchema.parse(section));
    if (!row.revision || hash(sections) !== hash(previous)) this.publish(row, sections, 'compile');
    else {
      const indexed = this.db.prepare('SELECT section_id,input_text,revision FROM research_wiki_sections WHERE page_id=?')
        .all(row.id) as Array<{section_id: string; input_text: string; revision: number}>;
      if (indexed.length !== sections.length || sections.some(section => !indexed.some(item => item.section_id === section.id &&
        item.revision === row.revision && item.input_text === `${row.title}\n${section.title}\n${section.body}`))) {
        this.navigation.replace(row.id, row.revision, row.title, sections);
      }
    }
    return sections.length;
  }
  private knowledgeDependencies(projectId: string, sources: WikiPaperKnowledgeSource[]): WikiDependency[] {
    return sources.map(source => {
      const state = this.paperKnowledge?.state(projectId, source.documentId);
      if (state?.state !== 'current' || state.generationId !== source.generationId || !state.digest) {
        throw new Error('wiki_current_sources_required');
      }
      return {kind: 'paper_knowledge', id: source.documentId, digest: state.digest};
    });
  }
  private knowledgeSources(sections: WikiSection[]): WikiPaperKnowledgeSource[] {
    return [...new Map(sections.flatMap(section => section.paperKnowledgeSources ?? [])
      .map(source => [`${source.documentId}:${source.generationId}`, source])).values()];
  }
  private async readScientificBasis(projectId: string, sources: WikiPaperKnowledgeSource[], signal: AbortSignal): Promise<ScientificWikiBasis> {
    if (!sources.length || !this.paperKnowledge) throw new Error('wiki_current_sources_required');
    const knowledge: ScientificWikiBasis['knowledge'] = [];
    for (const source of sources) {
      signal.throwIfAborted();
      const read = paperCardKnowledgeSchema.parse(await this.paperKnowledge.read(projectId, source, signal));
      const state = this.paperKnowledge.state(projectId, source.documentId);
      if (read.state !== 'current' || read.documentId !== source.documentId || read.publishedJob?.id !== source.generationId ||
        state.state !== 'current' || state.generationId !== source.generationId ||
        state.digest !== wikiPaperKnowledgeDigest(read.publishedJob)) throw new Error('wiki_current_sources_required');
      knowledge.push(read);
    }
    signal.throwIfAborted(); this.knowledgeDependencies(projectId, sources);
    return {knowledge};
  }
  private async verifyKnowledgeSources(projectId: string, sources: WikiPaperKnowledgeSource[], signal: AbortSignal,
    currentRequired: boolean): Promise<Map<string, string | null>> {
    const verified = new Map<string, string | null>();
    for (const source of sources) {
      signal.throwIfAborted();
      if (!this.paperKnowledge) {
        if (currentRequired) throw new Error('wiki_current_sources_required');
        verified.set(source.documentId, null); continue;
      }
      try {
        const read = await this.paperKnowledge.read(projectId, source, signal);
        const state = this.paperKnowledge.state(projectId, source.documentId);
        if (read.documentId !== source.documentId || read.publishedJob?.id !== source.generationId) {
          throw new Error('wiki_current_sources_required');
        }
        if (currentRequired && (read.state !== 'current' || state.state !== 'current' ||
          state.generationId !== source.generationId || state.digest !== wikiPaperKnowledgeDigest(read.publishedJob))) {
          throw new Error('wiki_current_sources_required');
        }
        // A selected old generation remains stale against the current active digest.
        if (!verified.has(source.documentId)) verified.set(source.documentId, state.digest);
      } catch (error) {
        signal.throwIfAborted();
        if (currentRequired) throw error;
        // The page keeps its immutable prose and references; failed bytes are surfaced as a missing/stale basis.
        verified.set(source.documentId, null);
      }
    }
    if (currentRequired) this.knowledgeDependencies(projectId, sources);
    return verified;
  }
  private paperDependencies(projectId: string, sources: PaperSource[]): WikiDependency[] {
    return [...new Set(sources.map(source => source.documentId))].map(id => {
      const digest = this.currentDigest(projectId, {kind: 'paper', id, digest: ''});
      if (!digest) throw new Error('wiki_current_sources_required');
      return {kind: 'paper', id, digest};
    });
  }
  private exists(table: 'research_evidence' | 'research_claims', id: string, projectId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND project_id=?`).get(id, projectId) !== undefined;
  }
  private indexDependencies(pageId: string, dependencies: WikiDependency[]): void {
    for (const dep of dependencies) this.db.prepare('INSERT OR IGNORE INTO research_wiki_dependencies VALUES (?,?,?)').run(pageId, dep.kind, dep.id);
  }
  private enqueue(pageId: string): string {
    const generation = randomUUID();
    this.db.prepare(`INSERT INTO research_wiki_jobs VALUES (?,?,'queued',NULL) ON CONFLICT(page_id)
      DO UPDATE SET generation=excluded.generation,status='queued',error=NULL`).run(pageId, generation);
    return generation;
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
      revision: row.revision, updatedAt: row.updated_at, job,
      ...wikiClassification(row.kind, (JSON.parse(row.selection_json) as Selection).template)});
  }
  private sourceIds(row: PageRow): string[] {
    return (this.db.prepare(`SELECT e.id FROM research_evidence e LEFT JOIN research_evidence_source_metadata m ON m.evidence_id=e.id
      WHERE e.project_id=? AND (e.document_id=? OR json_extract(m.metadata_json,'$.documentId')=? OR json_extract(m.metadata_json,'$.fileId')=?)
      ORDER BY e.invalidated_at IS NOT NULL,e.rowid DESC LIMIT 50`)
      .all(row.project_id, row.source_document_id, row.source_document_id, row.source_document_id) as Array<{id: string}>).map(item => item.id);
  }
  private sourceCount(row: PageRow): number {
    return this.db.prepare(`SELECT COUNT(*) FROM research_evidence e LEFT JOIN research_evidence_source_metadata m ON m.evidence_id=e.id
      WHERE e.project_id=? AND (e.document_id=? OR json_extract(m.metadata_json,'$.documentId')=? OR json_extract(m.metadata_json,'$.fileId')=?)`)
      .pluck().get(row.project_id, row.source_document_id, row.source_document_id, row.source_document_id) as number;
  }
}
