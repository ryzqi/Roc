import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import {
  researchProjectSchema,
  researchStageStateSchema,
  researchWorkflowSnapshotSchema
} from '../../../shared/schemas/research';
import type {
  ResearchProject,
  ResearchProjectCreateRequest,
  ResearchProjectUpdateRequest,
  ResearchStageState,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';

export const researchStages = [
  'discovery',
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
] as const;

type Clock = () => string;

const stageGateRequired = new Set<(typeof researchStages)[number]>([
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
]);

export class ResearchRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly now: Clock = () => new Date().toISOString()
  ) {}

  listProjects(): ResearchProject[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, description, workspace_path, status, current_stage, created_at, updated_at
         FROM research_projects
         ORDER BY updated_at DESC`
      )
      .all() as ResearchProjectRow[];
    return rows.map((row) => toProject(row));
  }

  getProject(id: string): ResearchProject {
    const row = this.db
      .prepare(
        `SELECT id, title, description, workspace_path, status, current_stage, created_at, updated_at
         FROM research_projects WHERE id = ?`
      )
      .get(id) as ResearchProjectRow | undefined;
    if (row === undefined) {
      throw new Error(`research_project_not_found:${id}`);
    }
    return toProject(row);
  }

  createProject(request: ResearchProjectCreateRequest): ResearchProject {
    const id = `research_${randomUUID()}`;
    const timestamp = this.now();
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_projects
           (id, title, description, workspace_path, status, current_stage, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 'discovery', ?, ?)`
        )
        .run(id, request.title, request.description, request.workspacePath, timestamp, timestamp);
      const insertStage = this.db.prepare(
        `INSERT INTO research_stage_states
         (project_id, stage, status, active_run_id, artifact_ids_json, entered_at, completed_at, gate_required, gate_approved, last_error)
         VALUES (?, ?, ?, NULL, '[]', ?, NULL, ?, 0, NULL)`
      );
      researchStages.forEach((stage, index) => {
        insertStage.run(
          id,
          stage,
          index === 0 ? 'ready' : 'locked',
          index === 0 ? timestamp : null,
          stageGateRequired.has(stage) ? 1 : 0
        );
      });
      this.appendEvent(id, 'discovery', 'project_created', '研究项目已创建。', { title: request.title }, timestamp);
    });
    insert();
    return this.getProject(id);
  }

  updateProject(request: ResearchProjectUpdateRequest): ResearchProject {
    this.getProject(request.id);
    const current = this.getProject(request.id);
    const timestamp = this.now();
    this.db
      .prepare(
        `UPDATE research_projects SET
         title = ?, description = ?, workspace_path = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        request.title ?? current.title,
        request.description ?? current.description,
        request.workspacePath === undefined ? current.workspacePath : request.workspacePath,
        request.status ?? current.status,
        timestamp,
        request.id
      );
    return this.getProject(request.id);
  }

  getWorkflow(projectId: string): ResearchWorkflowSnapshot {
    const project = this.getProject(projectId);
    const rows = this.db
      .prepare(
        `SELECT stage, status, active_run_id, artifact_ids_json, entered_at, completed_at,
                gate_required, gate_approved, last_error
         FROM research_stage_states WHERE project_id = ? ORDER BY rowid ASC`
      )
      .all(projectId) as ResearchStageStateRow[];
    const stages = rows.map((row) => toStageState(row));
    const event = this.db
      .prepare(
        `SELECT type, stage, message, created_at
         FROM research_workflow_events WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(projectId) as ResearchEventRow | undefined;
    return researchWorkflowSnapshotSchema.parse({
      projectId,
      currentStage: project.currentStage,
      projectStatus: project.status,
      stages,
      lastEvent:
        event === undefined
          ? null
          : { type: event.type, stage: event.stage, message: event.message, createdAt: event.created_at }
    });
  }

  transitionWorkflow(request: ResearchWorkflowTransitionRequest): ResearchWorkflowSnapshot {
    const project = this.getProject(request.projectId);
    if (project.currentStage !== request.expectedStage) {
      throw new Error(`research_workflow_stage_conflict:${project.currentStage}`);
    }
    const current = this.readStage(request.projectId, project.currentStage);
    const timestamp = this.now();
    const transition = this.db.transaction(() => {
      switch (request.action) {
        case 'start':
          this.requireStatus(current, ['ready'], 'research_stage_not_ready');
          this.updateStage(request.projectId, current.stage, { status: 'running', enteredAt: current.enteredAt ?? timestamp });
          this.updateProjectStatus(request.projectId, 'active', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_started', '阶段已开始。', request, timestamp);
          break;
        case 'resume':
          this.requireStatus(current, ['paused'], 'research_stage_not_paused');
          this.updateStage(request.projectId, current.stage, { status: 'running' });
          this.updateProjectStatus(request.projectId, 'active', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_resumed', '阶段已恢复。', request, timestamp);
          break;
        case 'pause':
          this.requireStatus(current, ['running'], 'research_stage_not_running');
          this.updateStage(request.projectId, current.stage, { status: 'paused' });
          this.updateProjectStatus(request.projectId, 'paused', timestamp);
          this.appendEvent(request.projectId, current.stage, 'stage_paused', request.note ?? '阶段已暂停。', request, timestamp);
          break;
        case 'complete':
          this.requireStatus(current, ['running'], 'research_stage_not_running');
          if (current.gateRequired) {
            this.updateStage(request.projectId, current.stage, { status: 'waiting_approval' });
            this.appendEvent(request.projectId, current.stage, 'approval_requested', '阶段产物等待用户审核。', request, timestamp);
          } else {
            this.completeStage(request.projectId, current.stage, timestamp);
          }
          break;
        case 'approve':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          this.updateStage(request.projectId, current.stage, { gateApproved: true });
          this.completeStage(request.projectId, current.stage, timestamp);
          break;
        case 'reject':
          this.requireStatus(current, ['waiting_approval'], 'research_stage_not_waiting_approval');
          this.updateStage(request.projectId, current.stage, { status: 'running', gateApproved: false, lastError: request.note ?? '用户要求修改。' });
          this.appendEvent(request.projectId, current.stage, 'approval_rejected', request.note ?? '用户要求修改。', request, timestamp);
          break;
      }
    });
    transition();
    return this.getWorkflow(request.projectId);
  }

  private completeStage(projectId: string, stage: ResearchStageState['stage'], timestamp: string): void {
    const index = researchStages.indexOf(stage);
    const nextStage = researchStages[index + 1];
    this.updateStage(projectId, stage, { status: 'completed', completedAt: timestamp });
    if (nextStage === undefined) {
      this.updateProjectStatus(projectId, 'completed', timestamp);
      this.appendEvent(projectId, stage, 'workflow_completed', '科研流程已完成。', {}, timestamp);
      return;
    }
    this.updateStage(projectId, nextStage, { status: 'ready', enteredAt: timestamp });
    this.db.prepare('UPDATE research_projects SET current_stage = ?, updated_at = ? WHERE id = ?').run(nextStage, timestamp, projectId);
    this.appendEvent(projectId, stage, 'stage_completed', `阶段已完成，下一阶段为 ${nextStage}。`, { nextStage }, timestamp);
  }

  private readStage(projectId: string, stage: ResearchStageState['stage']): ResearchStageState {
    const row = this.db
      .prepare(
        `SELECT stage, status, active_run_id, artifact_ids_json, entered_at, completed_at,
                gate_required, gate_approved, last_error
         FROM research_stage_states WHERE project_id = ? AND stage = ?`
      )
      .get(projectId, stage) as ResearchStageStateRow | undefined;
    if (row === undefined) {
      throw new Error(`research_stage_not_found:${stage}`);
    }
    return toStageState(row);
  }

  private updateStage(
    projectId: string,
    stage: ResearchStageState['stage'],
    update: Partial<Pick<ResearchStageState, 'status' | 'activeRunId' | 'enteredAt' | 'completedAt' | 'gateApproved' | 'lastError'>>
  ): void {
    const current = this.readStage(projectId, stage);
    this.db
      .prepare(
        `UPDATE research_stage_states SET status = ?, active_run_id = ?, entered_at = ?, completed_at = ?,
         gate_approved = ?, last_error = ? WHERE project_id = ? AND stage = ?`
      )
      .run(
        update.status ?? current.status,
        update.activeRunId === undefined ? current.activeRunId : update.activeRunId,
        update.enteredAt === undefined ? current.enteredAt : update.enteredAt,
        update.completedAt === undefined ? current.completedAt : update.completedAt,
        update.gateApproved === undefined ? (current.gateApproved ? 1 : 0) : update.gateApproved ? 1 : 0,
        update.lastError === undefined ? current.lastError : update.lastError,
        projectId,
        stage
      );
  }

  private updateProjectStatus(projectId: string, status: ResearchProject['status'], timestamp: string): void {
    this.db.prepare('UPDATE research_projects SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, projectId);
  }

  private appendEvent(projectId: string, stage: string, type: string, message: string, payload: unknown, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO research_workflow_events
         (id, project_id, stage, type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), projectId, stage, type, message, JSON.stringify(payload), createdAt);
  }

  private requireStatus(current: ResearchStageState, allowed: ResearchStageState['status'][], code: string): void {
    if (!allowed.includes(current.status)) {
      throw new Error(`${code}:${current.stage}:${current.status}`);
    }
  }
}

type ResearchProjectRow = {
  id: string;
  title: string;
  description: string;
  workspace_path: string | null;
  status: ResearchProject['status'];
  current_stage: ResearchProject['currentStage'];
  created_at: string;
  updated_at: string;
};

type ResearchStageStateRow = {
  stage: ResearchStageState['stage'];
  status: ResearchStageState['status'];
  active_run_id: string | null;
  artifact_ids_json: string;
  entered_at: string | null;
  completed_at: string | null;
  gate_required: number;
  gate_approved: number;
  last_error: string | null;
};

type ResearchEventRow = {
  type: string;
  stage: ResearchStageState['stage'];
  message: string;
  created_at: string;
};

function toProject(row: ResearchProjectRow): ResearchProject {
  return researchProjectSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    workspacePath: row.workspace_path,
    status: row.status,
    currentStage: row.current_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toStageState(row: ResearchStageStateRow): ResearchStageState {
  let artifactIds: unknown;
  try {
    artifactIds = JSON.parse(row.artifact_ids_json);
  } catch {
    throw new Error('research_stage_artifacts_invalid');
  }
  return researchStageStateSchema.parse({
    stage: row.stage,
    status: row.status,
    activeRunId: row.active_run_id,
    artifactIds,
    enteredAt: row.entered_at,
    completedAt: row.completed_at,
    gateRequired: row.gate_required === 1,
    gateApproved: row.gate_approved === 1,
    lastError: row.last_error
  });
}

