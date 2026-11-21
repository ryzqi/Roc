import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {extname} from 'node:path';
import {
  researchFeedbackImportSchema, researchFeedbackSnapshotSchema, researchFeedbackGetSchema, researchFeedbackListSchema,
  researchFeedbackMergeSchema, researchFeedbackMergeReceiptSchema, researchExternalCommentSchema,
  type ResearchFeedbackImport, type ResearchFeedbackGet, type ResearchFeedbackList, type ResearchFeedbackMerge,
  type ResearchFeedbackInspection, type ResearchFeedbackItem, type ResearchExternalComment
} from '../../../shared/schemas/research-feedback';
import type {ResearchClaim} from '../../../shared/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {readResearchFile, researchContentHash, researchWorkspace} from './research-files';
import {parseFeedbackDocx, parseFeedbackPdf, type ParsedFeedbackItem} from './feedback-parser';
import {relationClaimHash} from './evidence-relation-repository';
import {manuscriptClaimsHash} from './manuscript-repository';
import type {ResearchRepository} from './repository';

type Snapshot = ResearchFeedbackInspection['snapshot'];
type Row = {id: string; project_id: string; artifact_id: string; request_id: string; request_hash: string; snapshot_json: string; snapshot_hash: string};
const limit = 32 * 1024 * 1024;
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));

