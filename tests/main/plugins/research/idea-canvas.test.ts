import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDatabaseMigrations } from '../../../../src/main/infrastructure/database-migrations';
import { applyResearchDatabaseSchema, researchMigrations } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { researchIdeaCanvasSchema, researchIdeaPromotionSchema } from '../../../../src/shared/schemas/research-ideas';
import { researchProjectSchema, researchWorkflowSnapshotSchema } from '../../../../src/shared/schemas/research';
import type { ResearchIdeaCanvasSaveRequest, ResearchKnowledgeDocumentUpsertRequest, ResearchStageOutput } from '../../../../src/shared/types';
import { createResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
});
afterEach(() => db.close());

function project(language: 'zh' | 'en' = 'zh') {
  return repository.createProject({ title: 'Canvas study', description: 'Structured ideas.', workspacePath: null, language });
}

function document(projectId: string, input: Partial<ResearchKnowledgeDocumentUpsertRequest> = {}) {
  repository.knowledge.upsertKnowledgeDocument({
    id: 'paper', projectId, sourceType: 'file', sourceId: 'paper.pdf', title: 'Prior work',
    content: 'Existing method lacks a falsifiable prediction.', chunks: [{ content: 'Existing method lacks a falsifiable prediction.', locator: 'page 2' }],
    embeddingConfigId: null, ...input
  });
}

function canvasRequest(artifactId: string, evidenceId: string, overrides: Partial<ResearchIdeaCanvasSaveRequest> = {}): ResearchIdeaCanvasSaveRequest {
  const fields = [
    { key: 'problem' as const, content: 'How can evidence graphs stay inspectable?', status: 'supported' as const, evidenceIds: [evidenceId] },
    { key: 'hypothesis' as const, content: 'Structured canvases reduce ungrounded promotion.', status: 'hypothesis' as const, evidenceIds: [] },
    { key: 'novelty' as const, content: 'Promotion keeps the approved canvas version.', status: 'pending' as const, evidenceIds: [] },
    { key: 'supportingEvidence' as const, content: 'Prior work lacks a promotion record.', status: 'supported' as const, evidenceIds: [evidenceId] },
    { key: 'counterevidence' as const, content: '', status: 'pending' as const, evidenceIds: [] },
    { key: 'experiment' as const, content: 'Promote an approved canvas and inspect origin.', status: 'hypothesis' as const, evidenceIds: [] },
    { key: 'risks' as const, content: 'Stale canvases could mint duplicate projects.', status: 'pending' as const, evidenceIds: [] }
  ];
  return {
    artifactId, expectedVersion: null, problem: fields[0]!.content, hypothesis: fields[1]!.content, novelty: fields[2]!.content,
    supportingEvidence: fields[3]!.content, counterevidence: fields[4]!.content, experiment: fields[5]!.content, risks: fields[6]!.content,
    priority: 'high', rationale: 'Highest novelty with a testable promotion path.', fields, ...overrides
  };
}

function ideationArtifact(projectId: string) {
  repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'ideation' });
  repository.transitionWorkflow({ projectId, expectedStage: 'ideation', action: 'start' });
  return repository.createArtifact({ projectId, stage: 'ideation', kind: 'idea_canvas', title: 'Evidence graph idea', path: null });
}

