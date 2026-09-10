import type { Database } from 'better-sqlite3';
import { researchReviewCycleSchema } from '../../../shared/schemas/research-runs';
import type { ResearchReviewCycle, ResearchStageState } from '../../../shared/types';
import type { ResearchRepository } from './repository';

export const researchReviewRoles = [
  { role: 'methods-reviewer', focus: '独立检查研究设计、统计方法、实验对照、数据泄漏和可复现性。' },
  { role: 'evidence-reviewer', focus: '独立检查主张与证据是否匹配、引用定位、反证和过度推断。' },
  { role: 'writing-reviewer', focus: '独立检查问题、方法和结论的逻辑、结构、图文一致性和表达。' }
] as const;

export class ResearchReviewRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  get(projectId: string): ResearchReviewCycle | null {
    this.research.getProject(projectId);
    const row = this.db.prepare(`SELECT project_id AS projectId, origin_artifact_id AS originArtifactId,
      manuscript_artifact_id AS manuscriptArtifactId, revision_round AS revisionRound, status,
      report_artifact_ids_json, updated_at AS updatedAt FROM research_review_cycles WHERE project_id = ?`)
      .get(projectId) as { report_artifact_ids_json: string } | undefined;
    if (row === undefined) return null;
    const { report_artifact_ids_json, ...fields } = row;
    return researchReviewCycleSchema.parse({ ...fields, reportArtifactIds: JSON.parse(report_artifact_ids_json) });
  }

  requireForStage(projectId: string, stage: ResearchStageState['stage']): ResearchReviewCycle | null {
    if (stage !== 'review' && stage !== 'revision' && stage !== 'export') return null;
    const cycle = this.get(projectId);
    if (cycle === null) throw new Error('research_approved_manuscript_required');
    this.research.evidence.exportBundle({ projectId, artifactId: cycle.manuscriptArtifactId });
    if (stage === 'revision') {
      if (cycle.status !== 'revision_required') throw new Error('research_revision_not_requested');
      if (cycle.revisionRound >= 2) throw new Error('research_revision_limit_reached');
    }
    if (stage === 'export' && cycle.status !== 'accepted') throw new Error('research_review_acceptance_required');
    return cycle;
  }

  afterApproval(projectId: string, stage: ResearchStageState['stage'], artifactIds: string[], decision?: 'accept' | 'revise'): ResearchStageState['stage'] | null {
    if (stage === 'writing') {
      const artifactId = this.latestManuscript(projectId, artifactIds);
      this.db.prepare(`INSERT INTO research_review_cycles (project_id, origin_artifact_id, manuscript_artifact_id, revision_round, status, report_artifact_ids_json, updated_at)
        VALUES (?, ?, ?, 0, 'reviewing', '[]', ?) ON CONFLICT(project_id) DO UPDATE SET
        origin_artifact_id = excluded.origin_artifact_id, manuscript_artifact_id = excluded.manuscript_artifact_id,
        revision_round = 0, status = 'reviewing', report_artifact_ids_json = '[]', updated_at = excluded.updated_at`)
        .run(projectId, artifactId, artifactId, this.now());
      return 'review';
    }
    if (stage === 'review') {
      const cycle = this.requireForStage(projectId, stage);
      if (cycle === null) throw new Error('research_review_cycle_missing');
      if (decision === undefined) throw new Error('research_review_decision_required');
      this.research.runs.requireReviewPanel(projectId, artifactIds);
      if (decision === 'revise' && cycle.revisionRound >= 2) throw new Error('research_revision_limit_reached');
      this.db.prepare('UPDATE research_review_cycles SET status = ?, report_artifact_ids_json = ?, updated_at = ? WHERE project_id = ?')
        .run(decision === 'accept' ? 'accepted' : 'revision_required', JSON.stringify(artifactIds), this.now(), projectId);
      return decision === 'accept' ? 'export' : 'revision';
    }
    if (stage === 'revision') {
      const cycle = this.requireForStage(projectId, stage);
      if (cycle === null) throw new Error('research_review_cycle_missing');
      const artifactId = this.latestManuscript(projectId, artifactIds);
      this.db.prepare("UPDATE research_review_cycles SET manuscript_artifact_id = ?, revision_round = ?, status = 'reviewing', updated_at = ? WHERE project_id = ?")
        .run(artifactId, cycle.revisionRound + 1, this.now(), projectId);
      return 'review';
    }
    if (stage === 'export') this.requireForStage(projectId, stage);
    return null;
  }

  private latestManuscript(projectId: string, artifactIds: string[]): string {
    const id = artifactIds.filter((artifactId) => this.research.getArtifact(artifactId).kind === 'manuscript').at(-1);
    if (id === undefined) throw new Error('research_manuscript_required');
    this.research.evidence.exportBundle({ projectId, artifactId: id });
    return id;
  }
}
