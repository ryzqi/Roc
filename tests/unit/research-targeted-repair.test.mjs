import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi, unknownExperiment, withResearchTestWorker} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());

function scene() {
  const f = createResearchFixture(api, 'reading');
  f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture');
  const source = name => {
    f.repository.knowledge.upsertFromSource({id: `repair-${name}`, projectId: f.project.id, sourceType: 'file', sourceId: `${name}.txt`,
      title: `${name} observation`, content: `${name} observed`, chunks: [{content: `${name} observed`, locator: 'block:0'}], embeddingPolicy: 'none'});
    return f.repository.evidence.capture({projectId: f.project.id, chunkId: `repair-${name}:chunk:0`});
  };
  const aSource = source('a'), bSource = source('b');
  const create = (title, evidence) => {
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes', title, path: null});
    f.repository.evidence.createClaim({projectId: f.project.id, artifactId: artifact.id, subjectType: 'claim', status: 'supported',
      content: title, experiment: {...unknownExperiment}, evidenceIds: [evidence.id]});
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
    return f.repository.getArtifact(artifact.id);
  };
  const a = create('Affected reading', aSource), b = create('Independent reading', bSource);
  f.db.prepare("UPDATE research_stage_states SET status='completed' WHERE project_id=?").run(f.project.id);
  f.db.prepare("UPDATE research_projects SET current_stage='export',status='completed' WHERE id=?").run(f.project.id);
  const sourceRef = {kind: 'evidence', evidenceId: aSource.id,
    expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(aSource.id, f.project.id))};
  const inspect = () => f.repository.impact.inspect({projectId: f.project.id, source: sourceRef});
  const request = () => ({projectId: f.project.id, source: sourceRef, expectedStage: 'export', expectedReportHash: inspect().reportHash,
    requestId: 'repair-a', targetArtifactIds: [a.id], reason: 'Correct the affected reading while preserving the independent one.',
    inputs: [{stage: 'reading', artifacts: [{artifactId: b.id, expectedVersion: f.repository.inspectArtifact({projectId: f.project.id,
      artifactId: b.id, expectedVersion: null}).snapshot.version}]}]});
  const human = action => api.withResearchHumanContext({capability: 'research.impact.repair', projectId: f.project.id, windowId: 45}, action);
  return {...f, a, b, aSource, bSource, sourceRef, inspect, request, human};
}

test('repair refuses stale impact, skipped semantic dependents, selected-source inputs and forged human authority before mutating', async () => {
  const f = scene();
  try {
    const request = f.request(), original = f.repository.getWorkflow(f.project.id);
    await assert.rejects(async () => f.repository.repairs.start(request), /research_human_required/u);
    for (const failure of [
      {...request, expectedReportHash: 'f'.repeat(64)},
      {...request, source: {...request.source, expectedSourceDigest: 'f'.repeat(64)}},
      {...request, targetArtifactIds: [f.b.id]},
      {...request, inputs: [{stage: 'reading', artifacts: [{artifactId: f.a.id, expectedVersion: f.inspect().reportHash}]}]},
      {...request, inputs: [{stage: 'reading', artifacts: [{artifactId: f.b.id, expectedVersion: 'f'.repeat(64)}]}]}
    ]) assert.throws(() => f.human(() => f.repository.repairs.start(failure)));
    assert.deepEqual(f.repository.getWorkflow(f.project.id), original);
    assert.equal(f.repository.getArtifact(f.a.id).status, 'approved');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_repairs').pluck().get(), 0);
  } finally {await f.close();}
});

