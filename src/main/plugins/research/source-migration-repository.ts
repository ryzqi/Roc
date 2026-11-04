import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {ResearchInspectedEvidence} from '../../../shared/schemas/research-evidence-source';
import type {ResearchEvidenceCaptureRequest, ResearchEvidence} from '../../../shared/types';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import {
  researchSourceMigrationListSchema, researchSourceMigrationProposalSchema,
  researchSourceMigrationGetSchema, researchSourceMigrationDecisionRequestSchema, researchSourceMigrationDecisionSchema,
  type ResearchSourceMigrationProposal, type ResearchSourceMigrationInspection,
  type ResearchSourceMigrationDecisionRequest, type ResearchSourceMigrationDecision
} from '../../../shared/schemas/research-source-migrations';
import {storedDocumentContentSchema} from './document-repository';
import {relationSourceDigest} from './evidence-relation-repository';

type EvidenceAccess = {
  inspectEvidence(id: string, projectId: string): ResearchInspectedEvidence;
  capture(request: ResearchEvidenceCaptureRequest): ResearchEvidence;
};
type Target = ResearchSourceMigrationProposal['targets'][number];
type ProposalRow = {
  id: string; project_id: string; evidence_id: string; target_parse_id: string; snapshot_json: string; snapshot_hash: string
};
type DecisionRow = {id: string; project_id: string; proposal_id: string; request_id: string; snapshot_json: string; snapshot_hash: string};

/** Parser changes propose raw target blocks. They never rewrite evidence or restore scientific review. */
export class ResearchSourceMigrationRepository {
  constructor(private readonly db: Database, private readonly evidence: EvidenceAccess, private readonly now: () => string) {}

