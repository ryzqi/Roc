import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import type { ResearchRoleExecution } from '../../../../src/main/plugins/research/role-executor';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import { getResearchStageRoleProfile } from '../../../../src/main/plugins/research/role-profiles';
import { getResearchSkillInstructions } from '../../../../src/main/plugins/research/research-skills';
import { researchWorkflowTransitionRequestSchema } from '../../../../src/shared/schemas/research';
import type { ResearchStageOutput } from '../../../../src/shared/types';

let db: Database.Database;
let repository: ResearchRepository;
let runtime: ResearchStageRuntime | undefined;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  runtime = undefined;
});
afterEach(async () => { await runtime?.shutdown(); db.close(); });

function readyForReview() {
  const { id } = repository.createProject({ title: 'Review study', description: 'An evidence-based manuscript.', workspacePath: null });
  repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'writing' });
  repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'start' });
  repository.upsertKnowledgeDocument({ id: `data:${id}`, projectId: id, sourceType: 'file', sourceId: 'data.csv', title: 'Measured data',
    content: 'Measured improvement: 20%.', chunks: [{ content: 'Measured improvement: 20%.', locator: 'row 2' }], embeddingConfigId: null });
  const evidence = repository.evidence.capture({ projectId: id, chunkId: `data:${id}:chunk:0` });
  const artifact = repository.createArtifact({ projectId: id, stage: 'writing', kind: 'manuscript', title: 'Original manuscript', path: null });
  const claim = repository.evidence.createClaim({ projectId: id, artifactId: artifact.id, subjectType: 'paragraph', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
  repository.evidence.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
  repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'complete' });
  repository.transitionWorkflow({ projectId: id, expectedStage: 'writing', action: 'approve' });
  return { id, evidence, artifact };
}

function report(role: string, verdict: ResearchStageOutput['verdict'] = 'ready'): ResearchStageOutput {
  return { title: role, markdown: `Independent report from ${role}.`, claims: [], sections: [], verdict };
}

function createRuntime(execute: (input: ResearchRoleExecution) => Promise<ResearchStageOutput>) {
  runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), {
    prepare: async () => ({ providerId: 'review-provider', modelId: 'review-model', execute: async (input) => ({
      output: await execute(input), modelVersion: `${input.run.role}-v1`
    }) })
  });
  return runtime;
}