describe('research idea canvas and project language', () => {
  it('defaults new projects to Chinese and persists an explicit English setting', () => {
    const chinese = repository.createProject({ title: '默认项目', description: '中文工作语言。', workspacePath: null });
    expect(chinese).toMatchObject({ language: 'zh', origin: null });
    const english = repository.createProject({ title: 'English project', description: 'Write in English.', workspacePath: null, language: 'en' });
    expect(english.language).toBe('en');
    expect(repository.updateProject({ id: english.id, language: 'zh' }).language).toBe('zh');
  });

  it('saves a versioned canvas, requires evidence for supported fields and refuses approval without it', () => {
    const { id } = project();
    const artifact = ideationArtifact(id);
    document(id);
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    expect(() => repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'complete' }))
      .toThrow('research_idea_canvas_required');
    expect(() => repository.ideas.save(canvasRequest(artifact.id, evidence.id, {
      fields: canvasRequest(artifact.id, evidence.id).fields.map((field) => field.key === 'problem' ? { ...field, evidenceIds: [] } : field)
    }))).toThrow('research_claim_evidence_required');
    const saved = repository.ideas.save(canvasRequest(artifact.id, evidence.id));
    expect(saved.version).toBe(1);
    const revised = repository.ideas.save({ ...canvasRequest(artifact.id, evidence.id, { expectedVersion: 1, rationale: 'Revised ranking after evidence review.' }) });
    expect(revised.version).toBe(2);
    expect(repository.ideas.history(artifact.id).map((entry) => entry.version)).toEqual([2, 1]);
    expect(() => repository.ideas.save({ ...canvasRequest(artifact.id, evidence.id, { expectedVersion: 1 }) })).toThrow('research_idea_canvas_version_conflict');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'complete' });
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'ideation')?.status).toBe('waiting_approval');
  });

  it('promotes only an approved current canvas, copies language, and is idempotent for the same version', () => {
    const { id } = project('en');
    const artifact = ideationArtifact(id);
    document(id);
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    const canvas = repository.ideas.save(canvasRequest(artifact.id, evidence.id));
    expect(() => repository.ideas.promote({ artifactId: artifact.id, expectedVersion: canvas.version })).toThrow('research_idea_canvas_approval_required');
    repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'approve' });
    const first = repository.ideas.promote({ artifactId: artifact.id, expectedVersion: canvas.version, title: 'Promoted study' });
    expect(first.project).toMatchObject({
      title: 'Promoted study', language: 'en', currentStage: 'discovery',
      origin: { projectId: id, artifactId: artifact.id, version: canvas.version }
    });
    const second = repository.ideas.promote({ artifactId: artifact.id, expectedVersion: canvas.version, title: 'Duplicate title' });
    expect(second.project.id).toBe(first.project.id);
    expect(repository.listProjects().filter((item) => item.origin?.artifactId === artifact.id)).toHaveLength(1);
  });

  it('rolls back promotion when recording the source event fails', () => {
    const { id } = project('en');
    const artifact = ideationArtifact(id);
    document(id);
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    const canvas = repository.ideas.save(canvasRequest(artifact.id, evidence.id));
    repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'complete' });
    repository.transitionWorkflow({ projectId: id, expectedStage: 'ideation', action: 'approve' });
    db.exec("CREATE TRIGGER fail_promotion BEFORE INSERT ON research_workflow_events WHEN NEW.type = 'idea_canvas_promoted' BEGIN SELECT RAISE(ABORT, 'promotion_event_failed'); END");
    expect(() => repository.ideas.promote({ artifactId: artifact.id, expectedVersion: canvas.version, title: 'Promoted study' }))
      .toThrow('promotion_event_failed');
    expect(repository.listProjects().filter((item) => item.origin?.artifactId === artifact.id)).toEqual([]);
  });

  it('rejects a partially written origin row', () => {
    const { id } = project();
    expect(() => db.prepare('UPDATE research_projects SET origin_project_id = ? WHERE id = ?').run(id, id))
      .toThrow('research_project_origin_invalid');
    expect(repository.getProject(id).origin).toBeNull();
  });

  it('fails an ideation run that omits ideaCanvas and does not open the gate', async () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'ideation' });
    const runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), {
      prepare: async () => ({ providerId: 'test-provider', modelId: 'test-model', execute: async () => ({
        output: { title: 'Incomplete idea', markdown: 'Missing canvas.', claims: [], sections: [], verdict: 'ready' },
        modelVersion: 'idea-model'
      }) })
    }, createResearchHumanGate({ repository }));
    try {
      const run = runtime.start({ projectId: id, expectedStage: 'ideation', instruction: 'Form the idea.', requestId: 'missing-canvas' });
      await runtime.waitForIdle();
      expect(repository.runs.get(run.id, id)).toMatchObject({ status: 'failed', error: 'research_idea_canvas_required', outputArtifactIds: [] });
      expect(repository.listArtifacts(id)).toEqual([]);
      expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'ideation')?.status).toBe('failed');
    } finally {
      await runtime.shutdown();
    }
  });

  it('binds a role-generated idea canvas before the ideation gate can open', async () => {
    const { id } = project();
    document(id);
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'ideation' });
    const evidence = repository.evidence.capture({ projectId: id, chunkId: 'paper:chunk:0' });
    const request = canvasRequest('unused', evidence.id);
    const output: ResearchStageOutput = {
      title: 'Evidence graph idea', markdown: 'A structured canvas.', claims: [], sections: [], verdict: 'ready',
      ideaCanvas: {
        problem: request.problem, hypothesis: request.hypothesis, novelty: request.novelty, supportingEvidence: request.supportingEvidence,
        counterevidence: request.counterevidence, experiment: request.experiment, risks: request.risks, priority: request.priority,
        rationale: request.rationale, fields: request.fields
      }
    };
    const runtime = new ResearchStageRuntime(repository, new CapabilityRegistry(), {
      prepare: async () => ({ providerId: 'test-provider', modelId: 'test-model', execute: async () => ({ output, modelVersion: 'idea-model' }) })
    }, createResearchHumanGate({ repository }));
    try {
      const run = runtime.start({ projectId: id, expectedStage: 'ideation', instruction: 'Form the idea.', requestId: 'idea-run' });
      await runtime.waitForIdle();
      const completed = repository.runs.get(run.id, id);
      expect(completed.status).toBe('completed');
      const artifactId = completed.outputArtifactIds[0];
      expect(repository.ideas.get(artifactId)).toMatchObject({ version: 1, problem: request.problem, priority: 'high' });
      expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'ideation')?.status).toBe('waiting_approval');
    } finally {
      await runtime.shutdown();
    }
  });

  it('upgrades v14 projects to Chinese without inventing an origin', () => {
    const legacy = new Database(':memory:');
    try {
      applyDatabaseMigrations(legacy, { dbName: 'plugin:@roc/plugin-research', migrations: researchMigrations.filter((item) => item.version <= 14) });
      const old = { id: 'legacy-project', title: 'Existing', description: 'Preserve me.', workspacePath: null,
        status: 'active', currentStage: 'discovery', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' };
      legacy.prepare('INSERT INTO research_projects (id, title, description, workspace_path, status, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(old.id, old.title, old.description, old.workspacePath, old.status, old.currentStage, old.createdAt, old.updatedAt);
      applyResearchDatabaseSchema(legacy);
      applyResearchDatabaseSchema(legacy);
      const upgraded = new ResearchRepository(legacy).getProject(old.id);
      expect(upgraded).toMatchObject({ ...old, language: 'zh', origin: null });
    } finally {
      legacy.close();
    }
  });
});

