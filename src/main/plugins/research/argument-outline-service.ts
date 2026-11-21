import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchArgumentOutlineSaveSchema, researchArgumentOutlineReceiptSchema, researchArgumentOutlineInspectSchema,
  researchArgumentOutlineInspectionSchema, researchArgumentOutlineHistorySchema, researchArgumentOutlineMaterializeSchema,
  researchArgumentOutlineMaterializedSchema, type ResearchArgumentOutlineSave, type ResearchArgumentOutlineReceipt,
  type ResearchArgumentOutlineInspect, type ResearchArgumentOutlineInspection, type ResearchArgumentOutlineHistory,
  type ResearchArgumentOutlineHistoryResult, type ResearchArgumentOutlineMaterialize, type ResearchArgumentOutlineMaterialized
} from '../../../shared/schemas/research-argument-outline';
import type {ResearchRepository} from './repository';
import {researchContentHash} from './research-files';
import {relationClaimHash, relationSourceDigest} from './evidence-relation-repository';
import {requireResearchHuman} from '../../services/research-human-context';

type Row = {id: string; project_id: string; artifact_id: string; version: number; request_id: string; snapshot_json: string; snapshot_hash: string};
type Applied = {request_hash: string; actor_id: string; response_json: string; response_hash: string};
type MatrixRow = ResearchArgumentOutlineInspection['matrix'][number];
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const byId = <T extends {id: string}>(values: T[]): T[] => values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Outlines store claim identities and section intent; accepted prose lives only in the manuscript. */
export class ResearchArgumentOutlineService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  inspect(input: ResearchArgumentOutlineInspect): ResearchArgumentOutlineInspection {
    const request = researchArgumentOutlineInspectSchema.parse(input);
    return this.db.transaction(() => {
      this.scope(request);
      const matrix = this.matrix(request.projectId), latest = this.latest(request.projectId, request.artifactId);
      return researchArgumentOutlineInspectionSchema.parse({...request, matrix,
        artifactVersion: this.research.inspectArtifact({...request, expectedVersion: null}).snapshot.version,
        matrixHash: digest(matrix), latest,
        latestCurrent: latest !== null && this.current(latest, matrix)});
    })();
  }

  /** Agent proposal validation shares exactly the human draft's version and source checks. */
  validateDraft(input: ResearchArgumentOutlineSave): {materialHash: string; claims: ResearchArgumentOutlineReceipt['snapshot']['claims']} {
    const request = researchArgumentOutlineSaveSchema.parse(input);
    this.writable(request.projectId);
    const inspection = this.inspect({projectId: request.projectId, artifactId: request.artifactId});
    if (inspection.artifactVersion !== request.expectedArtifactVersion || inspection.matrixHash !== request.expectedMatrixHash) {
      throw new Error('research_argument_outline_source_changed');
    }
    const selected = request.sections.flatMap(section => section.claimIds).map(id => {
      const row = inspection.matrix.find(item => item.claim.id === id);
      if (row === undefined || row.claim.status !== 'supported' || row.sources.some(source => row.claim.evidenceIds.includes(source.evidence.id) && source.referenceStatus !== 'recorded')) {
        throw new Error('research_argument_outline_claim_required');
      }
      return row;
    });
    const parent = inspection.latest;
    if (parent === null ? request.parent !== null : parent.snapshot.id !== request.parent?.outlineId || parent.snapshotHash !== request.parent.outlineHash) {
      throw new Error('research_argument_outline_parent_changed');
    }
    return {materialHash: digest(selected), claims: selected.map(row => ({claimId: row.claim.id, expectedClaimHash: row.claimHash}))};
  }

  save(input: ResearchArgumentOutlineSave): ResearchArgumentOutlineReceipt {
    const request = researchArgumentOutlineSaveSchema.parse(input);
    const actor = requireResearchHuman('research.argumentOutlines.save', request.projectId);
    return this.db.transaction(() => {
      this.writable(request.projectId);
      const previous = this.db.prepare('SELECT * FROM research_argument_outlines WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (previous !== undefined) {
        const saved = this.read(previous);
        if (saved.snapshot.requestHash !== digest(request) || saved.snapshot.actor.id !== actor.id) throw new Error('research_argument_outline_request_conflict');
        return saved;
      }
      const material = this.validateDraft(request);
      const parent = this.latest(request.projectId, request.artifactId);
      const snapshot = researchArgumentOutlineReceiptSchema.shape.snapshot.parse({schemaVersion: 1, id: `outline_${randomUUID()}`,
        version: parent === null ? 1 : parent.snapshot.version + 1, request, requestHash: digest(request), ...material,
        actor, recordedAt: this.now()});
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_argument_outlines(id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash)
        VALUES (?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.artifactId, snapshot.version, request.requestId, json, snapshotHash);
      return {snapshot, snapshotHash};
    })();
  }

  history(input: ResearchArgumentOutlineHistory): ResearchArgumentOutlineHistoryResult {
    const request = researchArgumentOutlineHistorySchema.parse(input);
    this.scope(request);
    const rows = this.db.prepare('SELECT * FROM research_argument_outlines WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_argument_outlines WHERE artifact_id=?').pluck().get(request.artifactId) as number;
    return {verification: 'stored_receipt', items: rows.map(row => this.read(row)), total};
  }

  materialize(input: ResearchArgumentOutlineMaterialize): ResearchArgumentOutlineMaterialized {
    const request = researchArgumentOutlineMaterializeSchema.parse(input);
    const actor = requireResearchHuman('research.argumentOutlines.materialize', request.projectId);
    return this.db.transaction(() => {
      this.writable(request.projectId);
      const prior = this.db.prepare('SELECT request_hash,actor_id,response_json,response_hash FROM research_argument_materializations WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Applied | undefined;
      if (prior !== undefined) {
        if (prior.request_hash !== digest(request) || prior.actor_id !== actor.id) throw new Error('research_argument_outline_request_conflict');
        if (researchContentHash(prior.response_json) !== prior.response_hash) throw new Error('research_argument_outline_snapshot_invalid');
        return researchArgumentOutlineMaterializedSchema.parse(JSON.parse(prior.response_json));
      }
      const outline = this.row(request.projectId, request.outlineId);
      const inspection = this.inspect({projectId: request.projectId, artifactId: outline.snapshot.request.artifactId});
      if (outline.snapshotHash !== request.expectedOutlineHash || inspection.latest?.snapshot.id !== outline.snapshot.id ||
          !inspection.latestCurrent || inspection.matrixHash !== request.expectedMatrixHash) throw new Error('research_argument_outline_source_changed');
      const workflow = this.research.getWorkflow(request.projectId);
      const stage = workflow.stages.find(value => value.stage === workflow.currentStage);
      if (!['writing', 'revision'].includes(workflow.currentStage) || stage?.activeRunId !== null) {
        throw new Error('research_argument_outline_writing_stage_required');
      }
      const target = request.target.kind === 'new'
        ? this.research.createArtifact({projectId: request.projectId, stage: workflow.currentStage, kind: 'manuscript', title: request.target.title, path: null})
        : this.research.getArtifact(request.target.artifactId);
      if (target.projectId !== request.projectId || target.kind !== 'manuscript' || target.stage !== workflow.currentStage || target.status !== 'draft') {
        throw new Error('research_argument_outline_target_invalid');
      }
      if (request.target.kind === 'existing' && this.research.inspectArtifact({projectId: request.projectId,
        artifactId: target.id, expectedVersion: request.target.expectedVersion}).status !== 'current') throw new Error('research_argument_outline_target_changed');
      if (this.db.prepare('SELECT 1 FROM research_manuscript_sync_bindings WHERE artifact_id=?').get(target.id) !== undefined) {
        throw new Error('research_argument_outline_target_bound');
      }
      const claims: ResearchArgumentOutlineMaterialized['claims'] = [];
      const sections = outline.snapshot.request.sections.map(section => ({title: section.title, claimIds: section.claimIds.map(id => {
        const source = this.research.evidence.getClaim(id);
        const claim = source.artifactId === target.id ? source : this.research.evidence.createClaim({projectId: request.projectId,
          artifactId: target.id, subjectType: source.subjectType, content: source.content, status: source.status,
          evidenceIds: source.evidenceIds, experiment: source.experiment});
        claims.push({sourceClaimId: id, claimId: claim.id});
        return claim.id;
      })}));
      const manuscript = this.research.manuscripts.saveManuscript({artifactId: target.id, sections});
      const response = researchArgumentOutlineMaterializedSchema.parse({materializationId: `outline_materialization_${randomUUID()}`,
        artifactId: target.id, artifactVersion: this.research.inspectArtifact({projectId: request.projectId, artifactId: target.id, expectedVersion: null}).snapshot.version,
        manuscriptHash: manuscript.contentHash, outlineId: outline.snapshot.id, outlineHash: outline.snapshotHash, claims});
      const json = JSON.stringify(response);
      this.db.prepare(`INSERT INTO research_argument_materializations(id,project_id,request_id,outline_id,artifact_id,request_hash,actor_id,response_json,response_hash)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(response.materializationId, request.projectId, request.requestId, outline.snapshot.id,
        target.id, digest(request), actor.id, json, researchContentHash(json));
      return response;
    })();
  }

  private matrix(projectId: string): MatrixRow[] {
    const artifacts = new Map(this.research.listArtifacts(projectId).filter(artifact => artifact.status !== 'superseded').map(artifact => [artifact.id, artifact]));
    const relations = this.research.evidence.relations.list({projectId, claimId: null});
    return byId(this.research.evidence.listClaims({projectId})).filter(claim => claim.subjectType !== 'figure' && artifacts.has(claim.artifactId))
      .map(claim => {
        const claimHash = relationClaimHash(claim), selected = relations.filter(relation => relation.claimId === claim.id);
        const sources = [...new Set([...claim.evidenceIds, ...selected.map(relation => relation.evidenceId)])].sort()
          .map(id => this.research.evidence.inspectEvidence(id, projectId));
        const currentRelations = selected.map(relation => ({...relation, current:
          (relation.status === 'confirmed' || relation.status === 'proposed') && relation.claimVersion === claim.version && relation.claimHash === claimHash &&
          sources.some(source => source.evidence.id === relation.evidenceId && source.referenceStatus === 'recorded' && relationSourceDigest(source) === relation.sourceDigest)}));
        const gaps: string[] = [];
        if (claim.status !== 'supported') gaps.push('主张尚未标记为有依据。');
        if (sources.some(source => source.referenceStatus !== 'recorded')) gaps.push('存在已失效的来源。');
        if (!currentRelations.some(relation => relation.current && relation.status === 'confirmed' && relation.kind === 'supports')) gaps.push('没有当前人工确认的支持关系。');
        if (currentRelations.some(relation => relation.current && relation.status === 'confirmed' && relation.kind === 'contradicts')) gaps.push('存在当前反证关系，需要在论证中处理。');
        return {claim, claimHash, sources, relations: currentRelations, gaps};
      });
  }

  private current(receipt: ResearchArgumentOutlineReceipt, matrix: MatrixRow[]): boolean {
    const selected = receipt.snapshot.claims.map(reference => matrix.find(row => row.claim.id === reference.claimId && row.claimHash === reference.expectedClaimHash));
    return selected.every(row => row !== undefined) && digest(selected) === receipt.snapshot.materialHash;
  }
  private scope(request: ResearchArgumentOutlineInspect): void {
    this.research.getProject(request.projectId);
    const artifact = this.research.getArtifact(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_argument_outline_project_mismatch');
    if (!['reading_notes', 'manuscript'].includes(artifact.kind)) throw new Error('research_argument_outline_source_required');
  }
  private writable(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private latest(projectId: string, artifactId: string): ResearchArgumentOutlineReceipt | null {
    const row = this.db.prepare('SELECT * FROM research_argument_outlines WHERE project_id=? AND artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(projectId, artifactId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }
  private row(projectId: string, id: string): ResearchArgumentOutlineReceipt {
    const row = this.db.prepare('SELECT * FROM research_argument_outlines WHERE id=?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_argument_outline_not_found');
    if (row.project_id !== projectId) throw new Error('research_argument_outline_project_mismatch');
    return this.read(row);
  }
  private read(row: Row): ResearchArgumentOutlineReceipt {
    const snapshot = researchArgumentOutlineReceiptSchema.shape.snapshot.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
        snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
        snapshot.request.requestId !== row.request_id || snapshot.version !== row.version || snapshot.requestHash !== digest(snapshot.request)) {
      throw new Error('research_argument_outline_snapshot_invalid');
    }
    const claimIds = snapshot.request.sections.flatMap(section => section.claimIds);
    if (claimIds.length !== snapshot.claims.length || snapshot.claims.some((reference, index) => reference.claimId !== claimIds[index])) {
      throw new Error('research_argument_outline_snapshot_invalid');
    }
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_argument_outline_snapshot_invalid');
    } else {
      const previous = this.db.prepare('SELECT * FROM research_argument_outlines WHERE id=?').get(parent.outlineId) as Row | undefined;
      if (previous === undefined || previous.project_id !== row.project_id || previous.artifact_id !== row.artifact_id ||
          previous.version !== row.version - 1 || previous.snapshot_hash !== parent.outlineHash ||
          researchContentHash(previous.snapshot_json) !== parent.outlineHash) throw new Error('research_argument_outline_snapshot_invalid');
    }
    return {snapshot, snapshotHash: row.snapshot_hash};
  }
}
