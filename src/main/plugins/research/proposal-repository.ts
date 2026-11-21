import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchProposalCreateSchema, researchProposalGetSchema, researchProposalListSchema, researchProposalRejectSchema,
  researchProposalSnapshotSchema, researchProposalRejectionSchema,
  type ResearchProposalCreate, type ResearchProposalGet, type ResearchProposalList, type ResearchProposalReject,
  type ResearchProposalInspection, type ResearchProposalListResult, type ResearchProposalOrigin
} from '../../../shared/schemas/research-proposals';
import {getCapabilityOperationContext, recordCapabilityOperationReceipt} from '../../kernel/capability-operation-context';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {relationClaimHash} from './evidence-relation-repository';
import {ResearchCitationCoverageService} from './citation-coverage-service';
import {figureManifest} from './figure-repository';
import type {ResearchRepository} from './repository';
import type {ResearchArtifact} from '../../../shared/types';

type Row = {
  id: string; project_id: string; artifact_id: string; request_id: string; operation_id: string;
  status: 'pending' | 'rejected'; snapshot_json: string; snapshot_hash: string;
  rejection_json: string | null; rejection_hash: string | null; rejection_request_id: string | null; created_at: string
};
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const artifactKinds: Record<ResearchProposalCreate['proposal']['kind'], readonly ResearchArtifact['kind'][]> = {
  submission_profile: ['manuscript'], argument_outline: ['reading_notes', 'manuscript'], idea_plan: ['idea_canvas'], citation_review: ['manuscript'], consistency: ['manuscript', 'figure'],
  figure_consistency: ['figure'], response_matrix: ['manuscript'], journal_compliance: ['manuscript'], experiment_result: ['experiment_run']
};

