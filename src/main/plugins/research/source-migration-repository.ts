import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {ResearchInspectedEvidence} from '../../../shared/schemas/research-evidence-source';
import {
  researchSourceMigrationListSchema, researchSourceMigrationProposalSchema,
  type ResearchSourceMigrationProposal, type ResearchSourceMigrationInspection
} from '../../../shared/schemas/research-source-migrations';
import {storedDocumentContentSchema} from './document-repository';
import {relationSourceDigest} from './evidence-relation-repository';

type EvidenceAccess = {inspectEvidence(id: string, projectId: string): ResearchInspectedEvidence};
type Target = ResearchSourceMigrationProposal['targets'][number];

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
    const rows = this.db.prepare(`SELECT id,target_parse_id,snapshot_json,snapshot_hash FROM research_source_migration_proposals
      WHERE project_id=? AND evidence_id=? ORDER BY rowid`).all(request.projectId, request.evidenceId) as Array<{
        id: string; target_parse_id: string; snapshot_json: string; snapshot_hash: string
      }>;
    return rows.map(row => {
      const proposal = researchSourceMigrationProposalSchema.parse(JSON.parse(row.snapshot_json));
      if (proposal.id !== row.id || proposal.targetParseId !== row.target_parse_id ||
          proposal.projectId !== request.projectId || proposal.evidenceId !== request.evidenceId ||
          hash(JSON.stringify(proposal)) !== row.snapshot_hash ||
          relationSourceDigest(proposal.source) !== proposal.sourceDigest) throw new Error('research_source_migration_snapshot_invalid');
      const target = this.db.prepare(`SELECT d.current_parse_id,d.source_hash,p.status,p.data_json FROM research_documents d
        JOIN research_document_parses p ON p.document_id=d.id WHERE d.id=? AND p.id=?`)
        .get(proposal.documentId, proposal.targetParseId) as {
          current_parse_id: string | null; source_hash: string; status: string; data_json: string | null
        } | undefined;
      if (target === undefined) throw new Error('research_source_migration_target_not_found');
      if (target.current_parse_id !== proposal.targetParseId || target.status !== 'ready') {
        return {proposal, targetStatus: 'stale'};
      }
      if (target.source_hash !== proposal.targetSourceHash) throw new Error('research_source_migration_source_changed');
      if (target.data_json === null) throw new Error('research_source_migration_target_invalid');
      if (hash(JSON.stringify(storedDocumentContentSchema.parse(JSON.parse(target.data_json)).content)) !== proposal.targetParseHash) {
        throw new Error('research_source_migration_target_changed');
      }
      return {proposal, targetStatus: 'current'};
    });
  }
}

function append(index: Map<string, Target[]>, key: string, target: Target): void {
  const targets = index.get(key);
  if (targets === undefined) index.set(key, [target]);
  else targets.push(target);
}
const normalize = (text: string): string => text.trim().replace(/\s+/gu, ' ');
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
