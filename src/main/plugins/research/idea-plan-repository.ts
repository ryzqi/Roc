import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchIdeaPlanSaveSchema, researchIdeaPlanGetSchema, researchIdeaPlanHistorySchema,
  researchIdeaPlanFreezeRequestSchema, researchIdeaPlanVersionSchema, researchIdeaPlanFreezeSchema,
  type ResearchIdeaPlanSave, type ResearchIdeaPlanGet, type ResearchIdeaPlanHistory,
  type ResearchIdeaPlanFreezeRequest, type ResearchIdeaPlanInspection, type ResearchIdeaPlanHistoryResult
} from '../../../shared/schemas/research-idea-plans';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';

type Row = {
  id: string; project_id: string; artifact_id: string; version: number; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
  freeze_hash: string | null;
};
type FreezeRow = {
  version_id: string; project_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};

/** Human method plans append to the existing Canvas, without rewriting its role output. */
export class ResearchIdeaPlanRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  save(input: ResearchIdeaPlanSave): ResearchIdeaPlanInspection {
    const request = researchIdeaPlanSaveSchema.parse(input);
    const actor = requireResearchHuman('research.ideaPlans.save', request.projectId);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId, request.artifactId);
      const requestHash = researchContentHash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_idea_plan_versions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const previous = this.inspect(replay);
        if (previous.version.requestHash !== requestHash || previous.version.actor.id !== actor.id) {
          throw new Error('research_idea_plan_request_conflict');
        }
        return previous;
      }
      const canvas = this.research.ideas.get(request.artifactId);
      if (canvas === null || canvas.version !== request.canvas.version || canvas.contentHash !== request.canvas.contentHash) {
        throw new Error('research_idea_plan_canvas_changed');
      }
      this.research.ideas.assertPublishable(this.research.getArtifact(request.artifactId));
      if (request.body.hypothesis !== canvas.hypothesis) throw new Error('research_idea_plan_hypothesis_mismatch');
      this.validateEvidence(request);
      const latest = this.latest(request.artifactId);
      if (latest === undefined ? request.parent !== null :
        request.parent?.versionId !== latest.id || request.parent.versionHash !== latest.snapshot_hash) {
        throw new Error('research_idea_plan_version_conflict');
      }
      if (latest !== undefined) {
        const previous = this.inspect(latest);
        if (previous.version.request.body.observation.kind === 'after_data' && request.body.observation.kind === 'before_data') {
          throw new Error('research_idea_plan_observation_conflict');
        }
      }
      const version = researchIdeaPlanVersionSchema.parse({
        schemaVersion: 1, id: `idea_plan_${randomUUID()}`, version: latest === undefined ? 1 : latest.version + 1,
        request, requestHash, actor, recordedAt: this.now()
      });
      const json = JSON.stringify(version);
      this.db.prepare(`INSERT INTO research_idea_plan_versions
        (id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(version.id, request.projectId, request.artifactId, version.version, request.requestId, json,
          researchContentHash(json), version.recordedAt);
      return this.get({projectId: request.projectId, artifactId: request.artifactId, versionId: version.id,
        expectedHash: researchContentHash(json)});
    })();
  }

  freeze(input: ResearchIdeaPlanFreezeRequest): ResearchIdeaPlanInspection {
    const request = researchIdeaPlanFreezeRequestSchema.parse(input);
    const reference = {projectId: request.projectId, artifactId: request.artifactId,
      versionId: request.versionId, expectedHash: request.expectedHash};
    const actor = requireResearchHuman('research.ideaPlans.freeze', request.projectId);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId, request.artifactId);
      const requestHash = researchContentHash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_idea_plan_freezes WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as FreezeRow | undefined;
      if (replay !== undefined) {
        const priorRow = this.row(replay.version_id);
        const previous = this.get({projectId: request.projectId, artifactId: request.artifactId,
          versionId: priorRow.id, expectedHash: priorRow.snapshot_hash});
        if (previous.freeze?.requestHash !== requestHash || previous.freeze.actor.id !== actor.id) {
          throw new Error('research_idea_plan_request_conflict');
        }
        return previous;
      }
      const selected = this.get(reference);
      if (!selected.isLatest) throw new Error('research_idea_plan_version_conflict');
      if (!selected.canvasCurrent) throw new Error('research_idea_plan_canvas_changed');
      if (selected.freeze !== null) throw new Error('research_idea_plan_already_frozen');
      this.research.ideas.assertPublishable(this.research.getArtifact(request.artifactId));
      this.validateEvidence(selected.version.request);
      const freeze = researchIdeaPlanFreezeSchema.parse({request, requestHash, actor, frozenAt: this.now()});
      const json = JSON.stringify(freeze);
      this.db.prepare(`INSERT INTO research_idea_plan_freezes
        (version_id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?)`)
        .run(request.versionId, request.projectId, request.requestId, json, researchContentHash(json), freeze.frozenAt);
      this.db.prepare('UPDATE research_idea_plan_versions SET freeze_hash=? WHERE id=?')
        .run(researchContentHash(json), request.versionId);
      return this.get(reference);
    })();
  }

  get(input: ResearchIdeaPlanGet): ResearchIdeaPlanInspection {
    const request = researchIdeaPlanGetSchema.parse(input);
    this.requireCanvas(request.projectId, request.artifactId);
    const row = this.row(request.versionId);
    if (row.project_id !== request.projectId || row.artifact_id !== request.artifactId) {
      throw new Error('research_idea_plan_project_mismatch');
    }
    const selected = this.inspect(row);
    if (selected.versionHash !== request.expectedHash) throw new Error('research_idea_plan_version_conflict');
    return selected;
  }

  history(input: ResearchIdeaPlanHistory): ResearchIdeaPlanHistoryResult {
    const request = researchIdeaPlanHistorySchema.parse(input);
    this.requireCanvas(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_idea_plan_versions WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_idea_plan_versions WHERE artifact_id=?')
      .pluck().get(request.artifactId) as number;
    return {items: rows.map(row => this.inspect(row)), total};
  }

  private requireCanvas(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_idea_plan_project_mismatch');
    if (artifact.kind !== 'idea_canvas') throw new Error('research_idea_canvas_artifact_required');
    if (this.research.ideas.get(artifactId) === null) throw new Error('research_idea_canvas_required');
  }

  private requireWritable(projectId: string, artifactId: string): void {
    this.requireCanvas(projectId, artifactId);
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
    if (this.research.getArtifact(artifactId).status === 'superseded') throw new Error('research_idea_plan_canvas_changed');
  }

  private validateEvidence(request: ResearchIdeaPlanSave): void {
    const {observation, novelty, sampleSize} = request.body;
    const ids = [...novelty.comparisons.map(item => item.evidenceId),
      ...(observation.kind === 'after_data' ? observation.evidenceIds : []),
      ...(sampleSize.kind === 'calculated' ? sampleSize.evidenceIds : [])];
    for (const evidenceId of new Set(ids)) this.research.evidence.getEvidence(evidenceId, request.projectId);
  }

  private latest(artifactId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM research_idea_plan_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(artifactId) as Row | undefined;
  }

  private row(versionId: string): Row {
    const row = this.db.prepare('SELECT * FROM research_idea_plan_versions WHERE id=?').get(versionId) as Row | undefined;
    if (row === undefined) throw new Error('research_idea_plan_not_found');
    return row;
  }

  private inspect(row: Row): ResearchIdeaPlanInspection {
    const version = this.readVersion(row);
    const parentRef = version.request.parent;
    if (parentRef !== null) {
      const parent = this.row(parentRef.versionId);
      this.readVersion(parent);
      if (parent.snapshot_hash !== parentRef.versionHash || parent.artifact_id !== row.artifact_id ||
        parent.project_id !== row.project_id || parent.version !== row.version - 1) {
        throw new Error('research_idea_plan_snapshot_invalid');
      }
    } else if (row.version !== 1) throw new Error('research_idea_plan_snapshot_invalid');
    const receipt = this.db.prepare('SELECT * FROM research_idea_plan_freezes WHERE version_id=?').get(row.id) as FreezeRow | undefined;
    if ((receipt === undefined) !== (row.freeze_hash === null) ||
      (receipt !== undefined && receipt.snapshot_hash !== row.freeze_hash)) throw new Error('research_idea_plan_snapshot_invalid');
    let freeze: ResearchIdeaPlanInspection['freeze'] = null;
    if (receipt !== undefined) {
      freeze = researchIdeaPlanFreezeSchema.parse(JSON.parse(receipt.snapshot_json));
      if (researchContentHash(receipt.snapshot_json) !== receipt.snapshot_hash || JSON.stringify(freeze) !== receipt.snapshot_json ||
        freeze.request.versionId !== row.id || freeze.request.projectId !== row.project_id ||
        freeze.request.artifactId !== row.artifact_id || freeze.request.expectedHash !== row.snapshot_hash ||
        freeze.request.requestId !== receipt.request_id || receipt.project_id !== row.project_id ||
        freeze.requestHash !== researchContentHash(JSON.stringify(freeze.request)) || freeze.frozenAt !== receipt.created_at) {
        throw new Error('research_idea_plan_snapshot_invalid');
      }
    }
    const canvas = this.research.ideas.get(row.artifact_id);
    return {
      version, versionHash: row.snapshot_hash, freeze, freezeHash: receipt === undefined ? null : receipt.snapshot_hash,
      isLatest: this.latest(row.artifact_id)?.id === row.id,
      canvasCurrent: canvas !== null && canvas.version === version.request.canvas.version &&
        canvas.contentHash === version.request.canvas.contentHash
    };
  }

  private readVersion(row: Row): ResearchIdeaPlanInspection['version'] {
    const version = researchIdeaPlanVersionSchema.parse(JSON.parse(row.snapshot_json));
    if (researchContentHash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(version) !== row.snapshot_json ||
      version.id !== row.id || version.version !== row.version || version.request.projectId !== row.project_id ||
      version.request.artifactId !== row.artifact_id || version.request.requestId !== row.request_id ||
      version.recordedAt !== row.created_at || version.requestHash !== researchContentHash(JSON.stringify(version.request))) {
      throw new Error('research_idea_plan_snapshot_invalid');
    }
    return version;
  }
}
