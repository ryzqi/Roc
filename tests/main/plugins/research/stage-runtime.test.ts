import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import type { ResearchRoleExecution } from '../../../../src/main/plugins/research/role-executor';
import { ResearchStageRuntime } from '../../../../src/main/plugins/research/stage-runtime';
import { createResearchHumanGate, type ResearchHumanGate } from '../../../../src/main/plugins/research/human-gate';
import { researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema } from '../../../../src/shared/schemas/research';
import type { ResearchModelSelection, ResearchStageOutput } from '../../../../src/shared/types';

let db: Database.Database;
let repository: ResearchRepository;
let runtime: ResearchStageRuntime | undefined;
let selections: ResearchModelSelection[];

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  runtime = undefined;
  selections = [];
});
afterEach(async () => {
  await runtime?.shutdown();
  vi.useRealTimers();
  db.close();
});

const output: ResearchStageOutput = { title: 'Search strategy', markdown: 'A bounded search strategy.', claims: [], sections: [], verdict: 'ready' };

function project() {
  return repository.createProject({ title: 'Role test', description: 'Traceable role execution.', workspacePath: `/tmp/stage-runtime.test-${crypto.randomUUID()}` });
}

function createGate(overrides: Partial<ResearchHumanGate> = {}): ResearchHumanGate {
  return { ...createResearchHumanGate({ repository }), ...overrides };
}

function createRuntime(
  execute: (input: ResearchRoleExecution) => Promise<{ output: unknown; modelVersion: string | null }>,
  gate: ResearchHumanGate = createGate()
) {
  const capabilities = new CapabilityRegistry();
  const descriptor = { name: 'research.knowledge.search', version: '1.0.0', inputSchema: researchKnowledgeSearchRequestSchema, outputSchema: researchKnowledgeSearchResultSchema };
  capabilities.declare('research', descriptor);
  capabilities.register('research', descriptor, async (input) => repository.knowledge.searchKnowledge({ request: researchKnowledgeSearchRequestSchema.parse(input), vector: null }));
  runtime = new ResearchStageRuntime(repository, capabilities, {
    prepare: async (selection) => {
      selections.push(selection);
      return { providerId: 'test-provider', modelId: 'test-model', execute };
    }
  }, gate);
  return runtime;
}