/** Suggestions are immutable inputs to existing human forms, never domain review receipts. */
export class ResearchProposalRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  create(input: ResearchProposalCreate): ResearchProposalInspection {
    const request = researchProposalCreateSchema.parse(input);
    return this.db.transaction(() => {
      const {operation, origin} = this.authorizeCreation(request);
      const replay = this.existing(request, origin);
      if (replay !== null) {
        recordCapabilityOperationReceipt(operation);
        return replay;
      }
      if (this.db.prepare('SELECT 1 FROM research_proposals WHERE operation_id=?').get(origin.operationId) !== undefined) {
        throw new Error('research_proposal_request_conflict');
      }
      this.assertBaseline(request);
      const materialHash = this.materialHash(request);
      const snapshot = researchProposalSnapshotSchema.parse({schemaVersion: 1, id: `proposal_${randomUUID()}`,
        request, requestHash: digest(request), origin, materialHash, recordedAt: this.now()});
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_proposals
        (id,project_id,artifact_id,request_id,operation_id,status,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,'pending',?,?,?)`).run(snapshot.id, request.projectId, request.artifactId,
        request.requestId, origin.operationId, json, researchContentHash(json), snapshot.recordedAt);
      const saved = this.get({projectId: request.projectId, proposalId: snapshot.id});
      recordCapabilityOperationReceipt(operation);
      return saved;
    })();
  }

  /** Recover a prior write before touching sources that may have changed since publication. */
  replay(request: ResearchProposalCreate): ResearchProposalInspection | null {
    const {operation, origin} = this.authorizeCreation(request);
    const existing = this.existing(request, origin);
    if (existing !== null) recordCapabilityOperationReceipt(operation);
    return existing;
  }

  private authorizeCreation(request: ResearchProposalCreate) {
    const operation = getCapabilityOperationContext();
    if (operation === undefined) throw new Error('research_proposal_operation_required');
    const origin = this.research.tasks.requireProposalOrigin(request.projectId, operation);
    if (request.requestId !== origin.idempotencyKey) throw new Error('research_proposal_request_conflict');
    this.writable(request.projectId);
    return {operation, origin};
  }

  private existing(request: ResearchProposalCreate, origin: ResearchProposalOrigin): ResearchProposalInspection | null {
    const row = this.db.prepare('SELECT * FROM research_proposals WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    if (row === undefined) return null;
    const saved = this.read(row);
    if (saved.snapshot.requestHash !== digest(request) || digest(saved.snapshot.origin) !== digest(origin)) {
      throw new Error('research_proposal_request_conflict');
    }
    return this.inspect(saved);
  }

  get(input: ResearchProposalGet): ResearchProposalInspection {
    const request = researchProposalGetSchema.parse(input);
    this.research.getProject(request.projectId);
    return this.inspect(this.read(this.row(request.projectId, request.proposalId)));
  }

  list(input: ResearchProposalList): ResearchProposalListResult {
    const request = researchProposalListSchema.parse(input);
    this.research.getProject(request.projectId);
    if (request.artifactId !== undefined) this.scope(request.projectId, request.artifactId);
    const filter = `project_id=? AND (? IS NULL OR artifact_id=?) AND (? IS NULL OR status=?)
      AND (? IS NULL OR json_extract(snapshot_json,'$.request.proposal.kind')=?)`;
    const values = [request.projectId, request.artifactId ?? null, request.artifactId ?? null,
      request.status ?? null, request.status ?? null, request.kind ?? null, request.kind ?? null];
    const rows = this.db.prepare(`SELECT * FROM research_proposals WHERE ${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, request.limit, request.offset) as Row[];
    const total = this.db.prepare(`SELECT count(*) FROM research_proposals WHERE ${filter}`).pluck().get(...values) as number;
    return {items: rows.map(row => this.inspect(this.read(row))), total};
  }

  reject(input: ResearchProposalReject): ResearchProposalInspection {
    const request = researchProposalRejectSchema.parse(input);
    const actor = requireResearchHuman('research.proposals.reject', request.projectId);
    return this.db.transaction(() => {
      this.writable(request.projectId);
      const row = this.row(request.projectId, request.proposalId), saved = this.read(row);
      if (saved.snapshotHash !== request.expectedHash) throw new Error('research_proposal_hash_mismatch');
      if (saved.rejection !== null) {
        if (digest(saved.rejection.request) !== digest(request) || digest(saved.rejection.actor) !== digest(actor)) {
          throw new Error('research_proposal_request_conflict');
        }
        return this.inspect(saved);
      }
      if (this.db.prepare('SELECT 1 FROM research_proposals WHERE project_id=? AND rejection_request_id=?')
        .get(request.projectId, request.requestId) !== undefined) throw new Error('research_proposal_request_conflict');
      const rejection = researchProposalRejectionSchema.parse({request, actor, recordedAt: this.now()});
      const json = JSON.stringify(rejection);
      this.db.prepare(`UPDATE research_proposals SET status='rejected',rejection_json=?,rejection_hash=?,rejection_request_id=? WHERE id=?`)
        .run(json, researchContentHash(json), request.requestId, request.proposalId);
      return this.inspect({...saved, status: 'rejected', rejection});
    })();
  }

  private writable(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private scope(projectId: string, artifactId: string) {
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_proposal_project_mismatch');
    return artifact;
  }
  private row(projectId: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM research_proposals WHERE id=?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_proposal_not_found');
    if (row.project_id !== projectId) throw new Error('research_proposal_project_mismatch');
    return row;
  }
  private read(row: Row): Omit<ResearchProposalInspection, 'freshness' | 'staleReasons'> {
    const snapshot = researchProposalSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const rejection = row.rejection_json === null ? null : researchProposalRejectionSchema.parse(JSON.parse(row.rejection_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
        snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
        snapshot.request.requestId !== row.request_id || snapshot.requestHash !== digest(snapshot.request) ||
        snapshot.origin.operationId !== row.operation_id || snapshot.recordedAt !== row.created_at ||
        (row.status === 'rejected') !== (rejection !== null) ||
        (rejection !== null && (JSON.stringify(rejection) !== row.rejection_json || digest(rejection) !== row.rejection_hash ||
          rejection.request.projectId !== row.project_id || rejection.request.proposalId !== row.id ||
          rejection.request.requestId !== row.rejection_request_id || rejection.request.expectedHash !== row.snapshot_hash))) {
      throw new Error('research_proposal_snapshot_invalid');
    }
    return {snapshot, snapshotHash: row.snapshot_hash, status: row.status, rejection};
  }
  private inspect(saved: Omit<ResearchProposalInspection, 'freshness' | 'staleReasons'>): ResearchProposalInspection {
    const request = saved.snapshot.request;
    const staleReasons: ResearchProposalInspection['staleReasons'] = [];
    for (const basis of [{artifactId: request.artifactId, expectedVersion: request.expectedArtifactVersion}, ...request.basis]) {
      try {
        const artifact = this.scope(request.projectId, basis.artifactId);
        if (artifact.status === 'superseded' || this.research.inspectArtifact({projectId: request.projectId,
          artifactId: basis.artifactId, expectedVersion: basis.expectedVersion}).status === 'stale') {
          staleReasons.push({artifactId: basis.artifactId, reason: 'artifact_changed'});
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'research_artifact_not_found') throw error;
        staleReasons.push({artifactId: basis.artifactId, reason: 'artifact_missing'});
      }
    }
    try {
      if (this.materialHash(request) !== saved.snapshot.materialHash) staleReasons.push({artifactId: request.artifactId, reason: 'material_changed'});
    } catch (error) {
      if (!(error instanceof Error) || !/changed|mismatch|not_found|superseded|stale|required|conflict/u.test(error.message)) throw error;
      staleReasons.push({artifactId: request.artifactId, reason: error.message.split(':')[0].slice(0, 300)});
    }
    if (this.research.getProject(request.projectId).status === 'archived') staleReasons.push({artifactId: request.artifactId, reason: 'project_archived'});
    return {...saved, freshness: staleReasons.length === 0 ? 'current' : 'stale', staleReasons};
  }
  private assertBaseline(request: ResearchProposalCreate): void {
    const artifact = this.scope(request.projectId, request.artifactId);
    if (!artifactKinds[request.proposal.kind].includes(artifact.kind)) throw new Error('research_proposal_artifact_kind_mismatch');
    for (const basis of [{artifactId: request.artifactId, expectedVersion: request.expectedArtifactVersion}, ...request.basis]) {
      if (this.scope(request.projectId, basis.artifactId).status === 'superseded' ||
          this.research.inspectArtifact({projectId: request.projectId, artifactId: basis.artifactId,
            expectedVersion: basis.expectedVersion}).status !== 'current') throw new Error('research_proposal_baseline_changed');
    }
    const payload = request.proposal.payload;
    if ('artifactId' in payload && payload.artifactId !== request.artifactId) throw new Error('research_proposal_target_mismatch');
    if ('expectedArtifactVersion' in payload && payload.expectedArtifactVersion !== request.expectedArtifactVersion) {
      throw new Error('research_proposal_baseline_changed');
    }
  }
  private materialHash(request: ResearchProposalCreate): string {
    const material: unknown[] = [], evidenceIds = new Set<string>();
    const {projectId, artifactId, proposal} = request;
    const parent = (latest: {snapshot: {id: string}; snapshotHash: string} | null,
      expected: {reviewId: string; reviewHash: string} | null): void => {
      if (latest === null ? expected !== null : expected?.reviewId !== latest.snapshot.id || expected.reviewHash !== latest.snapshotHash) {
        throw new Error('research_proposal_parent_changed');
      }
      material.push(latest);
    };
    const claim = (claimId: string, expectedHash?: string): void => {
      const value = this.research.evidence.getClaim(claimId);
      if (value.projectId !== projectId || value.artifactId !== artifactId) throw new Error('research_proposal_project_mismatch');
      if (expectedHash !== undefined && relationClaimHash(value) !== expectedHash) throw new Error('research_proposal_material_changed');
      material.push(value);
    };
    switch (proposal.kind) {
      case 'submission_profile':
        material.push(this.research.submissionProfiles.validateDraft({...proposal.payload, projectId, requestId: request.requestId}));
        break;
      case 'argument_outline':
        material.push(this.research.argumentOutlines.validateDraft({...proposal.payload, projectId, requestId: request.requestId}));
        break;
      case 'idea_plan': {
        const payload = proposal.payload, canvas = this.research.ideas.get(artifactId);
        if (canvas === null || canvas.version !== payload.canvas.version || canvas.contentHash !== payload.canvas.contentHash ||
            canvas.hypothesis !== payload.body.hypothesis) throw new Error('research_proposal_material_changed');
        const history = this.research.ideaPlans.history({projectId, artifactId, offset: 0, limit: 1}), latest = history.items[0];
        if (latest === undefined ? payload.parent !== null : payload.parent?.versionId !== latest.version.id ||
            payload.parent.versionHash !== latest.versionHash) throw new Error('research_proposal_parent_changed');
        material.push(canvas, history);
        payload.body.novelty.comparisons.forEach(item => evidenceIds.add(item.evidenceId));
        if (payload.body.observation.kind === 'after_data') payload.body.observation.evidenceIds.forEach(id => evidenceIds.add(id));
        if (payload.body.sampleSize.kind === 'calculated') payload.body.sampleSize.evidenceIds.forEach(id => evidenceIds.add(id));
        break;
      }
      case 'citation_review': {
        const payload = proposal.payload;
        claim(payload.claimId); evidenceIds.add(payload.evidenceId);
        const coverage = new ResearchCitationCoverageService(this.research).inspect({projectId, artifactId, expectedHash: payload.expectedReportHash});
        if (coverage.status !== 'current') throw new Error('research_proposal_material_changed');
        parent(this.research.citationReviews.history({projectId, artifactId, claimId: payload.claimId,
          evidenceId: payload.evidenceId, offset: 0, limit: 1}).items[0] ?? null, payload.parent);
        material.push(coverage.reportHash);
        break;
      }
      case 'consistency':
      case 'figure_consistency': {
        for (const binding of proposal.payload.bindings) {
          claim(binding.claimId, binding.expectedClaimHash); evidenceIds.add(binding.evidenceId);
          const receipt = this.research.experimentResults.get({projectId, resultId: binding.resultId, expectedHash: binding.resultHash});
          if (!receipt.snapshot.result.metrics.some(metric => metric.id === binding.metricId)) throw new Error('research_proposal_material_changed');
          material.push(receipt);
        }
        if (proposal.kind === 'figure_consistency') {
          const figure = this.research.figures.forArtifact(this.scope(projectId, artifactId));
          const run = this.research.figureRuns.get(projectId, figure.runId);
          if (figure.id !== proposal.payload.figure.id || researchContentHash(figureManifest(run, figure.validation)) !== proposal.payload.figure.manifestHash) {
            throw new Error('research_proposal_material_changed');
          }
          material.push(figure, run);
          parent(this.research.figureConsistency.latest(projectId, artifactId), proposal.payload.parent);
        } else parent(this.research.consistency.latest(projectId, artifactId), proposal.payload.parent);
        break;
      }
      case 'response_matrix':
        for (const row of proposal.payload.rows) {
          row.locations.forEach(location => claim(location.claimId, location.claimHash));
          row.evidenceIds.forEach(id => evidenceIds.add(id));
        }
        parent(this.research.responseMatrix.latest(projectId, artifactId), proposal.payload.parent);
        break;
      case 'journal_compliance':
        for (const id of proposal.payload.selection.figureIds) material.push(this.research.figures.get(projectId, id));
        parent(this.research.journalCompliance.latest(projectId, artifactId), proposal.payload.parent);
        break;
      case 'experiment_result': {
        const payload = proposal.payload, run = this.research.experiments.get(projectId, payload.runId);
        if (run.artifactId !== artifactId || run.inputHash !== payload.expectedInputHash || run.status !== 'completed' ||
            !run.files.some(file => file.area === 'output' && file.path === payload.resultPath && file.sha256 === payload.expectedResultHash)) {
          throw new Error('research_proposal_material_changed');
        }
        material.push(run, this.research.experimentResults.list({projectId, runId: run.id, limit: 1, offset: 0}));
        break;
      }
    }
    for (const evidenceId of [...evidenceIds].sort()) {
      const source = this.research.evidence.inspectEvidence(evidenceId, projectId);
      if (source.referenceStatus !== 'recorded') throw new Error('research_proposal_material_changed');
      material.push(source);
    }
    return digest(material);
  }
}
