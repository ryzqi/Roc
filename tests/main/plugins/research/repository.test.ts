import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db, () => '2026-09-10T00:00:00.000Z');
  repository = new ResearchRepository(db, () => '2026-09-10T00:00:00.000Z');
});

afterEach(() => {
  db.close();
});

describe('ResearchRepository', () => {
  it('creates a project with an ordered, persisted eleven-stage workflow', () => {
    const project = repository.createProject({
      title: 'Evidence graph',
      description: 'Build a traceable evidence graph.',
      workspacePath: '/tmp/evidence-graph'
    });

    expect(project).toMatchObject({
      title: 'Evidence graph',
      status: 'active',
      currentStage: 'discovery'
    });
    const workflow = repository.getWorkflow(project.id);
    expect(workflow.stages).toHaveLength(11);
    expect(workflow.stages[0]).toMatchObject({ stage: 'discovery', status: 'ready', gateRequired: false });
    expect(workflow.stages[1]).toMatchObject({ stage: 'retrieval', status: 'locked', gateRequired: true });
  });

  it('advances discovery automatically and pauses at the first human gate', () => {
    const project = repository.createProject({
      title: 'Workflow test',
      description: 'Exercise stage transitions.',
      workspacePath: null
    });

    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'discovery' });
    let workflow = repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'discovery' });
    expect(workflow.currentStage).toBe('retrieval');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({ status: 'ready' });

    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' });
    workflow = repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'retrieval' });
    expect(workflow.currentStage).toBe('retrieval');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({
      status: 'waiting_approval',
      gateApproved: false
    });
  });

  it('requires approval before moving beyond a gated stage', () => {
    const project = repository.createProject({ title: 'Approval test', description: 'Approval.', workspacePath: null });
    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'discovery' });
    repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'discovery' });
    repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' });
    repository.transitionWorkflow({ projectId: project.id, action: 'complete', expectedStage: 'retrieval' });

    const workflow = repository.transitionWorkflow({ projectId: project.id, action: 'approve', expectedStage: 'retrieval' });
    expect(workflow.currentStage).toBe('reading');
    expect(workflow.stages.find((stage) => stage.stage === 'retrieval')).toMatchObject({
      status: 'completed',
      gateApproved: true
    });
  });

  it('rejects stale transitions so two views cannot advance different stages', () => {
    const project = repository.createProject({ title: 'Conflict test', description: 'Conflict.', workspacePath: null });

    expect(() =>
      repository.transitionWorkflow({ projectId: project.id, action: 'start', expectedStage: 'retrieval' })
    ).toThrow('research_workflow_stage_conflict:discovery');
  });
});