/** Imported review prose is immutable external data; human merge creates only open response comments. */
export class ResearchFeedbackService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async import(input: ResearchFeedbackImport): Promise<ResearchFeedbackInspection> {
    const request = researchFeedbackImportSchema.parse(input);
    const actor = requireResearchHuman('research.feedback.import', request.projectId);
    this.scope(request.projectId, request.artifactId, true);
    const existing = this.db.prepare('SELECT * FROM research_feedback_imports WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    if (existing !== undefined) {
      const saved = this.read(existing);
      if (existing.request_hash !== digest(request) || digest(saved.actor) !== digest(actor)) throw new Error('research_feedback_request_conflict');
      return this.inspect(existing);
    }
    this.assertVersion(request.projectId, request.artifactId, request.expectedArtifactVersion);
    const bundle = this.research.manuscripts.inspectBundle(request);
    const root = await researchWorkspace(this.research.getProject(request.projectId).workspacePath);
    const bytes = await readResearchFile(root, request.path, limit), sha256 = researchContentHash(bytes);
    if (request.expectedFileHash !== null && request.expectedFileHash !== sha256) throw new Error('research_feedback_source_changed');
    const kind = extname(request.path).toLowerCase() === '.docx' ? 'docx' : 'pdf';
    const parsed = kind === 'docx' ? await parseFeedbackDocx(bytes) : await parseFeedbackPdf(bytes);
    if (researchContentHash(await readResearchFile(root, request.path, limit)) !== sha256) throw new Error('research_feedback_source_changed');
    const snapshot = researchFeedbackSnapshotSchema.parse({schemaVersion: 1, id: `feedback_${randomUUID()}`,
      projectId: request.projectId, artifactId: request.artifactId, artifactVersion: request.expectedArtifactVersion,
      manuscriptHash: bundle.manuscript.contentHash, claimsHash: bundle.manuscript.claimsHash,
      request, actor, recordedAt: this.now(), source: {path: request.path, kind, sha256, size: bytes.length},
      items: parsed.items.map(item => ({...item, mapping: mapFeedbackQuote(item, bundle.claims)})), issues: parsed.issues});
    const row = this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId, true);
      this.assertVersion(request.projectId, request.artifactId, request.expectedArtifactVersion);
      const repeated = this.db.prepare('SELECT * FROM research_feedback_imports WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (repeated !== undefined) {
        const previous = this.read(repeated);
        if (repeated.request_hash !== digest(request) || digest(previous.actor) !== digest(actor)) throw new Error('research_feedback_request_conflict');
        return repeated;
      }
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_feedback_imports
        (id,project_id,artifact_id,request_id,request_hash,snapshot_json,snapshot_hash) VALUES (?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.projectId, request.artifactId, request.requestId, digest(request), json, researchContentHash(json));
      return this.row(request.projectId, snapshot.id);
    })();
    return this.inspect(row);
  }

  async get(input: ResearchFeedbackGet): Promise<ResearchFeedbackInspection> {
    const request = researchFeedbackGetSchema.parse(input);
    return this.inspect(this.row(request.projectId, request.feedbackId));
  }

  async list(input: ResearchFeedbackList): Promise<{items: ResearchFeedbackInspection[]; total: number}> {
    const request = researchFeedbackListSchema.parse(input);
    this.scope(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_feedback_imports WHERE project_id=? AND artifact_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.projectId, request.artifactId, request.limit, request.offset) as Row[];
    const items = [];
    for (const row of rows) items.push(await this.inspect(row));
    return {items, total: this.db.prepare('SELECT count(*) FROM research_feedback_imports WHERE project_id=? AND artifact_id=?')
      .pluck().get(request.projectId, request.artifactId) as number};
  }

  async merge(input: ResearchFeedbackMerge): Promise<{feedbackId: string; commentIds: string[]; artifactVersion: string}> {
    const request = researchFeedbackMergeSchema.parse(input);
    const actor = requireResearchHuman('research.feedback.merge', request.projectId);
    const replay = () => {
      const row = this.db.prepare('SELECT request_hash,actor_json,receipt_json FROM research_feedback_merges WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as {request_hash: string; actor_json: string; receipt_json: string} | undefined;
      if (row === undefined) return null;
      if (row.request_hash !== digest(request) || row.actor_json !== JSON.stringify(actor)) throw new Error('research_feedback_request_conflict');
      return researchFeedbackMergeReceiptSchema.parse(JSON.parse(row.receipt_json));
    };
    const repeated = replay();
    if (repeated !== null) return repeated;
    const saved = await this.get({projectId: request.projectId, feedbackId: request.feedbackId});
    if (saved.snapshotHash !== request.expectedHash || !saved.currentArtifact || !saved.sourceCurrent) throw new Error('research_feedback_source_changed');
    return this.db.transaction(() => {
      const repeated = replay();
      if (repeated !== null) return repeated;
      const snapshot = saved.snapshot;
      this.scope(request.projectId, snapshot.artifactId, true);
      this.assertVersion(request.projectId, snapshot.artifactId, request.expectedArtifactVersion);
      if (!this.current(snapshot)) throw new Error('research_feedback_artifact_changed');
      const selected = request.itemIds.map(id => {
        const item = snapshot.items.find(item => item.id === id);
        if (item === undefined) throw new Error('research_feedback_item_not_found');
        return externalComment(snapshot, saved.snapshotHash, item);
      });
      const current = this.mergedComments(request.projectId, snapshot.artifactId);
      const unique = new Set([...current.map(comment => comment.commentId), ...selected.map(comment => comment.commentId)]);
      const existingRows = this.research.responseMatrix.latest(request.projectId, snapshot.artifactId)?.snapshot.request.rows ?? [];
      if (new Set([...unique, ...existingRows.map(row => row.commentId)]).size > 200) throw new Error('research_feedback_response_limit');
      for (const comment of selected) this.db.prepare(`INSERT INTO research_feedback_comments
        (project_id,artifact_id,feedback_id,item_id,snapshot_json,snapshot_hash) VALUES (?,?,?,?,?,?) ON CONFLICT(feedback_id,item_id) DO NOTHING`)
        .run(request.projectId, snapshot.artifactId, snapshot.id, comment.itemId, JSON.stringify(comment), digest(comment));
      const result = researchFeedbackMergeReceiptSchema.parse({feedbackId: snapshot.id, commentIds: selected.map(comment => comment.commentId),
        artifactVersion: this.research.inspectArtifact({projectId: request.projectId, artifactId: snapshot.artifactId, expectedVersion: null}).snapshot.version});
      this.db.prepare('INSERT INTO research_feedback_merges(project_id,request_id,request_hash,actor_json,receipt_json) VALUES (?,?,?,?,?)')
        .run(request.projectId, request.requestId, digest(request), JSON.stringify(actor), JSON.stringify(result));
      return result;
    })();
  }

  mergedComments(projectId: string, artifactId: string): ResearchExternalComment[] {
    const result = new Map<string, ResearchExternalComment>();
    for (const ancestor of this.lineage(projectId, artifactId)) for (const comment of this.directComments(projectId, ancestor)) result.set(comment.commentId, comment);
    const claims = this.research.evidence.listClaims({projectId, artifactId});
    return [...result.values()].map(comment => ({...comment, location: comment.location !== null && claims.some(claim =>
      claim.id === comment.location!.claimId && relationClaimHash(claim) === comment.location!.claimHash &&
      claim.content.slice(comment.location!.start, comment.location!.end) === comment.location!.text) ? comment.location : null}));
  }

  private lineage(projectId: string, artifactId: string): string[] {
    const ancestors: string[] = [], visited = new Set<string>();
    let current: string | null = artifactId;
    while (current !== null) {
      if (visited.has(current) || visited.size >= 100) throw new Error('research_feedback_lineage_invalid');
      const artifact = this.research.getArtifact(current);
      if (artifact.projectId !== projectId || artifact.kind !== 'manuscript') throw new Error('research_feedback_lineage_invalid');
      visited.add(current); ancestors.push(current);
      const binding = this.db.prepare('SELECT parent_artifact_id FROM research_manuscript_sync_bindings WHERE artifact_id=?')
        .get(current) as {parent_artifact_id: string | null} | undefined;
      if (binding?.parent_artifact_id !== null && binding?.parent_artifact_id !== undefined) {current = binding.parent_artifact_id; continue;}
      const content = this.research.runs.getArtifactContent(projectId, current);
      if (content === null) break;
      const run = this.research.runs.get(content.runId, projectId);
      if (run.stage !== 'revision') break;
      const inputs = this.research.runs.getContext(run.id).inputs.filter(input => input.artifact.kind === 'manuscript');
      if (inputs.length !== 1) break;
      current = inputs[0].artifact.id;
    }
    return ancestors.reverse();
  }

  private directComments(projectId: string, artifactId: string): ResearchExternalComment[] {
    const imports = new Map<string, {row: Row; snapshot: Snapshot}>();
    return (this.db.prepare('SELECT * FROM research_feedback_comments WHERE project_id=? AND artifact_id=? ORDER BY rowid')
      .all(projectId, artifactId) as Array<{feedback_id: string; item_id: string; snapshot_json: string; snapshot_hash: string}>).map(row => {
      const comment = researchExternalCommentSchema.parse(JSON.parse(row.snapshot_json));
      let imported = imports.get(row.feedback_id);
      if (imported === undefined) {const source = this.row(projectId, row.feedback_id); imported = {row: source, snapshot: this.read(source)}; imports.set(row.feedback_id, imported);}
      const {row: source, snapshot} = imported;
      const item = snapshot.items.find(item => item.id === row.item_id);
      if (item === undefined || snapshot.artifactId !== artifactId || comment.feedbackId !== row.feedback_id ||
          comment.feedbackHash !== source.snapshot_hash || comment.itemId !== item.id || digest(comment) !== row.snapshot_hash) {
        throw new Error('research_feedback_snapshot_invalid');
      }
      if (digest(comment) !== digest(externalComment(snapshot, source.snapshot_hash, item))) throw new Error('research_feedback_snapshot_invalid');
      return comment;
    });
  }

  private async inspect(row: Row): Promise<ResearchFeedbackInspection> {
    const snapshot = this.read(row);
    let sourceCurrent = false;
    const workspacePath = this.research.getProject(row.project_id).workspacePath;
    try {
      const root = await researchWorkspace(workspacePath);
      const bytes = await readResearchFile(root, snapshot.source.path, limit);
      sourceCurrent = snapshot.source.sha256 === researchContentHash(bytes) && snapshot.source.size === bytes.length;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|research_(?:file|path|project_workspace|project_directory)/u.test(error.message)) throw error;
    }
    return {snapshot, snapshotHash: row.snapshot_hash, currentArtifact: this.current(snapshot),
      sourceCurrent: sourceCurrent && this.research.getProject(row.project_id).workspacePath === workspacePath};
  }

  private current(snapshot: Snapshot): boolean {
    const manuscript = this.research.manuscripts.getManuscript(snapshot.artifactId);
    return manuscript !== null && manuscript.contentHash === snapshot.manuscriptHash && manuscript.claimsHash === snapshot.claimsHash &&
      manuscriptClaimsHash(manuscript.sections.flatMap(section => section.claimIds).map(id => this.research.evidence.getClaim(id))) === snapshot.claimsHash &&
      this.research.getArtifact(snapshot.artifactId).status !== 'superseded';
  }

  private scope(projectId: string, artifactId: string, writable = false): void {
    const project = this.research.getProject(projectId), artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_feedback_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    if (writable && (project.status === 'archived' || artifact.status === 'superseded')) throw new Error('research_feedback_read_only');
  }

  private assertVersion(projectId: string, artifactId: string, expectedVersion: string): void {
    if (this.research.inspectArtifact({projectId, artifactId, expectedVersion}).status !== 'current') throw new Error('research_feedback_artifact_changed');
  }

  private row(projectId: string, feedbackId: string): Row {
    const row = this.db.prepare('SELECT * FROM research_feedback_imports WHERE id=?').get(feedbackId) as Row | undefined;
    if (row === undefined) throw new Error('research_feedback_not_found');
    if (row.project_id !== projectId) throw new Error('research_feedback_project_mismatch');
    return row;
  }

  private read(row: Row): Snapshot {
    const snapshot = researchFeedbackSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (snapshot.id !== row.id || snapshot.projectId !== row.project_id || snapshot.artifactId !== row.artifact_id ||
        snapshot.request.requestId !== row.request_id || digest(snapshot.request) !== row.request_hash || digest(snapshot) !== row.snapshot_hash ||
        snapshot.request.projectId !== snapshot.projectId || snapshot.request.artifactId !== snapshot.artifactId ||
        snapshot.source.path !== snapshot.request.path || snapshot.artifactVersion !== snapshot.request.expectedArtifactVersion ||
        new Set(snapshot.items.map(item => item.id)).size !== snapshot.items.length) throw new Error('research_feedback_snapshot_invalid');
    return snapshot;
  }
}

function externalComment(snapshot: Snapshot, snapshotHash: string, item: ResearchFeedbackItem): ResearchExternalComment {
  const commentId = `external_${researchContentHash(`${snapshot.id}:${item.id}`).slice(0, 32)}`;
  return researchExternalCommentSchema.parse({commentId, reviewer: item.author.trim().slice(0, 300) || 'External reviewer', comment: item.text,
    feedbackId: snapshot.id, feedbackHash: snapshotHash, itemId: item.id, kind: item.kind, location: item.mapping.location});
}

function mapFeedbackQuote(item: ParsedFeedbackItem, claims: ResearchClaim[]): ResearchFeedbackItem['mapping'] {
  if (!item.quote.trim()) return {status: 'unmatched', location: null};
  const matches = [];
  for (const claim of claims) {
    for (let start = claim.content.indexOf(item.quote); start >= 0; start = claim.content.indexOf(item.quote, start + 1)) {
      matches.push({claimId: claim.id, claimHash: relationClaimHash(claim), start, end: start + item.quote.length, text: item.quote});
      if (matches.length > 1) return {status: 'ambiguous', location: null};
    }
  }
  return matches.length === 1 ? {status: 'exact', location: matches[0]} : {status: 'unmatched', location: null};
}