describe('independent review and revision workflow', () => {
  it('runs three independent reviews concurrently before synthesis and preserves disagreements', async () => {
    const { id, artifact } = readyForReview();
    const calls: ResearchRoleExecution[] = [];
    let entered = 0;
    let release: () => void = () => {};
    const allReviewersEntered = new Promise<void>((resolve) => { release = resolve; });
    const engine = createRuntime(async (input) => {
      calls.push(input);
      if (input.run.parentRunId !== null) {
        entered += 1;
        if (entered === 3) release();
        await allReviewersEntered;
      }
      return report(input.run.role, input.run.role === 'evidence-reviewer' ? 'uncertain' : 'ready');
    });
    const parent = engine.start({ projectId: id, expectedStage: 'review', instruction: 'Review the manuscript.', requestId: 'review-1' });
    await engine.waitForIdle();
    const children = calls.filter((call) => call.run.parentRunId !== null);
    const synthesis = calls.find((call) => call.run.parentRunId === null);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.context.reviewReports).toEqual([]);
      expect(child.context.inputs.map((entry) => entry.artifact.id)).toEqual([artifact.id]);
      expect(child.tools.map((tool) => tool.name)).not.toContain('read_review_report');
    }
    expect(synthesis?.context.reviewReports).toHaveLength(3);
    expect(synthesis?.context.reviewReports.find((entry) => entry.role === 'evidence-reviewer')?.output.verdict).toBe('uncertain');
    expect(repository.runs.get(parent.id, id)).toMatchObject({ status: 'completed', reviewCycleId: artifact.id, revisionRound: 0 });
    expect(repository.runs.get(parent.id, id).outputArtifactIds).toHaveLength(4);
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'review')?.status).toBe('waiting_approval');
    const child = children[0].run;
    expect(() => engine.cancel({ projectId: id, runId: child.id })).toThrow('research_run_cancel_parent_required');
    expect(() => engine.retry({ projectId: id, runId: child.id, requestId: 'child-retry' })).toThrow('research_run_retry_parent_required');
    expect(() => engine.start({ projectId: id, expectedStage: 'review', instruction: child.instruction, requestId: child.requestId })).toThrow('research_run_request_conflict');
  });

  it('requires an explicit human decision and limits approved revisions to two rounds', async () => {
    const { id, evidence, artifact } = readyForReview();
    const observed: ResearchRoleExecution[] = [];
    const engine = createRuntime(async (input) => {
      observed.push(input);
      if (input.run.stage !== 'revision') return report(input.run.role, 'revise');
      return { title: `Revision ${input.run.revisionRound}`, markdown: 'Revised with evidence.', verdict: 'ready',
        claims: [{ subjectType: 'paragraph', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] }],
        sections: [{ title: 'Results', claimIndexes: [0] }] };
    });
    for (let round = 1; round <= 2; round += 1) {
      engine.start({ projectId: id, expectedStage: 'review', instruction: 'Review.', requestId: `review-${round}` });
      await engine.waitForIdle();
      expect(researchWorkflowTransitionRequestSchema.safeParse({ projectId: id, expectedStage: 'review', action: 'approve' }).success).toBe(false);
      expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'approve' })).toThrow('research_review_decision_required');
      repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise' });
      const revision = engine.start({ projectId: id, expectedStage: 'revision', instruction: 'Revise with a response to each issue.', requestId: `revision-${round}` });
      await engine.waitForIdle();
      expect(repository.runs.get(revision.id, id).status).toBe('completed');
      repository.transitionWorkflow({ projectId: id, expectedStage: 'revision', action: 'approve' });
      expect(repository.reviews.get(id)).toMatchObject({ revisionRound: round, status: 'reviewing' });
      expect(repository.getWorkflow(id).currentStage).toBe('review');
    }
    const latestManuscriptId = repository.reviews.get(id)?.manuscriptArtifactId;
    if (latestManuscriptId === undefined) throw new Error('test_manuscript_missing');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'move', targetStage: 'review' });
    expect(repository.getArtifact(latestManuscriptId).status).toBe('approved');
    engine.start({ projectId: id, expectedStage: 'review', instruction: 'Final review.', requestId: 'review-final' });
    await engine.waitForIdle();
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'approve', reviewDecision: 'revise' })).toThrow('research_revision_limit_reached');
    expect(repository.reviews.get(id)?.revisionRound).toBe(2);
    repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'approve', reviewDecision: 'accept' });
    expect(repository.getWorkflow(id).currentStage).toBe('export');
    expect(repository.reviews.get(id)?.status).toBe('accepted');
    expect(repository.getArtifact(artifact.id).status).toBe('approved');
    for (const input of observed.filter((entry) => entry.run.stage === 'review')) {
      expect(input.context.inputs.filter((entry) => entry.artifact.kind === 'review_report')).toEqual([]);
      expect(input.context.inputs.filter((entry) => entry.artifact.kind === 'manuscript')).toHaveLength(1);
    }
  });

  it('cancels all reviewers and retires partial output before a retry', async () => {
    const { id } = readyForReview();
    let block = true;
    const engine = createRuntime(async (input) => {
      if (block && input.run.role !== 'methods-reviewer') return new Promise(() => {});
      return report(input.run.role);
    });
    const parent = engine.start({ projectId: id, expectedStage: 'review', instruction: 'Review.', requestId: 'interrupted-review' });
    await vi.waitFor(() => expect(repository.runs.get(parent.id, id).outputArtifactIds).toHaveLength(1));
    const partialId = repository.runs.get(parent.id, id).outputArtifactIds[0];
    engine.cancel({ projectId: id, runId: parent.id });
    await engine.waitForIdle();
    expect(repository.runs.list({ projectId: id, limit: 20 }).every((run) => !['queued', 'running'].includes(run.status))).toBe(true);
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'review')?.status).toBe('paused');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'resume' });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'complete' })).toThrow('research_review_synthesis_required');
    block = false;
    const retried = engine.retry({ projectId: id, runId: parent.id, requestId: 'review-retry' });
    await engine.waitForIdle();
    expect(repository.runs.get(retried.id, id).status).toBe('completed');
    expect(repository.getArtifact(partialId).status).toBe('superseded');
    const state = repository.getWorkflow(id).stages.find((stage) => stage.stage === 'review');
    expect(state?.artifactIds).toHaveLength(4);
    expect(state?.artifactIds).not.toContain(partialId);
  });

  it('blocks review and export without an approved manuscript and a human acceptance', () => {
    const project = repository.createProject({ title: 'No manuscript', description: 'Cannot invent an input.', workspacePath: null });
    repository.transitionWorkflow({ projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'review' });
    const engine = createRuntime(async (input) => report(input.run.role));
    expect(() => engine.start({ projectId: project.id, expectedStage: 'review', instruction: 'Review.', requestId: 'missing' })).toThrow('research_approved_manuscript_required');
    const { id } = readyForReview();
    expect(() => repository.reviews.requireForStage(id, 'export')).toThrow('research_review_acceptance_required');
    expect(() => repository.reviews.requireForStage(id, 'revision')).toThrow('research_revision_not_requested');
  });

  it('revokes an old acceptance immediately when review is reopened', async () => {
    const { id } = readyForReview();
    const engine = createRuntime(async (input) => report(input.run.role));
    engine.start({ projectId: id, expectedStage: 'review', instruction: 'Review.', requestId: 'accept-first' });
    await engine.waitForIdle();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'approve', reviewDecision: 'accept' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'export', action: 'move', targetStage: 'review' });
    expect(repository.reviews.get(id)).toMatchObject({ status: 'reviewing', reportArtifactIds: [] });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'review', action: 'move', targetStage: 'export' });
    expect(() => engine.start({ projectId: id, expectedStage: 'export', instruction: 'Export.', requestId: 'stale-acceptance' }))
      .toThrow('research_review_acceptance_required');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'export', action: 'start' });
    repository.createArtifact({ projectId: id, stage: 'export', kind: 'export_package', title: 'Attempted export', path: null });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'export', action: 'complete' }))
      .toThrow('research_review_acceptance_required');
  });

  it.each(['review', 'revision'] as const)('resumes an interrupted v3 %s run against its saved manuscript', async (stage) => {
    const legacy = new Database(':memory:');
    const saved = createLegacyReviewFixture(legacy, stage);
    applyResearchDatabaseSchema(legacy);
    const upgraded = new ResearchRepository(legacy);
    const engine = new ResearchStageRuntime(upgraded, new CapabilityRegistry(), {
      prepare: async () => ({ providerId: 'review-provider', modelId: 'review-model', execute: async (input) => ({
        output: stage === 'review' ? report(input.run.role) : {
          ...report('Legacy revision'), claims: [{ subjectType: 'paragraph', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [saved.evidenceId] }],
          sections: [{ title: 'Results', claimIndexes: [0] }]
        }, modelVersion: 'resumed-model-v1'
      }) })
    });
    try {
      expect(upgraded.runs.recoverInterrupted()).toBe(1);
      const retry = engine.retry({ projectId: saved.projectId, runId: saved.runId, requestId: 'resumed' });
      expect(retry).toMatchObject({ reviewCycleId: saved.artifactId, revisionRound: stage === 'revision' ? 1 : 0, skillHash: saved.skillHash });
      await engine.waitForIdle();
      expect(upgraded.runs.get(retry.id, saved.projectId)).toMatchObject({ status: 'completed', modelVersion: 'resumed-model-v1' });
      if (stage === 'review') expect(retry.toolNames).toContain('read_review_report');
      upgraded.transitionWorkflow({ projectId: saved.projectId, expectedStage: stage, action: 'approve', ...(stage === 'review' ? { reviewDecision: 'accept' as const } : {}) });
      expect(upgraded.getWorkflow(saved.projectId).currentStage).toBe(stage === 'review' ? 'export' : 'review');
    } finally {
      await engine.shutdown();
      legacy.close();
    }
  });

  it('migrates saved 3a run snapshots and retains their restart behavior', () => {
    const legacy = new Database(':memory:');
    try {
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.slice(0, 3) });
      const oldRepository = new ResearchRepository(legacy);
      const project = oldRepository.createProject({ title: 'Existing run', description: 'Preserve the saved input.', workspacePath: null });
      const run = oldRepository.runs.begin({ projectId: project.id, expectedStage: 'discovery', instruction: 'Original input.', requestId: 'legacy-run' });
      legacy.exec("UPDATE research_stage_runs SET snapshot_json = json_remove(snapshot_json, '$.reviewCycleId', '$.revisionRound'), context_json = json_remove(context_json, '$.reviewReports')");
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy);
      expect(upgraded.runs.get(run.id, project.id)).toMatchObject({ instruction: 'Original input.', reviewCycleId: null, revisionRound: 0, skillHash: run.skillHash });
      expect(upgraded.runs.getContext(run.id).reviewReports).toEqual([]);
      expect(upgraded.runs.recoverInterrupted()).toBe(1);
      expect(upgraded.runs.get(run.id, project.id).status).toBe('interrupted');
    } finally {
      legacy.close();
    }
  });
});

