import {scientificBatchHash, scientificBatchReceiptSchema, scientificBatchReceiptsSchema, type ScientificBatchReceipt} from './scientific-extraction-receipts';
import {buildScientificExtractionBatches} from './scientific-extraction-batches';
import {scientificDeepBatches, validateScientificDeepKnowledge} from './scientific-extraction-deep';
import type {Database} from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {scientificExtractionSnapshotSchema, scientificExtractionJobSchema, scientificKnowledgeCandidatesSchema,
  scientificKnowledgeBundleSchema, scientificKnowledgeReadSchema, type ScientificExtractionSnapshot,
  type ScientificExtractionJob, type ScientificKnowledgeCandidates, type ScientificKnowledgeBundle,
  type ScientificKnowledgeRead} from '../../../shared/schemas/research-scientific-extraction';
import {scientificEntityAliasSchema, type ScientificEntityAlias, type ScientificEntity} from '../../../shared/schemas/research-scientific-entities';
import type {PaperIRArtifact, PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {researchContentHash} from './research-files';
import {assertPaperIRArtifact} from './paper-ir-repository';
import {ScientificIndexRepository} from './scientific-index-repository';
import {resolveScientificEntity} from './scientific-entity-resolution';
import {validateScientificFact, validateScientificRelation} from './scientific-fact-validator';
import {queryScientificKnowledge, type ScientificKnowledgePointer} from './scientific-knowledge-search-query';
import type {ScientificKnowledgeSearchRequest} from '../../../shared/schemas/research-scientific-knowledge-search';

const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
export const scientificResolutionHash = (resolution: ScientificExtractionSnapshot['resolution']): string => digest({
  aliases: [...resolution.aliases].sort((a, b) => a.id.localeCompare(b.id)),
  targets: resolution.targets.map(({id, projectId, entityType, canonicalName}) =>
    ({id, projectId, entityType, canonicalName})).sort((a, b) => a.id.localeCompare(b.id))
});
const inputHash = (snapshot: ScientificExtractionSnapshot): string => digest({
  projectId: snapshot.projectId, paperIR: snapshot.source.paperIR,
  config: snapshot.config, aliasesHash: snapshot.aliasesHash,
  ...(snapshot.deepRequest ? {deepRequest: snapshot.deepRequest} : {})
});
export const scientificExtractionInputHash = inputHash;
type JobRow = {
  id: string; project_id: string; document_id: string; source_generation_id: string;
  parse_id: string; source_hash: string; parse_hash: string; parser_fingerprint: string; paper_ir_hash: string;
  extractor_version: string; prompt_version: string; model_revision: string; generation: number;
  input_hash: string; snapshot_json: string; snapshot_hash: string;
  status: ScientificExtractionJob['status']; publication: ScientificExtractionJob['publication'];
  attempts: number; error: string | null; created_at: string; started_at: string | null;
  published_at: string | null; candidates_json: string | null; candidates_hash: string | null; result_hash: string | null;
};
type ValueRow = {snapshot_json: string; snapshot_hash: string; ordinal: number; id?: string;
  candidate_id?: string; entity_type?: string; fact_type?: string; relation_type?: string; kind?: string; fact_id?: string};

export function validateScientificKnowledgeCandidates(input: ScientificKnowledgeCandidates, snapshot: ScientificExtractionSnapshot,
  generationId: string, ir: PaperIRV2): ScientificKnowledgeBundle {
  const candidates = scientificKnowledgeCandidatesSchema.parse(input);
  assertPaperIRArtifact(snapshot.source.paperIR, ir);
  const basis = {projectId: snapshot.projectId, generationId, ir};
  const entities = candidates.entities.map(entity => resolveScientificEntity(entity, basis,
    snapshot.resolution.aliases, snapshot.resolution.targets));
  const facts = candidates.facts.map(fact => validateScientificFact(fact, basis, entities));
  const relations = candidates.relations.map(relation => validateScientificRelation(relation, basis, entities, facts));
  if (candidates.deepReading && !snapshot.deepRequest) throw new Error('research_scientific_deep_selection_invalid');
  const deepReading = candidates.deepReading && snapshot.deepRequest ? validateScientificDeepKnowledge(
    candidates.deepReading, ir, snapshot.deepRequest,
    scientificDeepBatches(ir, buildScientificExtractionBatches(ir, snapshot.config), snapshot.deepRequest)) : undefined;
  return scientificKnowledgeBundleSchema.parse({entities, facts, relations, ...(deepReading ? {deepReading} : {})});
}
const factEvidence = (fact: ScientificKnowledgeBundle['facts'][number]) => [
  ...fact.evidence.map(source => ({kind: 'evidence', value: source})),
  ...fact.conditionEvidence.flatMap(item => item.evidence.map(source =>
    ({kind: 'condition', value: {field: item.field, key: item.key, source}}))),
  ...(fact.value?.unitEvidence ?? []).map(source => ({kind: 'unit', value: source}))
];

/** One owner publishes complete generations; failed work cannot overwrite the active publication. */
export class ScientificExtractionRepository {
  private readonly index: ScientificIndexRepository;
  private readonly changeListeners = new Set<(projectId: string, documentId: string | null) => void>();
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {
    this.index = new ScientificIndexRepository(db, now);
  }

  subscribeChanges(listener: (projectId: string, documentId: string | null) => void): () => void {
    this.changeListeners.add(listener);
    return () => {this.changeListeners.delete(listener);};
  }
  private changed(projectId: string, documentId: string | null): void {
    for (const listener of this.changeListeners) listener(projectId, documentId);
  }

  enqueue(input: ScientificExtractionSnapshot, ir: PaperIRV2, force = false): ScientificExtractionJob {
    const snapshot = scientificExtractionSnapshotSchema.parse(input);
    assertPaperIRArtifact(snapshot.source.paperIR, ir);
    this.assertSource(snapshot);
    const documentId = snapshot.source.paperIR.identity.documentId, hash = inputHash(snapshot);
    return this.db.transaction(() => {
      const latest = this.latest(snapshot.projectId, documentId);
      if (!force && latest?.inputHash === hash) return latest;
      this.db.prepare(`UPDATE research_paper_extraction_jobs SET status='cancelled',error='research_scientific_extraction_superseded'
        WHERE project_id=? AND document_id=? AND status IN ('queued','running')`).run(snapshot.projectId, documentId);
      const id = `scientific-extraction:${randomUUID()}`, generation = (latest?.generation ?? 0) + 1;
      const identity = snapshot.source.paperIR.identity, json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_paper_extraction_jobs
        (id,project_id,document_id,source_generation_id,parse_id,source_hash,parse_hash,parser_fingerprint,paper_ir_hash,
         extractor_version,prompt_version,model_revision,generation,input_hash,snapshot_json,snapshot_hash,
         status,publication,attempts,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued','unpublished',0,?)`).run(id, snapshot.projectId, documentId,
          snapshot.source.generationId, identity.parseId, identity.sourceHash, identity.parseHash, identity.parserFingerprint,
          snapshot.source.paperIR.sha256, snapshot.config.extractorVersion, snapshot.config.promptVersion,
          digest(snapshot.config.model), generation, hash, json, researchContentHash(json), this.now());
      if (force && latest?.inputHash === hash && latest.status !== 'published') {
        const receipts = this.receipts(latest.id, snapshot.projectId).map(receipt => ({...receipt,
          jobId: id, reusedFromJobId: receipt.reusedFromJobId ?? latest.id}));
        if (receipts.length) this.storeReceipts(id, receipts);
      }
      this.changed(snapshot.projectId, documentId);
      return this.get(id, snapshot.projectId);
    }).immediate();
  }

  get(id: string, projectId: string): ScientificExtractionJob {
    const row = this.row(id);
    if (row.project_id !== projectId) throw new Error('research_scientific_extraction_scope_invalid');
    const snapshot = scientificExtractionSnapshotSchema.parse(JSON.parse(row.snapshot_json)), identity = snapshot.source.paperIR.identity;
    if (researchContentHash(row.snapshot_json) !== row.snapshot_hash || inputHash(snapshot) !== row.input_hash ||
      snapshot.projectId !== projectId || identity.documentId !== row.document_id ||
      snapshot.source.generationId !== row.source_generation_id || identity.parseId !== row.parse_id ||
      identity.sourceHash !== row.source_hash || identity.parseHash !== row.parse_hash ||
      identity.parserFingerprint !== row.parser_fingerprint || snapshot.source.paperIR.sha256 !== row.paper_ir_hash ||
      snapshot.config.extractorVersion !== row.extractor_version || snapshot.config.promptVersion !== row.prompt_version ||
      digest(snapshot.config.model) !== row.model_revision ||
      scientificResolutionHash(snapshot.resolution) !== snapshot.aliasesHash) {
      throw new Error('research_scientific_extraction_snapshot_invalid');
    }
    return scientificExtractionJobSchema.parse({id: row.id, generation: row.generation, snapshot,
      inputHash: row.input_hash, status: row.status, publication: row.publication, attempts: row.attempts,
      error: row.error, createdAt: row.created_at, startedAt: row.started_at, publishedAt: row.published_at,
      resultHash: row.result_hash});
  }

  latest(projectId: string, documentId: string): ScientificExtractionJob | null {
    const row = this.db.prepare(`SELECT id FROM research_paper_extraction_jobs
      WHERE project_id=? AND document_id=? ORDER BY generation DESC LIMIT 1`).get(projectId, documentId) as {id: string} | undefined;
    return row ? this.get(row.id, projectId) : null;
  }
  active(projectId: string, documentId: string): ScientificExtractionJob | null {
    const row = this.db.prepare(`SELECT id FROM research_paper_extraction_jobs
      WHERE project_id=? AND document_id=? AND publication='active'`).get(projectId, documentId) as {id: string} | undefined;
    return row ? this.get(row.id, projectId) : null;
  }
  searchSources(projectId: string, documentIds: readonly string[]): ScientificExtractionJob[] {
    this.requireProject(projectId);
    return (this.db.prepare(`SELECT id FROM research_paper_extraction_jobs WHERE project_id=? AND
      publication='active' AND document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id,id`)
      .all(projectId, JSON.stringify(documentIds)) as Array<{id: string}>).map(row => this.get(row.id, projectId));
  }
  searchCandidates(request: ScientificKnowledgeSearchRequest, documentIds: readonly string[]): ScientificKnowledgePointer[] {
    this.requireProject(request.projectId);
    return queryScientificKnowledge(this.db, request, documentIds, this.aliases(request.projectId));
  }
  /** History remains readable only while its document still belongs to the current project. */
  authorizeDocument(projectId: string, documentId: string): void {
    this.requireProject(projectId);
    if (this.db.prepare('SELECT 1 FROM research_documents WHERE id=?').get(documentId)) {
      if (!this.db.prepare(`SELECT 1 FROM research_documents d JOIN research_library l ON l.id=d.library_item_id
        JOIN research_library_projects p ON p.item_id=l.id
        WHERE d.id=? AND p.project_id=? AND l.archived=0`).get(documentId, projectId)) {
        throw new Error('research_scientific_extraction_scope_invalid');
      }
      return;
    }
    const row = this.db.prepare(`SELECT id FROM research_scientific_index_generations
      WHERE project_id=? AND document_id=? ORDER BY rowid DESC LIMIT 1`).get(projectId, documentId) as {id: string} | undefined;
    const source = row ? this.index.get(row.id).snapshot.source : null;
    if (!source || source.kind !== 'project' || !this.db.prepare(`SELECT 1 FROM research_index_files
      WHERE id=? AND project_id=? AND status!='missing'`).get(source.fileId, projectId)) {
      throw new Error('research_scientific_extraction_scope_invalid');
    }
  }
  list(projectId: string, documentId: string, offset = 0): ScientificExtractionJob[] {
    this.authorizeDocument(projectId, documentId);
    return (this.db.prepare(`SELECT id FROM research_paper_extraction_jobs WHERE project_id=? AND document_id=?
      ORDER BY generation DESC LIMIT 50 OFFSET ?`).all(projectId, documentId, offset) as Array<{id: string}>)
      .map(row => this.get(row.id, projectId));
  }
  queued(): ScientificExtractionJob[] {
    return (this.db.prepare(`SELECT id,project_id FROM research_paper_extraction_jobs WHERE status='queued'
      ORDER BY created_at,rowid`).all() as Array<{id: string; project_id: string}>).map(row => this.get(row.id, row.project_id));
  }
  claim(id: string, projectId: string): ScientificExtractionJob {
    const job = this.get(id, projectId);
    this.assertSource(job.snapshot);
    if (this.db.prepare(`UPDATE research_paper_extraction_jobs SET status='running',attempts=attempts+1,
      error=NULL,started_at=? WHERE id=? AND project_id=? AND status='queued'`).run(this.now(), id, projectId).changes !== 1) {
      throw new Error('research_scientific_extraction_not_queued');
    }
    return this.get(id, projectId);
  }
  fail(id: string, projectId: string, error: string, cancelled = false): void {
    this.get(id, projectId);
    this.db.prepare(`UPDATE research_paper_extraction_jobs SET status=?,error=?
      WHERE id=? AND project_id=? AND status IN ('queued','running')`).run(cancelled ? 'cancelled' : 'failed',
        error, id, projectId);
  }
  recover(): number {
    return this.db.prepare(`UPDATE research_paper_extraction_jobs SET status='queued',
      error='research_scientific_extraction_interrupted' WHERE status='running'`).run().changes;
  }

  /** Explicit deep work can reuse a complete base publication under the identical source/configuration. */
  baseCandidates(snapshot: ScientificExtractionSnapshot, ir: PaperIRV2): ScientificKnowledgeCandidates | undefined {
    const active = this.active(snapshot.projectId, ir.identity.documentId);
    if (!active) return undefined;
    const {deepRequest: _previousRequest, ...previousBase} = active.snapshot;
    const {deepRequest: _currentRequest, ...currentBase} = snapshot;
    if (inputHash(previousBase) !== inputHash(currentBase)) return undefined;
    this.assertSource(snapshot);
    this.bundle(active.id, snapshot.projectId, ir);
    const candidates = scientificKnowledgeCandidatesSchema.parse(JSON.parse(this.row(active.id).candidates_json!));
    const base = {entities: candidates.entities, facts: candidates.facts, relations: candidates.relations};
    validateScientificKnowledgeCandidates(base, snapshot, active.id, ir);
    return base;
  }

  /** Unpublished envelopes are never returned through bundle/read. Invalid receipts are cache misses. */
  receipts(id: string, projectId: string): ScientificBatchReceipt[] {
    const job = this.get(id, projectId), row = this.row(id);
    if (job.status === 'published' || row.candidates_json === null ||
      researchContentHash(row.candidates_json) !== row.candidates_hash) return [];
    try {
      const parsed = JSON.parse(row.candidates_json) as {version?: unknown; receipts?: unknown};
      if (parsed?.version !== 'roc-scientific-batch-receipts/1' || !Array.isArray(parsed.receipts) || parsed.receipts.length > 2048) return [];
      return parsed.receipts.flatMap(value => {
        const result = scientificBatchReceiptSchema.safeParse(value);
        if (!result.success) return [];
        const receipt = result.data;
        return receipt.jobId === id && receipt.inputHash === job.inputHash &&
          receipt.modelRevision === digest(job.snapshot.config.model) && receipt.outputHash === scientificBatchHash(receipt.output) ? [receipt] : [];
      });
    } catch {return [];}
  }

  checkpoint(id: string, projectId: string, input: ScientificBatchReceipt): void {
    const job = this.get(id, projectId), receipt = scientificBatchReceiptSchema.parse(input);
    this.assertSource(job.snapshot);
    if (job.status !== 'running' || receipt.jobId !== id || receipt.inputHash !== job.inputHash ||
      receipt.modelRevision !== digest(job.snapshot.config.model) || receipt.outputHash !== scientificBatchHash(receipt.output)) {
      throw new Error('research_scientific_extraction_checkpoint_invalid');
    }
    const receipts = this.receipts(id, projectId).filter(item => item.stage !== receipt.stage || item.batchId !== receipt.batchId);
    receipts.push(receipt);
    this.storeReceipts(id, receipts);
  }

  private storeReceipts(id: string, receipts: ScientificBatchReceipt[]): void {
    const json = JSON.stringify(scientificBatchReceiptsSchema.parse({version: 'roc-scientific-batch-receipts/1', receipts}));
    this.db.prepare(`UPDATE research_paper_extraction_jobs SET candidates_json=?,candidates_hash=?
      WHERE id=? AND status IN ('queued','running')`).run(json, researchContentHash(json), id);
  }

  publish(id: string, projectId: string, input: ScientificKnowledgeCandidates, ir: PaperIRV2,
    current: () => ScientificExtractionSnapshot, consumer?: (bundle: ScientificKnowledgeBundle) => unknown): ScientificExtractionJob {
    this.db.transaction(() => {
      const job = this.get(id, projectId);
      if (job.status !== 'running') throw new Error('research_scientific_extraction_not_running');
      const state = scientificExtractionSnapshotSchema.parse(current());
      this.assertSource(state);
      if (inputHash(state) !== job.inputHash) throw new Error('research_scientific_extraction_input_changed');
      const candidates = scientificKnowledgeCandidatesSchema.parse(input);
      const bundle = validateScientificKnowledgeCandidates(candidates, job.snapshot, id, ir);
      if (job.snapshot.deepRequest && !bundle.deepReading) throw new Error('research_scientific_deep_result_missing');
      for (const [key, table] of [['entities', 'research_paper_entities'], ['facts', 'research_paper_facts'],
        ['relations', 'research_paper_relations']] as const) {
        const column = key === 'entities' ? 'entity_type' : key === 'facts' ? 'fact_type' : 'relation_type';
        bundle[key].forEach((item, ordinal) => {
          const json = JSON.stringify(item);
          if (key === 'entities') {
            const entity = bundle.entities[ordinal]!;
            this.db.prepare(`INSERT INTO ${table}
              (generation_id,candidate_id,id,${column},snapshot_json,snapshot_hash,ordinal) VALUES (?,?,?,?,?,?,?)`)
              .run(id, entity.candidateId, entity.id, entity.entityType, json, researchContentHash(json), ordinal);
          } else {
            const type = key === 'facts' ? bundle.facts[ordinal]!.factType : bundle.relations[ordinal]!.type;
            this.db.prepare(`INSERT INTO ${table}
              (generation_id,id,${column},snapshot_json,snapshot_hash,ordinal) VALUES (?,?,?,?,?,?)`)
              .run(id, item.id, type, json, researchContentHash(json), ordinal);
          }
        });
      }
      const insertEvidence = this.db.prepare('INSERT INTO research_paper_fact_evidence VALUES (?,?,?,?,?,?)');
      bundle.facts.forEach(fact => factEvidence(fact).forEach((item, ordinal) => {
        const json = JSON.stringify(item.value);
        insertEvidence.run(id, fact.id, item.kind, ordinal, json, researchContentHash(json));
      }));
      this.db.prepare(`UPDATE research_paper_extraction_jobs SET publication='retired'
        WHERE project_id=? AND document_id=? AND publication='active'`).run(projectId, ir.identity.documentId);
      const json = JSON.stringify(candidates);
      this.db.prepare(`UPDATE research_paper_extraction_jobs SET status='published',publication='active',
        published_at=?,candidates_json=?,candidates_hash=?,result_hash=? WHERE id=? AND status='running'`)
        .run(this.now(), json, researchContentHash(json), digest(bundle), id);
      const result = consumer?.(bundle);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        throw new Error('research_scientific_extraction_publication_must_be_synchronous');
      }
      this.changed(projectId, ir.identity.documentId);
    }).immediate();
    return this.get(id, projectId);
  }

  bundle(id: string, projectId: string, ir?: PaperIRV2): ScientificKnowledgeBundle {
    const job = this.get(id, projectId), row = this.row(id);
    if (job.status !== 'published' || row.candidates_json === null ||
      researchContentHash(row.candidates_json) !== row.candidates_hash) {
      throw new Error('research_scientific_extraction_result_invalid');
    }
    const candidates = scientificKnowledgeCandidatesSchema.parse(JSON.parse(row.candidates_json));
    const bundle = scientificKnowledgeBundleSchema.parse({
      ...(candidates.deepReading ? {deepReading: candidates.deepReading} : {}),
      entities: this.values('research_paper_entities', id),
      facts: this.values('research_paper_facts', id),
      relations: this.values('research_paper_relations', id)
    });
    for (const item of [...bundle.entities, ...bundle.facts, ...bundle.relations]) {
      if (item.projectId !== projectId || item.generationId !== id ||
        item.documentId !== job.snapshot.source.paperIR.identity.documentId ||
        item.paperId !== job.snapshot.source.paperIR.identity.paperId || item.status !== 'source_validated') {
        throw new Error('research_scientific_extraction_result_invalid');
      }
    }
    const evidence = this.db.prepare(`SELECT * FROM research_paper_fact_evidence
      WHERE generation_id=? ORDER BY fact_id,ordinal`).all(id) as ValueRow[];
    const expected = bundle.facts.flatMap(fact => factEvidence(fact).map((item, ordinal) =>
      ({fact_id: fact.id, ordinal, kind: item.kind, value: item.value}))).sort((a, b) => a.fact_id.localeCompare(b.fact_id) || a.ordinal - b.ordinal);
    const actual = evidence.map(item => ({fact_id: item.fact_id, ordinal: item.ordinal, kind: item.kind,
      value: this.value(item)})).sort((a, b) => a.fact_id!.localeCompare(b.fact_id!) || a.ordinal - b.ordinal);
    if (digest(bundle) !== job.resultHash || !isDeepStrictEqual(expected, actual) ||
      ir && !isDeepStrictEqual(bundle, validateScientificKnowledgeCandidates(JSON.parse(row.candidates_json),
        job.snapshot, id, ir))) throw new Error('research_scientific_extraction_result_invalid');
    return bundle;
  }

  read(projectId: string, documentId: string, currentPaperIR: PaperIRArtifact | null,
    generationId: string | null = null, ir?: PaperIRV2, currentInputHash?: string | null): ScientificKnowledgeRead {
    this.authorizeDocument(projectId, documentId);
    const latestJob = this.latest(projectId, documentId), publishedJob = generationId === null ?
      this.active(projectId, documentId) : this.get(generationId, projectId);
    if (publishedJob && (publishedJob.snapshot.source.paperIR.identity.documentId !== documentId ||
      publishedJob.status !== 'published')) throw new Error('research_scientific_extraction_scope_invalid');
    const stale = publishedJob !== null && (!isDeepStrictEqual(currentPaperIR, publishedJob.snapshot.source.paperIR) ||
      currentInputHash !== undefined && currentInputHash !== publishedJob.inputHash);
    const original = publishedJob ? this.bundle(publishedJob.id, projectId, stale ? undefined : ir) : null;
    const knowledge = stale && original ? {...original,
      entities: original.entities.map(entity => ({...entity, status: 'stale' as const})),
      facts: original.facts.map(fact => ({...fact, status: 'stale' as const})),
      relations: original.relations.map(relation => ({...relation, status: 'stale' as const})),
      ...(original.deepReading ? {deepReading: {...original.deepReading, status: 'stale' as const}} : {})} : original;
    return scientificKnowledgeReadSchema.parse({currentPaperIR, latestJob, publishedJob,
      state: publishedJob === null ? 'missing' : stale ? 'stale' : 'current', knowledge});
  }

  aliases(projectId: string): ScientificEntityAlias[] {
    this.requireProject(projectId);
    return (this.db.prepare(`SELECT a.* FROM research_paper_entity_aliases a WHERE project_id=? AND
      revision=(SELECT max(b.revision) FROM research_paper_entity_aliases b WHERE b.id=a.id) ORDER BY id`)
      .all(projectId) as Array<ValueRow & {id: string; project_id: string}>).map(row => {
        const entry = scientificEntityAliasSchema.parse(this.value(row));
        if (entry.id !== row.id || entry.projectId !== projectId) throw new Error('research_scientific_alias_invalid');
        return entry;
      });
  }
  resolution(projectId: string): ScientificExtractionSnapshot['resolution'] {
    const aliases = this.aliases(projectId), ids = [...new Set(aliases.map(alias => alias.targetEntityId))];
    const targets = ids.map(id => {
      const row = this.db.prepare(`SELECT e.generation_id FROM research_paper_entities e
        JOIN research_paper_extraction_jobs j ON j.id=e.generation_id
        WHERE j.project_id=? AND j.publication='active' AND e.id=? ORDER BY j.published_at DESC,j.rowid DESC LIMIT 1`)
        .get(projectId, id) as {generation_id: string} | undefined;
      const target = row ? this.bundle(row.generation_id, projectId).entities.find(entity => entity.id === id) : undefined;
      if (!target) throw new Error('research_scientific_entity_alias_target_invalid');
      this.assertTarget(target, projectId);
      return target;
    });
    return {aliases, targets};
  }
  /** Called only by an explicit human dictionary operation, never by the model extraction loop. */
  putAlias(input: ScientificEntityAlias, target: ScientificEntity): void {
    const entry = scientificEntityAliasSchema.parse(input);
    this.requireProject(entry.projectId);
    if (target.projectId !== entry.projectId || target.id !== entry.targetEntityId ||
      target.entityType !== entry.entityType || target.canonicalName !== entry.canonicalName ||
      target.status !== 'source_validated') throw new Error('research_scientific_entity_alias_target_invalid');
    this.assertTarget(target, entry.projectId);
    const existing = this.db.prepare('SELECT max(revision) AS revision,project_id FROM research_paper_entity_aliases WHERE id=?')
      .get(entry.id) as {revision: number | null; project_id: string | null};
    if (entry.revision !== (existing.revision ?? 0) + 1 || existing.project_id !== null && existing.project_id !== entry.projectId) {
      throw new Error('research_scientific_alias_revision_invalid');
    }
    this.db.transaction(() => {
      const json = JSON.stringify(entry);
      this.db.prepare(`INSERT INTO research_paper_entity_aliases
        (id,project_id,entity_type,alias,target_entity_id,canonical_name,revision,created_by,snapshot_json,snapshot_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(entry.id, entry.projectId, entry.entityType, entry.alias, entry.targetEntityId,
          entry.canonicalName, entry.revision, entry.createdBy, json, researchContentHash(json));
      this.changed(entry.projectId, null);
    }).immediate();
  }

  private assertSource(snapshot: ScientificExtractionSnapshot, checkResolution = true): void {
    this.requireProject(snapshot.projectId);
    if (scientificResolutionHash(snapshot.resolution) !== snapshot.aliasesHash) throw new Error('research_scientific_alias_invalid');
    if (checkResolution) {
      if (!isDeepStrictEqual(snapshot.resolution.aliases, this.aliases(snapshot.projectId))) {
        throw new Error('research_scientific_extraction_aliases_changed');
      }
      for (const target of snapshot.resolution.targets) this.assertTarget(target, snapshot.projectId, false);
      if (new Set(snapshot.resolution.targets.map(target => target.id)).size !== snapshot.resolution.targets.length ||
        snapshot.resolution.aliases.some(alias => !snapshot.resolution.targets.some(target => target.id === alias.targetEntityId))) {
        throw new Error('research_scientific_entity_alias_target_invalid');
      }
    }
    const source = snapshot.source, generation = this.index.get(source.generationId);
    if (!isDeepStrictEqual(generation.snapshot.paperIR, source.paperIR) ||
      generation.snapshot.projectId !== source.storageProjectId ||
      generation.chunksHash !== source.chunksHash || generation.relationsHash !== source.relationsHash) {
      throw new Error('research_scientific_extraction_source_invalid');
    }
    const active = this.index.active(source.storageProjectId, source.paperIR.identity.documentId);
    if (!active || !isDeepStrictEqual(active.snapshot.paperIR, source.paperIR)) {
      throw new Error('research_scientific_extraction_source_changed');
    }
    if (source.storageProjectId !== null ? source.storageProjectId !== snapshot.projectId :
      !this.db.prepare(`SELECT 1 FROM research_documents d JOIN research_library l ON l.id=d.library_item_id
        JOIN research_library_projects p ON p.item_id=l.id WHERE d.id=? AND p.project_id=? AND l.archived=0
        AND d.current_parse_id=? AND d.source_hash=?`).get(source.paperIR.identity.documentId, snapshot.projectId,
          source.paperIR.identity.parseId, source.paperIR.identity.sourceHash)) {
      throw new Error('research_scientific_extraction_scope_invalid');
    }
    this.index.verify(active.id);
  }
  private assertTarget(target: ScientificEntity, projectId: string, exactActive = true): void {
    const job = this.get(target.generationId, projectId);
    if (job.status !== 'published' || target.status !== 'source_validated' ||
      !this.bundle(job.id, projectId).entities.some(entity => isDeepStrictEqual(entity, target))) {
      throw new Error('research_scientific_entity_alias_target_invalid');
    }
    // Keep the immutable dictionary snapshot authentic while allowing its target to be republished.
    const current = exactActive ? job : this.active(projectId, job.snapshot.source.paperIR.identity.documentId);
    if (!current || current.publication !== 'active' || !this.bundle(current.id, projectId).entities.some(entity =>
      entity.id === target.id && entity.projectId === target.projectId &&
      entity.entityType === target.entityType && entity.canonicalName === target.canonicalName)) {
      throw new Error('research_scientific_entity_alias_target_invalid');
    }
    this.assertSource(current.snapshot, false);
  }
  private requireProject(projectId: string): void {
    if (!this.db.prepare("SELECT 1 FROM research_projects WHERE id=? AND status!='archived'").get(projectId)) {
      throw new Error('research_scientific_extraction_scope_invalid');
    }
  }
  private row(id: string): JobRow {
    const row = this.db.prepare('SELECT * FROM research_paper_extraction_jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!row) throw new Error('research_scientific_extraction_not_found');
    return row;
  }
  private value(row: ValueRow): unknown {
    if (researchContentHash(row.snapshot_json) !== row.snapshot_hash) throw new Error('research_scientific_extraction_result_invalid');
    return JSON.parse(row.snapshot_json);
  }
  private values(table: string, generationId: string): unknown[] {
    return (this.db.prepare(`SELECT * FROM ${table} WHERE generation_id=? ORDER BY ordinal`).all(generationId) as ValueRow[])
      .map((row, ordinal) => {
        const value = this.value(row) as {id: string; candidateId: string; entityType?: string; factType?: string; type?: string};
        if (row.ordinal !== ordinal || row.id !== value.id ||
          row.candidate_id !== undefined && row.candidate_id !== value.candidateId ||
          row.entity_type !== undefined && row.entity_type !== value.entityType ||
          row.fact_type !== undefined && row.fact_type !== value.factType ||
          row.relation_type !== undefined && row.relation_type !== value.type) {
          throw new Error('research_scientific_extraction_result_invalid');
        }
        return value;
      });
  }
}