  proposeForParse(documentId: string, parseId: string): void {
    if (!this.db.inTransaction) throw new Error('research_source_migration_transaction_required');
    const row = this.db.prepare(`SELECT d.current_parse_id,d.source_hash,p.status,p.data_json
      FROM research_documents d JOIN research_document_parses p ON p.document_id=d.id
      WHERE d.id=? AND p.id=?`).get(documentId, parseId) as {
        current_parse_id: string | null; source_hash: string; status: string; data_json: string | null
      } | undefined;
    if (row === undefined) throw new Error('research_source_migration_target_not_found');
    if (row.current_parse_id !== parseId || row.status !== 'ready' || row.data_json === null) {
      throw new Error('research_source_migration_target_stale');
    }
    const {content} = storedDocumentContentSchema.parse(JSON.parse(row.data_json));
    if (content.sourceHash !== row.source_hash) throw new Error('research_source_migration_source_changed');
    const sources = this.db.prepare(`SELECT e.id,e.project_id FROM research_evidence e
      JOIN research_evidence_source_locators l ON l.evidence_id=e.id
      WHERE json_extract(l.locator_json,'$.documentId')=? AND json_extract(l.locator_json,'$.parseId')<>?
        AND e.invalidated_at IS NOT NULL ORDER BY e.rowid`).all(documentId, parseId) as Array<{id: string; project_id: string}>;
    if (sources.length === 0) return;
    const exact = new Map<string, Target[]>(), normalized = new Map<string, Target[]>();
    for (const [index, block] of content.blocks.filter(block => block.text.trim()).entries()) {
      const target = {chunkId: `document:${parseId}:chunk:${index}`, block};
      const chunk = this.db.prepare('SELECT content,locator FROM research_knowledge_chunks WHERE id=?')
        .get(target.chunkId) as {content: string; locator: string} | undefined;
      if (chunk === undefined || chunk.content !== block.text || chunk.locator !== block.locator) {
        throw new Error('research_source_migration_index_changed');
      }
      append(exact, block.text, target);
      append(normalized, normalize(block.text), target);
    }
    for (const row of sources) {
      if (this.db.prepare('SELECT id FROM research_source_migration_proposals WHERE evidence_id=? AND target_parse_id=?')
        .get(row.id, parseId) !== undefined) continue;
      const source = this.evidence.inspectEvidence(row.id, row.project_id);
      const exactTargets = exact.get(source.evidence.excerpt);
      const normalizedTargets = normalized.get(normalize(source.evidence.excerpt));
      const targets = exactTargets === undefined ? normalizedTargets === undefined ? [] : normalizedTargets : exactTargets;
      const match = targets.length === 0 ? 'no_match' : targets.length > 1 ? 'ambiguous' :
        exactTargets === undefined ? 'normalized_text' : 'exact_text';
      const proposal = researchSourceMigrationProposalSchema.parse({
        id: `source_migration_${randomUUID()}`, projectId: row.project_id, evidenceId: row.id,
        source, sourceDigest: relationSourceDigest(source), documentId, targetParseId: parseId,
        targetSourceHash: content.sourceHash, targetParseHash: hash(JSON.stringify(content)),
        parserFingerprint: content.parserFingerprint, matchingRule: 'exact_text_then_whitespace/1',
        match, targets, status: 'needs_review', createdAt: this.now()
      });
      this.db.prepare(`INSERT INTO research_source_migration_proposals
        (id,project_id,evidence_id,document_id,target_parse_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(proposal.id, proposal.projectId, proposal.evidenceId, documentId, parseId,
          JSON.stringify(proposal), hash(JSON.stringify(proposal)), proposal.createdAt);
    }
  }

  list(input: {projectId: string; evidenceId: string}): ResearchSourceMigrationInspection[] {
    const request = researchSourceMigrationListSchema.parse(input);
    this.evidence.inspectEvidence(request.evidenceId, request.projectId);
    const rows = this.db.prepare(`SELECT * FROM research_source_migration_proposals
      WHERE project_id=? AND evidence_id=? ORDER BY rowid`).all(request.projectId, request.evidenceId) as ProposalRow[];
    return rows.map(row => this.inspect(row, request.projectId));
  }

  get(input: {projectId: string; proposalId: string}): ResearchSourceMigrationInspection {
    const request = researchSourceMigrationGetSchema.parse(input);
    const row = this.db.prepare('SELECT * FROM research_source_migration_proposals WHERE id=?')
      .get(request.proposalId) as ProposalRow | undefined;
    if (row === undefined) throw new Error('research_source_migration_not_found');
    return this.inspect(row, request.projectId);
  }

  /** One immutable human decision per proposal. Capturing a location never changes a scientific claim. */
  decide(input: ResearchSourceMigrationDecisionRequest, decidedBy: ResearchRelationReviewer): ResearchSourceMigrationDecision {
    const request = researchSourceMigrationDecisionRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(decidedBy);
    return this.db.transaction(() => {
      const project = this.db.prepare('SELECT status FROM research_projects WHERE id=?').get(request.projectId) as {status: string} | undefined;
      if (project === undefined) throw new Error('research_project_not_found');
      if (project.status === 'archived') throw new Error('research_project_archived');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_source_migration_decisions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as DecisionRow | undefined;
      if (replay !== undefined) {
        const decision = this.readDecision(replay);
        if (decision.requestHash !== requestHash || decision.actor.id !== actor.id) {
          throw new Error('research_source_migration_request_conflict');
        }
        return decision;
      }
      const inspection = this.get({projectId: request.projectId, proposalId: request.proposalId});
      const {proposal} = inspection;
      if (inspection.decision !== null) throw new Error('research_source_migration_already_decided');
      if (request.expectedProposalHash !== inspection.proposalHash) throw new Error('research_source_migration_proposal_changed');
      if (request.expectedSourceDigest !== proposal.sourceDigest ||
          relationSourceDigest(this.evidence.inspectEvidence(proposal.evidenceId, request.projectId)) !== proposal.sourceDigest) {
        throw new Error('research_source_migration_source_changed');
      }
      if (request.expectedTargetParseHash !== proposal.targetParseHash) throw new Error('research_source_migration_target_changed');
      let capturedSource: ResearchInspectedEvidence | null = null;
      if (request.action === 'capture') {
        if (inspection.targetStatus !== 'current') throw new Error('research_source_migration_target_stale');
        const target = proposal.targets.find(target => target.chunkId === request.chunkId);
        if (target === undefined) throw new Error('research_source_migration_target_not_proposed');
        const chunk = this.db.prepare('SELECT document_id,content,locator,content_hash FROM research_knowledge_chunks WHERE id=?')
          .get(target.chunkId) as {document_id: string; content: string; locator: string; content_hash: string} | undefined;
        if (chunk === undefined || chunk.document_id !== `document:${proposal.targetParseId}` ||
            chunk.content !== target.block.text || chunk.locator !== target.block.locator || chunk.content_hash !== hash(target.block.text)) {
          throw new Error('research_source_migration_index_changed');
        }
        const captured = this.evidence.capture({projectId: request.projectId, chunkId: target.chunkId});
        capturedSource = this.evidence.inspectEvidence(captured.id, request.projectId);
        const locator = capturedSource.sourceLocator;
        if (capturedSource.referenceStatus !== 'recorded' || captured.excerpt !== target.block.text ||
            captured.locator !== target.block.locator || locator === null || locator.documentId !== proposal.documentId ||
            locator.parseId !== proposal.targetParseId || locator.parseHash !== proposal.targetParseHash ||
            locator.sourceHash !== proposal.targetSourceHash || locator.parserFingerprint !== proposal.parserFingerprint ||
            locator.blockId !== target.block.id) throw new Error('research_source_migration_capture_changed');
      }
      const decision = researchSourceMigrationDecisionSchema.parse({
        id: `source_migration_decision_${randomUUID()}`, projectId: request.projectId, proposalId: proposal.id,
        evidenceId: proposal.evidenceId, request, requestHash, actor, capturedSource,
        capturedSourceDigest: capturedSource === null ? null : relationSourceDigest(capturedSource), recordedAt: this.now()
      });
      this.db.prepare(`INSERT INTO research_source_migration_decisions
        (id,project_id,proposal_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(decision.id, decision.projectId, decision.proposalId, request.requestId,
          JSON.stringify(decision), hash(JSON.stringify(decision)), decision.recordedAt);
      return decision;
    })();
  }

  private inspect(row: ProposalRow, projectId: string): ResearchSourceMigrationInspection {
    if (row.project_id !== projectId) throw new Error('research_source_migration_project_mismatch');
    const proposal = researchSourceMigrationProposalSchema.parse(JSON.parse(row.snapshot_json));
    if (proposal.id !== row.id || proposal.targetParseId !== row.target_parse_id ||
        proposal.projectId !== row.project_id || proposal.evidenceId !== row.evidence_id ||
        hash(JSON.stringify(proposal)) !== row.snapshot_hash ||
        relationSourceDigest(proposal.source) !== proposal.sourceDigest) throw new Error('research_source_migration_snapshot_invalid');
    this.evidence.inspectEvidence(proposal.evidenceId, projectId);
    const decisionRow = this.db.prepare('SELECT * FROM research_source_migration_decisions WHERE proposal_id=?')
      .get(proposal.id) as DecisionRow | undefined;
    const decision = decisionRow === undefined ? null : this.readDecision(decisionRow);
    if (decision !== null && (decision.evidenceId !== proposal.evidenceId ||
        decision.request.expectedProposalHash !== row.snapshot_hash ||
        decision.request.expectedSourceDigest !== proposal.sourceDigest ||
        decision.request.expectedTargetParseHash !== proposal.targetParseHash)) {
      throw new Error('research_source_migration_snapshot_invalid');
    }
    const capturedReferenceStatus = decision === null || decision.capturedSource === null ? null :
      this.evidence.inspectEvidence(decision.capturedSource.evidence.id, projectId).referenceStatus;
    const target = this.db.prepare(`SELECT d.current_parse_id,d.source_hash,p.status,p.data_json FROM research_documents d
      JOIN research_document_parses p ON p.document_id=d.id WHERE d.id=? AND p.id=?`)
      .get(proposal.documentId, proposal.targetParseId) as {
        current_parse_id: string | null; source_hash: string; status: string; data_json: string | null
      } | undefined;
    if (target === undefined) throw new Error('research_source_migration_target_not_found');
    if (target.current_parse_id !== proposal.targetParseId || target.status !== 'ready') {
      return {proposal, proposalHash: row.snapshot_hash, targetStatus: 'stale', decision, capturedReferenceStatus};
    }
    if (target.source_hash !== proposal.targetSourceHash) throw new Error('research_source_migration_source_changed');
    if (target.data_json === null) throw new Error('research_source_migration_target_invalid');
    if (hash(JSON.stringify(storedDocumentContentSchema.parse(JSON.parse(target.data_json)).content)) !== proposal.targetParseHash) {
      throw new Error('research_source_migration_target_changed');
    }
    return {proposal, proposalHash: row.snapshot_hash, targetStatus: 'current', decision, capturedReferenceStatus};
  }

  private readDecision(row: DecisionRow): ResearchSourceMigrationDecision {
    const decision = researchSourceMigrationDecisionSchema.parse(JSON.parse(row.snapshot_json));
    if (hash(JSON.stringify(decision)) !== row.snapshot_hash || decision.id !== row.id ||
        decision.projectId !== row.project_id || decision.proposalId !== row.proposal_id ||
        decision.request.requestId !== row.request_id || hash(JSON.stringify(decision.request)) !== decision.requestHash ||
        (decision.capturedSource !== null && relationSourceDigest(decision.capturedSource) !== decision.capturedSourceDigest)) {
      throw new Error('research_source_migration_snapshot_invalid');
    }
    return decision;
  }
}

function append(index: Map<string, Target[]>, key: string, target: Target): void {
  const targets = index.get(key);
  if (targets === undefined) index.set(key, [target]);
  else targets.push(target);
}
const normalize = (text: string): string => text.trim().replace(/\s+/gu, ' ');
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