describe('research idea canvas IPC', () => {
  it('saves and promotes a canvas through plugin capabilities', async () => {
    const plugin = createResearchPlugin();
    const capabilities = new CapabilityRegistry();
    for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
    await plugin.initialize({
      pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
      eventBus: { publish: async () => {}, subscribe: () => () => {} },
      config: { get: () => null, set: () => {} },
      secrets: { get: () => null, set: () => {}, clear: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    });
    const adapter = createPluginCapabilityAdapter({
      invokeCapability: <TInput, TOutput>(name: string, input: TInput) => capabilities.invoke<TInput, TOutput>(name, input)
    });
    try {
      const created = await adapter.invoke('research.createProject', [{ title: 'IPC canvas', description: 'Promote through IPC.', workspacePath: null, language: 'en' }]);
      if (!created.ok) throw new Error(created.error.message);
      const project = researchProjectSchema.parse(created.data);
      expect(project.language).toBe('en');
      await adapter.invoke('research.transitionWorkflow', [{ projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'ideation' }]);
      await adapter.invoke('research.transitionWorkflow', [{ projectId: project.id, expectedStage: 'ideation', action: 'start' }]);
      const artifactResult = await adapter.invoke('research.createArtifact', [{ projectId: project.id, stage: 'ideation', kind: 'idea_canvas', title: 'IPC idea', path: null }]);
      if (!artifactResult.ok) throw new Error(artifactResult.error.message);
      const artifactId = (artifactResult.data as { id: string }).id;
      repository.knowledge.upsertKnowledgeDocument({
        id: 'ipc-paper', projectId: project.id, sourceType: 'file', sourceId: 'paper.pdf', title: 'Prior work',
        content: 'Existing method lacks a falsifiable prediction.', chunks: [{ content: 'Existing method lacks a falsifiable prediction.', locator: 'page 2' }],
        embeddingConfigId: null
      });
      const evidence = repository.evidence.capture({ projectId: project.id, chunkId: 'ipc-paper:chunk:0' });
      const saved = await adapter.invoke('research.saveIdeaCanvas', [canvasRequest(artifactId, evidence.id)]);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(researchIdeaCanvasSchema.parse(saved.data).version).toBe(1);
      await adapter.invoke('research.transitionWorkflow', [{ projectId: project.id, expectedStage: 'ideation', action: 'complete' }]);
      const approved = await adapter.invoke('research.transitionWorkflow', [{ projectId: project.id, expectedStage: 'ideation', action: 'approve' }]);
      if (!approved.ok) throw new Error(approved.error.message);
      expect(researchWorkflowSnapshotSchema.parse(approved.data).currentStage).toBe('planning');
      const promoted = await adapter.invoke('research.promoteIdeaCanvas', [{ artifactId, expectedVersion: 1 }]);
      if (!promoted.ok) throw new Error(promoted.error.message);
      expect(researchIdeaPromotionSchema.parse(promoted.data).project.origin).toEqual({ projectId: project.id, artifactId, version: 1 });
    } finally {
      await plugin.shutdown();
    }
  });
});