test('repair survives restart and a new run freezes only explicit unaffected inputs, preserving old approvals and nodes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-targeted-repair-'));
  const f = scene();
  let disk, agentDb, repository;
  try {
    const request = f.request(), savedB = f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.b.id, expectedVersion: null}).snapshot;
    const sourceRun = f.repository.runs.get(f.run.id, f.project.id);
    const saved = f.human(() => f.repository.repairs.start(request));
    assert.equal(saved.workflow.currentStage, 'reading');
    assert.deepEqual(saved.stages, ['reading']);
    assert.equal(f.repository.getArtifact(f.a.id).status, 'superseded');
    assert.deepEqual(f.repository.getArtifact(f.b.id), f.b);
    assert.deepEqual(f.human(() => f.repository.repairs.start(request)), saved);
    assert.throws(() => f.human(() => f.repository.repairs.start({...request, reason: 'Changed retry'})), /request_conflict/u);
    await f.db.backup(join(directory, 'research.sqlite'));
    await f.agentDb.backup(join(directory, 'agent.sqlite'));
    disk = new Database(join(directory, 'research.sqlite'));
    agentDb = new Database(join(directory, 'agent.sqlite'));
    api.applyResearchDatabaseSchema(disk);
    api.applyAgentDatabaseSchema(agentDb);
    const tasks = new api.ResearchTaskRepository(agentDb);
    repository = new api.ResearchRepository(disk, tasks);
    const queued = repository.runs.begin({projectId: f.project.id, expectedStage: 'reading', instruction: 'Read the corrected record.', requestId: 'repair-run'});
    assert.notEqual(queued.id, sourceRun.id);
    assert.notEqual(queued.taskId, sourceRun.taskId);
    assert.deepEqual(queued.inputArtifactIds, [f.b.id]);
    assert.deepEqual(repository.runs.getContext(queued.id).inputs.map(input => input.artifact.id), [f.b.id]);
    assert.deepEqual(repository.runs.get(sourceRun.id, f.project.id), sourceRun);
    const complete = withResearchTestWorker(api, repository, queued.id, f.project.id, id => {
      repository.runs.markRunning(id, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
      return repository.runs.complete(id, f.project.id, {title: 'Repaired reading', markdown: 'Only this reading was recomputed.',
        verdict: 'ready', sections: [], claims: [{subjectType: 'claim', content: 'Corrected observation', status: 'supported',
          experiment: {...unknownExperiment}, evidenceIds: [f.aSource.id]}]});
    });
    repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'reading', action: 'complete'});
    const replacement = complete.outputArtifactIds[0], claim = repository.evidence.listClaims({projectId: f.project.id, artifactId: replacement})[0];
    const gate = [{artifactId: replacement, version: repository.inspectArtifact({projectId: f.project.id, artifactId: replacement, expectedVersion: null}).snapshot.version}];
    assert.deepEqual(repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'reading').artifactIds, [replacement]);
    assert.throws(() => repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'reading', action: 'approve', expectedArtifactVersions: gate}),
      error => error.code === 'research_relation_review_required');
    const relation = repository.evidence.relations.forArtifact(replacement, f.project.id)[0];
    assert.equal(relation.claimId, claim.id);
    assert.equal(relation.status, 'proposed');
    repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'Explicit human review.'},
    {kind: 'user', id: 'fixture-reviewer'});
    const approved = repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'reading', action: 'approve',
      expectedArtifactVersions: [{artifactId: replacement, version: repository.inspectArtifact({projectId: f.project.id, artifactId: replacement, expectedVersion: null}).snapshot.version}]});
    assert.equal(approved.projectStatus, 'completed');
    assert.equal(repository.repairs.active(f.project.id), null);
    assert.deepEqual(repository.getArtifact(f.b.id), f.b);
    const afterB = repository.inspectArtifact({projectId: f.project.id, artifactId: f.b.id, expectedVersion: null}).snapshot;
    assert.deepEqual(afterB.claims, savedB.claims);
    assert.deepEqual(afterB.evidence, savedB.evidence);
    assert.deepEqual(repository.runs.get(sourceRun.id, f.project.id), sourceRun);
    const historical = tasks.requireExecution('stage', sourceRun.id, f.project.id).nodeBinding;
    const current = tasks.requireExecution('stage', queued.id, f.project.id).nodeBinding;
    assert.notEqual(current.nodeId, historical.nodeId);
    assert.equal(tasks.graph.get(current.nodeId, f.project.id).status, 'done');
  } finally {
    if (repository !== undefined) await Promise.all([repository.knowledgeJobs.shutdown(), repository.paperCards.shutdown(), repository.wiki.shutdown()]);
    disk?.close(); agentDb?.close();
    await f.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('a repaired upstream output becomes the exact next-stage input and a changed manuscript starts a fresh review cycle', async () => {
  const f = scene();
  try {
    const projectId = f.project.id;
    f.db.prepare("UPDATE research_projects SET current_stage='writing',status='active' WHERE id=?").run(projectId);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(projectId);
    const old = f.repository.createArtifact({projectId, stage: 'writing', kind: 'manuscript', title: 'Prior manuscript', path: null});
    const oldClaim = f.repository.evidence.createClaim({projectId, artifactId: old.id, subjectType: 'paragraph', content: 'Old observation.',
      status: 'supported', experiment: {...unknownExperiment}, evidenceIds: [f.aSource.id]});
    const historical = f.repository.manuscripts.saveManuscript({artifactId: old.id, sections: [{title: 'Results', claimIds: [oldClaim.id]}]});
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(old.id);
    f.db.prepare("UPDATE research_stage_states SET status='completed' WHERE project_id=?").run(projectId);
    f.db.prepare("UPDATE research_projects SET current_stage='export',status='completed' WHERE id=?").run(projectId);
    const report = f.inspect();
    const stages = ['reading', 'writing', 'review', 'export'];
    const request = {...f.request(), expectedReportHash: report.reportHash, targetArtifactIds: [f.a.id, old.id],
      inputs: stages.map(stage => ({stage, artifacts: f.request().inputs[0].artifacts}))};
    f.human(() => f.repository.repairs.start(request));
    const finish = (stage, requestId, output) => {
      const queued = f.repository.runs.begin({projectId, expectedStage: stage, instruction: 'Explicit targeted repair', requestId});
      const completed = withResearchTestWorker(api, f.repository, queued.id, projectId, id => {
        f.repository.runs.markRunning(id, projectId, {providerId: 'fixture', modelId: 'fixture'});
        return f.repository.runs.complete(id, projectId, output);
      });
      for (const id of completed.outputArtifactIds) for (const relation of f.repository.evidence.relations.forArtifact(id, projectId)) {
        f.repository.evidence.relations.review({projectId, relationId: relation.id, expectedVersion: relation.version,
          expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest, decision: 'confirm', note: 'New human decision.'},
        {kind: 'user', id: 'reviewer'});
      }
      f.repository.transitionWorkflow({projectId, expectedStage: stage, action: 'complete'});
      f.repository.transitionWorkflow({projectId, expectedStage: stage, action: 'approve', expectedArtifactVersions: completed.outputArtifactIds.map(artifactId =>
        ({artifactId, version: f.repository.inspectArtifact({projectId, artifactId, expectedVersion: null}).snapshot.version}))});
      return completed;
    };
    const output = {title: 'Repaired reading', markdown: 'Read corrected original.', verdict: 'ready', sections: [],
      claims: [{subjectType: 'paragraph', content: 'Corrected observation.', status: 'supported', experiment: {...unknownExperiment}, evidenceIds: [f.aSource.id]}]};
    const reading = finish('reading', 'repair-reading', output);
    assert.equal(f.repository.getWorkflow(projectId).currentStage, 'writing');
    assert.deepEqual(f.repository.repairs.selection(projectId, 'writing'), [f.b.id, ...reading.outputArtifactIds]);
    const writing = finish('writing', 'repair-writing', {...output, title: 'Repaired manuscript', sections: [{title: 'Results', claimIndexes: [0]}]});
    assert.deepEqual(writing.inputArtifactIds, [f.b.id, ...reading.outputArtifactIds]);
    assert.equal(f.repository.getWorkflow(projectId).currentStage, 'review');
    assert.equal(f.repository.reviews.get(projectId).status, 'reviewing');
    assert.equal(f.repository.reviews.get(projectId).manuscriptArtifactId, writing.outputArtifactIds[0]);
    assert.notEqual(writing.outputArtifactIds[0], old.id);
    assert.deepEqual(f.repository.manuscripts.getManuscript(old.id), historical);
    assert.equal(f.repository.getArtifact(f.b.id).status, 'approved');
    assert.equal(f.repository.getArtifact(old.id).status, 'superseded');
  } finally {await f.close();}
});

test('changed explicit basis stops a new run and an explicit manual move abandons the stored repair', async () => {
  const f = scene();
  try {
    const projectId = f.project.id;
    f.human(() => f.repository.repairs.start(f.request()));
    f.db.prepare('UPDATE research_artifacts SET title=? WHERE id=?').run('Changed independent input', f.b.id);
    assert.throws(() => f.repository.runs.begin({projectId, expectedStage: 'reading', instruction: 'Must not use changed input', requestId: 'stale-input'}),
      /research_repair_inputs_changed/u);
    assert.equal(f.repository.runs.list({projectId, limit: 20}).length, 1);
    assert.notEqual(f.repository.repairs.active(projectId), null);
    f.repository.transitionWorkflow({projectId, expectedStage: 'reading', action: 'move', targetStage: 'planning', note: 'Explicitly abandon repair and choose a new stage.'});
    assert.equal(f.repository.repairs.active(projectId), null);
    assert.equal(f.db.prepare('SELECT status FROM research_repairs').pluck().get(), 'cancelled');
    const next = f.repository.runs.begin({projectId, expectedStage: 'planning', instruction: 'New plan after explicit move', requestId: 'after-abandon'});
    assert.equal(next.stage, 'planning');
  } finally {await f.close();}
});