function createLegacyReviewFixture(legacy: Database.Database, stage: 'review' | 'revision') {
  applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.slice(0, 3) });
  const old = new ResearchRepository(legacy);
  const project = old.createProject({ title: 'Legacy manuscript', description: 'Keep this saved input.', workspacePath: null });
  const queued = old.runs.begin({ projectId: project.id, expectedStage: 'discovery', instruction: 'Continue the saved manuscript.', requestId: `legacy-${stage}` });
  legacy.prepare("UPDATE research_stage_states SET active_run_id = NULL, status = 'completed' WHERE project_id = ? AND stage = 'discovery'").run(project.id);
  legacy.prepare("UPDATE research_projects SET current_stage = 'writing' WHERE id = ?").run(project.id);
  legacy.prepare("UPDATE research_stage_states SET status = 'running' WHERE project_id = ? AND stage = 'writing'").run(project.id);
  old.upsertKnowledgeDocument({ id: 'legacy-data', projectId: project.id, sourceType: 'file', sourceId: 'data.csv', title: 'Measured data',
    content: 'Measured improvement: 20%.', chunks: [{ content: 'Measured improvement: 20%.', locator: 'row 2' }], embeddingConfigId: null });
  const evidence = old.evidence.capture({ projectId: project.id, chunkId: 'legacy-data:chunk:0' });
  const artifact = old.createArtifact({ projectId: project.id, stage: 'writing', kind: 'manuscript', title: 'Saved manuscript', path: null });
  const claim = old.evidence.createClaim({ projectId: project.id, artifactId: artifact.id, subjectType: 'paragraph', content: 'Measured improvement: 20%.', status: 'supported', evidenceIds: [evidence.id] });
  const manuscript = old.evidence.saveManuscript({ artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] });
  legacy.prepare("UPDATE research_artifacts SET status = 'approved' WHERE id = ?").run(artifact.id);
  legacy.prepare("UPDATE research_stage_states SET status = 'completed', gate_approved = 1 WHERE project_id = ? AND stage = 'writing'").run(project.id);
  const inputs: ResearchRoleExecution['context']['inputs'] = [{ artifact: old.getArtifact(artifact.id), output: null, manuscript }];
  if (stage === 'revision') {
    legacy.prepare("INSERT INTO research_artifacts (id, project_id, stage, kind, title, path, status, created_at, updated_at) VALUES ('legacy-review', ?, 'review', 'review_report', 'Prior review', NULL, 'approved', ?, ?)")
      .run(project.id, queued.createdAt, queued.createdAt);
    legacy.prepare("UPDATE research_stage_states SET status = 'completed', gate_approved = 1, artifact_ids_json = '[\"legacy-review\"]' WHERE project_id = ? AND stage = 'review'").run(project.id);
    inputs.push({ artifact: old.getArtifact('legacy-review'), output: null, manuscript: null });
  }
  legacy.prepare('UPDATE research_projects SET current_stage = ? WHERE id = ?').run(stage, project.id);
  legacy.prepare("UPDATE research_stage_states SET status = 'running', active_run_id = ? WHERE project_id = ? AND stage = ?").run(queued.id, project.id, stage);
  const profile = getResearchStageRoleProfile(stage);
  const skillInstructions = getResearchSkillInstructions(stage);
  const skillHash = createHash('sha256').update(skillInstructions).digest('hex');
  const policy = old.runs.listPolicies(project.id).find((entry) => entry.stage === stage);
  if (policy === undefined) throw new Error('test_policy_missing');
  const snapshot = {
    ...queued, stage, role: profile.role, outputKind: profile.outputKind, policy, skillIds: profile.skillIds, skillHash,
    toolNames: ['search_knowledge', 'list_evidence', 'read_artifact', ...(stage === 'revision' ? ['capture_evidence'] : [])],
    inputArtifactIds: inputs.map((input) => input.artifact.id), status: 'running', providerId: 'review-provider', modelId: 'review-model', startedAt: queued.createdAt
  };
  const context = { project: old.getProject(project.id), skillInstructions, inputs };
  legacy.prepare("UPDATE research_stage_runs SET stage = ?, status = 'running', snapshot_json = json_remove(?, '$.reviewCycleId', '$.revisionRound'), context_json = ? WHERE id = ?")
    .run(stage, JSON.stringify(snapshot), JSON.stringify(context), queued.id);
  return { projectId: project.id, runId: queued.id, artifactId: artifact.id, evidenceId: evidence.id, skillHash };
}