describe('research stage runtime', () => {
  it('runs a scoped role once, records model provenance and advances a low-risk stage', async () => {
    const { id } = project();
    const execute = vi.fn(async (input: ResearchRoleExecution) => {
      expect(input.run.skillIds).toEqual(['roc-research-discovery']);
      expect(input.context.skillInstructions).toContain('name: roc-research-discovery');
      expect(input.context.skillInstructions).not.toContain('name: roc-academic-writing');
      expect(input.tools.map((tool) => tool.name)).toEqual(['search_knowledge', 'list_evidence', 'read_artifact']);
      return { output, modelVersion: 'test-model-2026-09' };
    });
    const engine = createRuntime(execute);
    const request = { projectId: id, expectedStage: 'discovery' as const, instruction: 'Create a search strategy.', requestId: 'request-1' };
    const run = engine.start(request);
    expect(engine.start(request).id).toBe(run.id);
    expect(() => engine.start({ ...request, requestId: 'request-2' })).toThrow('research_stage_run_active');
    await engine.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    const completed = repository.runs.get(run.id, id);
    expect(completed).toMatchObject({ status: 'completed', providerId: 'test-provider', modelId: 'test-model', modelVersion: 'test-model-2026-09' });
    expect(completed.outputArtifactIds).toHaveLength(1);
    const artifactId = completed.outputArtifactIds[0];
    expect(repository.getArtifact(artifactId).status).toBe('approved');
    expect(repository.runs.getArtifactContent(id, artifactId)?.output).toEqual(output);
    expect(repository.listProvenance({ projectId: id, subjectId: artifactId })).toMatchObject([{ sourceType: 'model_run', sourceId: run.id }]);
    expect(repository.getWorkflow(id).currentStage).toBe('retrieval');
    expect(engine.start(request).id).toBe(run.id);
  });

  it('sends a gated parent run through the human gate into waiting_approval', async () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    const engine = createRuntime(async () => ({ output, modelVersion: null }));
    const run = engine.start({ projectId: id, expectedStage: 'retrieval', instruction: 'Collect sources.', requestId: 'retrieval-1' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, id).status).toBe('completed');
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'retrieval')?.status).toBe('waiting_approval');
    expect(repository.getWorkflow(id).currentStage).toBe('retrieval');
  });

  it('completes a successful role through the injected human gate once', async () => {
    const { id } = project();
    const complete = vi.fn(async (request) => createResearchHumanGate({ repository }).complete(request));
    const engine = createRuntime(async () => ({ output, modelVersion: null }), createGate({ complete }));
    const run = engine.start({ projectId: id, expectedStage: 'discovery', instruction: 'Search.', requestId: 'gate-once' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, id).status).toBe('completed');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ projectId: id, expectedStage: 'discovery', action: 'complete' });
  });

  it('refuses to construct without an injected human gate', () => {
    expect(() => new ResearchStageRuntime(repository, new CapabilityRegistry(), undefined, undefined as never)).toThrow('research_human_gate_required');
  });

  it('keeps runtime completion and explicit complete on the same injected gate', async () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'retrieval' });
    const gate = createResearchHumanGate({ repository });
    const complete = vi.spyOn(gate, 'complete');
    const engine = createRuntime(async () => ({ output, modelVersion: null }), gate);
    const run = engine.start({ projectId: id, expectedStage: 'retrieval', instruction: 'Collect sources.', requestId: 'shared-gate' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, id).status).toBe('completed');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ projectId: id, expectedStage: 'retrieval', action: 'complete' });
    expect(() => engine.transition({ projectId: id, expectedStage: 'retrieval', action: 'complete' })).toThrow('research_gate_required');
    expect(() => engine.transition({ projectId: id, expectedStage: 'retrieval', action: 'approve' })).toThrow('research_gate_required');
    const approved = await gate.approve({ projectId: id, expectedStage: 'retrieval', action: 'approve' });
    expect(approved.currentStage).toBe('reading');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('binds tools to project/global material and rejects foreign artifact access', async () => {
    const first = project();
    const second = project();
    for (const [documentId, projectId] of [['own', first.id], ['global', null], ['foreign', second.id]] as const) {
      repository.knowledge.upsertKnowledgeDocument({ id: documentId, projectId, sourceType: 'file', sourceId: `${documentId}.md`, title: documentId,
        content: 'evidence result', chunks: [{ content: 'evidence result', locator: 'line 1' }], embeddingConfigId: null });
    }
    const foreign = repository.createArtifact({ projectId: second.id, stage: 'discovery', kind: 'search_strategy', title: 'Private', path: null });
    const engine = createRuntime(async (input) => {
      const search = input.tools.find((tool) => tool.name === 'search_knowledge');
      const result = JSON.stringify(await search?.invoke({ query: 'evidence', limit: 10 }));
      expect(result).toContain('own:chunk:0');
      expect(result).toContain('global:chunk:0');
      expect(result).not.toContain('foreign:chunk:0');
      const read = input.tools.find((tool) => tool.name === 'read_artifact');
      await expect(read?.invoke({ artifactId: foreign.id, offset: 0, limit: 100 })).rejects.toThrow('research_artifact_not_in_run_inputs');
      return { output, modelVersion: null };
    });
    engine.start({ projectId: first.id, expectedStage: 'discovery', instruction: 'Search.', requestId: 'scoped' });
    await engine.waitForIdle();
    expect(repository.runs.list({ projectId: first.id, limit: 10 })[0].status).toBe('completed');
  });

  it('cancels promptly and discards a late model response', async () => {
    const { id } = project();
    let finish: (value: { output: unknown; modelVersion: string | null }) => void = () => {};
    const pending = new Promise<{ output: unknown; modelVersion: string | null }>((resolve) => { finish = resolve; });
    const engine = createRuntime(async () => pending);
    const run = engine.start({ projectId: id, expectedStage: 'discovery', instruction: 'Search.', requestId: 'cancel' });
    await vi.waitFor(() => expect(repository.runs.get(run.id, id).status).toBe('running'));
    expect(engine.cancel({ projectId: id, runId: run.id }).status).toBe('cancelled');
    await engine.waitForIdle();
    finish({ output, modelVersion: null });
    await Promise.resolve();
    expect(repository.listArtifacts(id)).toEqual([]);
    expect(repository.runs.get(run.id, id).status).toBe('cancelled');
    expect(repository.getWorkflow(id).projectStatus).toBe('paused');
  });

  it('rolls back ungrounded generated prose and records the failure', async () => {
    const { id } = project();
    repository.transitionWorkflow({ projectId: id, expectedStage: 'discovery', action: 'move', targetStage: 'writing' });
    const engine = createRuntime(async () => ({ output: { ...output, claims: [
      { subjectType: 'paragraph', content: 'Invented result.', status: 'supported', evidenceIds: [] }
    ], sections: [{ title: 'Results', claimIndexes: [0] }] }, modelVersion: 'rejected-output-model-v1' }));
    const run = engine.start({ projectId: id, expectedStage: 'writing', instruction: 'Write.', requestId: 'ungrounded' });
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, id)).toMatchObject({
      status: 'failed', error: 'research_claim_evidence_required', outputArtifactIds: [], modelVersion: 'rejected-output-model-v1'
    });
    expect(repository.listArtifacts(id)).toEqual([]);
    expect(repository.evidence.listClaims({ projectId: id })).toEqual([]);
    expect(repository.getWorkflow(id).stages.find((stage) => stage.stage === 'writing')?.status).toBe('failed');
  });

  it('retries with the saved instruction, skill and actual model even if policy changes', async () => {
    const { id } = project();
    let attempt = 0;
    const engine = createRuntime(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('research_test_failure');
      return { output, modelVersion: null };
    });
    const run = engine.start({ projectId: id, expectedStage: 'discovery', instruction: 'Original goal.', requestId: 'first' });
    await engine.waitForIdle();
    repository.runs.savePolicy({ projectId: id, stage: 'discovery', tier: 'fast', model: { kind: 'model', providerId: 'other', modelId: 'other' }, maxSteps: 10, timeoutMs: 2000 });
    const retry = engine.retry({ projectId: id, runId: run.id, requestId: 'retry' });
    await engine.waitForIdle();
    expect(retry).toMatchObject({ retryOfRunId: run.id, instruction: run.instruction, skillHash: run.skillHash });
    expect(selections).toEqual([{ kind: 'app_default' }, { kind: 'model', providerId: 'test-provider', modelId: 'test-model' }]);
    expect(repository.runs.get(run.id, id).status).toBe('failed');
    expect(repository.runs.get(retry.id, id).status).toBe('completed');
    expect(repository.listArtifacts(id)).toHaveLength(1);
  });

  it('recovers a persisted running role after restart without duplicating its output', async () => {
    const { id } = project();
    const interrupted = repository.runs.begin({ projectId: id, expectedStage: 'discovery', instruction: 'Resume me.', requestId: 'orphan' });
    repository.runs.markRunning(interrupted.id, id, { providerId: 'test-provider', modelId: 'test-model' });
    repository = new ResearchRepository(db);
    expect(repository.runs.recoverInterrupted()).toBe(1);
    expect(repository.runs.recoverInterrupted()).toBe(0);
    expect(repository.runs.get(interrupted.id, id).status).toBe('interrupted');
    expect(repository.getWorkflow(id).projectStatus).toBe('paused');
    const engine = createRuntime(async () => ({ output, modelVersion: null }));
    const retried = engine.retry({ projectId: id, runId: interrupted.id, requestId: 'restart-retry' });
    await engine.waitForIdle();
    expect(repository.runs.get(retried.id, id).status).toBe('completed');
    expect(repository.listArtifacts(id)).toHaveLength(1);
  });

  it('includes the retried run in request identity and rejects a start/retry collision', async () => {
    const { id } = project();
    const engine = createRuntime(async () => { throw new Error('research_test_failure'); });
    const request = { projectId: id, expectedStage: 'discovery' as const, instruction: 'Same instruction.', requestId: 'first' };
    const first = engine.start(request);
    await engine.waitForIdle();
    const second = engine.start({ ...request, requestId: 'second' });
    await engine.waitForIdle();
    expect(() => engine.retry({ projectId: id, runId: first.id, requestId: second.requestId })).toThrow('research_run_request_conflict');
    const retryRequest = { projectId: id, runId: first.id, requestId: 'retry-first' };
    const retry = engine.retry(retryRequest);
    expect(engine.retry(retryRequest).id).toBe(retry.id);
    expect(() => engine.start({ ...request, requestId: retry.requestId })).toThrow('research_run_request_conflict');
    await engine.waitForIdle();
    expect(repository.runs.list({ projectId: id, limit: 10 })).toHaveLength(3);
  });

  it('times out even when an executor ignores abort', async () => {
    vi.useFakeTimers();
    const { id } = project();
    repository.runs.savePolicy({ projectId: id, stage: 'discovery', tier: 'balanced', model: { kind: 'app_default' }, maxSteps: 10, timeoutMs: 1000 });
    const engine = createRuntime(async () => new Promise(() => {}));
    const run = engine.start({ projectId: id, expectedStage: 'discovery', instruction: 'Bounded run.', requestId: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await engine.waitForIdle();
    expect(repository.runs.get(run.id, id)).toMatchObject({ status: 'failed', error: 'research_run_timeout' });
    expect(repository.listArtifacts(id)).toEqual([]);
  });

  it('pauses an active role and shuts down without waiting for an uncooperative provider', async () => {
    const { id } = project();
    const engine = createRuntime(async () => new Promise(() => {}));
    const run = engine.start({ projectId: id, expectedStage: 'discovery', instruction: 'Pause me.', requestId: 'pause' });
    await vi.waitFor(() => expect(repository.runs.get(run.id, id).status).toBe('running'));
    expect(engine.transition({ projectId: id, expectedStage: 'discovery', action: 'pause' }).projectStatus).toBe('paused');
    await engine.shutdown();
    expect(repository.runs.get(run.id, id)).toMatchObject({ status: 'interrupted', error: 'research_run_paused' });
    expect(repository.listArtifacts(id)).toEqual([]);
  });
});
