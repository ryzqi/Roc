import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {ResearchInspectedEvidence} from '../../../shared/schemas/research-evidence-source';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import {researchExperimentExecutionSchema, type ResearchExperimentExecution} from '../../../shared/schemas/research-experiments';
import {
  researchSourceReplacementRequestSchema, researchSourceReplacementListSchema, researchSourceReplacementGetSchema,
  researchSourceReplacementSchema, type ResearchSourceReplacementRequest, type ResearchSourceReplacement,
  type ResearchSourceReplacementInspection
} from '../../../shared/schemas/research-source-replacements';
import {relationSourceDigest} from './evidence-relation-repository';
import {storedDocumentContentSchema} from './document-repository';

type EvidenceAccess = {
  inspectEvidence(id: string, projectId: string): ResearchInspectedEvidence;
  invalidateEvidence(id: string, projectId: string): void;
};
type Row = {
  id: string; project_id: string; evidence_id: string; target_evidence_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string
};
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** User-selected predecessor links never imply equivalent results or renewed scientific support. */
export class ResearchSourceReplacementRepository {
  constructor(private readonly db: Database, private readonly evidence: EvidenceAccess, private readonly now: () => string) {}

  replace(input: ResearchSourceReplacementRequest, selectedBy: ResearchRelationReviewer): ResearchSourceReplacement {
    const request = researchSourceReplacementRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(selectedBy);
    return this.db.transaction(() => {
      const project = this.db.prepare('SELECT status FROM research_projects WHERE id=?').get(request.projectId) as {status: string} | undefined;
      if (project === undefined) throw new Error('research_project_not_found');
      if (project.status === 'archived') throw new Error('research_project_archived');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_source_replacements WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const record = this.read(replay, request.projectId);
        if (record.requestHash !== requestHash || record.actor.id !== actor.id) throw new Error('research_source_replacement_request_conflict');
        return record;
      }
      const source = this.evidence.inspectEvidence(request.evidenceId, request.projectId);
      const target = this.evidence.inspectEvidence(request.targetEvidenceId, request.projectId);
      if (source.evidence.id === target.evidence.id) throw new Error('research_source_replacement_same_source');
      if (relationSourceDigest(source) !== request.expectedSourceDigest) throw new Error('research_source_replacement_source_changed');
      if (relationSourceDigest(target) !== request.expectedTargetDigest) throw new Error('research_source_replacement_target_changed');
      if (target.referenceStatus !== 'recorded') throw new Error('research_source_replacement_target_stale');
      if (this.db.prepare('SELECT id FROM research_source_replacements WHERE project_id=? AND evidence_id=? AND target_evidence_id=?')
        .get(request.projectId, request.evidenceId, request.targetEvidenceId) !== undefined) throw new Error('research_source_replacement_already_linked');
      this.requireCurrentChunk(target);
      let experimentLineage: ResearchSourceReplacement['experimentLineage'] = null;
      if (request.kind === 'document_replacement') {
        if (source.sourceLocator === null || target.sourceLocator === null ||
            source.sourceLocator.documentId === target.sourceLocator.documentId) throw new Error('research_source_replacement_documents_required');
        this.requireCurrentDocument(target);
      } else {
        if (source.evidence.sourceType !== 'experiment' || target.evidence.sourceType !== 'experiment' ||
            source.evidence.sourceId === target.evidence.sourceId) throw new Error('research_source_replacement_executions_required');
        const previous = this.execution(source.evidence.sourceId, request.projectId);
        const current = this.execution(target.evidence.sourceId, request.projectId);
        experimentLineage = {previous, previousHash: hash(JSON.stringify(previous)), current, currentHash: hash(JSON.stringify(current))};
      }
      this.evidence.invalidateEvidence(source.evidence.id, request.projectId);
      const supersededSource = this.evidence.inspectEvidence(source.evidence.id, request.projectId);
      const record = researchSourceReplacementSchema.parse({
        id: `source_replacement_${randomUUID()}`, projectId: request.projectId, request, requestHash, actor,
        source, sourceDigest: relationSourceDigest(source), supersededSource, supersededSourceDigest: relationSourceDigest(supersededSource),
        target, targetDigest: relationSourceDigest(target), experimentLineage, scientificReviewAtSelection: 'needs_review', createdAt: this.now()
      });
      this.db.prepare(`INSERT INTO research_source_replacements
        (id,project_id,evidence_id,target_evidence_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(record.id, record.projectId, request.evidenceId, request.targetEvidenceId, request.requestId,
          JSON.stringify(record), hash(JSON.stringify(record)), record.createdAt);
      return record;
    })();
  }

  list(input: {projectId: string; evidenceId: string}): ResearchSourceReplacementInspection[] {
    const request = researchSourceReplacementListSchema.parse(input);
    this.evidence.inspectEvidence(request.evidenceId, request.projectId);
    const rows = this.db.prepare(`SELECT * FROM research_source_replacements
      WHERE project_id=? AND (evidence_id=? OR target_evidence_id=?) ORDER BY rowid`)
      .all(request.projectId, request.evidenceId, request.evidenceId) as Row[];
    return rows.map(row => this.inspect(row, request.projectId));
  }

  get(input: {projectId: string; replacementId: string}): ResearchSourceReplacementInspection {
    const request = researchSourceReplacementGetSchema.parse(input);
    const row = this.db.prepare('SELECT * FROM research_source_replacements WHERE id=?').get(request.replacementId) as Row | undefined;
    if (row === undefined) throw new Error('research_source_replacement_not_found');
    return this.inspect(row, request.projectId);
  }

  private inspect(row: Row, projectId: string): ResearchSourceReplacementInspection {
    const replacement = this.read(row, projectId);
    const target = this.evidence.inspectEvidence(replacement.target.evidence.id, projectId);
    if (target.referenceStatus === 'recorded') {
      if (relationSourceDigest(target) !== replacement.targetDigest) throw new Error('research_source_replacement_target_changed');
      this.requireCurrentChunk(target);
      if (replacement.request.kind === 'document_replacement') this.requireCurrentDocument(target);
    }
    return {replacement, replacementHash: row.snapshot_hash, targetReferenceStatus: target.referenceStatus};
  }

  private read(row: Row, projectId: string): ResearchSourceReplacement {
    if (row.project_id !== projectId) throw new Error('research_source_replacement_project_mismatch');
    let value: unknown;
    try {value = JSON.parse(row.snapshot_json);}
    catch {throw new Error('research_source_replacement_snapshot_invalid');}
    const parsed = researchSourceReplacementSchema.safeParse(value);
    if (!parsed.success) throw new Error('research_source_replacement_snapshot_invalid');
    const record = parsed.data;
    if (record.id !== row.id || record.projectId !== row.project_id || record.request.requestId !== row.request_id ||
        record.source.evidence.id !== row.evidence_id || record.target.evidence.id !== row.target_evidence_id ||
        hash(JSON.stringify(record)) !== row.snapshot_hash || hash(JSON.stringify(record.request)) !== record.requestHash ||
        relationSourceDigest(record.source) !== record.sourceDigest || relationSourceDigest(record.supersededSource) !== record.supersededSourceDigest ||
        relationSourceDigest(record.target) !== record.targetDigest || (record.experimentLineage !== null &&
          (hash(JSON.stringify(record.experimentLineage.previous)) !== record.experimentLineage.previousHash ||
           hash(JSON.stringify(record.experimentLineage.current)) !== record.experimentLineage.currentHash))) {
      throw new Error('research_source_replacement_snapshot_invalid');
    }
    return record;
  }

  private requireCurrentChunk(source: ResearchInspectedEvidence): void {
    const chunk = this.db.prepare(`SELECT c.content,c.locator,c.content_hash,d.source_type,d.source_id FROM research_knowledge_chunks c
      JOIN research_knowledge_documents d ON d.id=c.document_id WHERE c.id=? AND c.document_id=?`)
      .get(source.evidence.chunkId, source.evidence.documentId) as {
        content: string; locator: string; content_hash: string; source_type: string; source_id: string
      } | undefined;
    if (chunk === undefined || chunk.content !== source.evidence.excerpt || chunk.locator !== source.evidence.locator ||
        chunk.content_hash !== source.evidence.contentHash || chunk.source_type !== source.evidence.sourceType ||
        chunk.source_id !== source.evidence.sourceId) throw new Error('research_source_replacement_target_changed');
  }

  private requireCurrentDocument(source: ResearchInspectedEvidence): void {
    const locator = source.sourceLocator;
    if (locator === null) throw new Error('research_source_replacement_documents_required');
    const row = this.db.prepare(`SELECT d.current_parse_id,d.source_hash,p.status,p.data_json FROM research_documents d
      JOIN research_document_parses p ON p.document_id=d.id WHERE d.id=? AND p.id=?`).get(locator.documentId, locator.parseId) as {
        current_parse_id: string | null; source_hash: string; status: string; data_json: string | null
      } | undefined;
    if (row === undefined || row.current_parse_id !== locator.parseId || row.status !== 'ready' || row.data_json === null) {
      throw new Error('research_source_replacement_target_stale');
    }
    const {content} = storedDocumentContentSchema.parse(JSON.parse(row.data_json));
    if (row.source_hash !== locator.sourceHash || content.sourceHash !== locator.sourceHash ||
        hash(JSON.stringify(content)) !== locator.parseHash) throw new Error('research_source_replacement_target_changed');
  }

  private execution(id: string, projectId: string): ResearchExperimentExecution {
    const row = this.db.prepare('SELECT project_id,status,snapshot_json FROM research_experiment_executions WHERE run_id=?')
      .get(id) as {project_id: string; status: string; snapshot_json: string} | undefined;
    if (row === undefined) throw new Error('research_source_replacement_executions_required');
    if (row.project_id !== projectId) throw new Error('research_source_replacement_project_mismatch');
    const run = researchExperimentExecutionSchema.parse(JSON.parse(row.snapshot_json));
    if (run.id !== id || run.projectId !== projectId || run.status !== row.status || run.status !== 'completed' ||
        run.environment === null || run.inputHash === null || run.exitCode !== 0 || run.error !== null) {
      throw new Error('research_source_replacement_execution_not_completed');
    }
    return run;
  }
}
