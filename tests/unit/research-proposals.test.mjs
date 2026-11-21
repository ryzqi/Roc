import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from './fixtures/research-idea-plan.mjs';
import {proposalChat} from './fixtures/research-proposal-origin.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function scene() {
  const f = createResearchFixture(api, 'ideation');
  const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'ideation', kind: 'idea_canvas',
    title: 'Proposal baseline', path: null});
  const canvas = f.repository.ideas.save({artifactId: artifact.id, expectedVersion: null, ...ideaCanvasContentFixture()});
  const {runId, threadId, manifest, snapshot, receipts, operation: start} = proposalChat(api, f);
  const requestBase = {projectId: f.project.id, artifactId: artifact.id,
    expectedArtifactVersion: f.repository.inspectArtifact({projectId: f.project.id, artifactId: artifact.id, expectedVersion: null}).snapshot.version,
    rationale: 'A concrete method proposal for human review', basis: [], proposal: {kind: 'idea_plan', payload: {
      artifactId: artifact.id, canvas: {version: canvas.version, contentHash: canvas.contentHash},
      parent: null, revisionReason: null, body: ideaPlanBodyFixture()
    }}};
  function operation(args = requestBase) {
    const context = start(args);
    return {context, request: {...args, requestId: context.idempotencyKey}};
  }
  const first = operation();
  const create = (request = first.request, context = first.context) =>
    api.runWithCapabilityOperationContext(context, () => f.repository.proposals.create(request));
  const human = action => api.withResearchHumanContext({projectId: f.project.id, windowId: 72, capability: 'research.proposals.reject'}, action);
  return {...f, artifact, canvas, runId, threadId, manifest, snapshot, requestBase, operation, create, human, receipts, ...first};
}

test('proposal persists actual execution attribution, replays once, and never writes a human method review', async () => {
  const f = scene();
  try {
    const saved = f.create();
    assert.equal(saved.freshness, 'current'); assert.equal(saved.status, 'pending'); assert.equal(saved.rejection, null);
    assert.equal(saved.snapshot.origin.runId, f.runId); assert.equal(saved.snapshot.origin.threadId, f.threadId);
    assert.equal(saved.snapshotHash, digest(saved.snapshot));
    assert.equal(f.db.prepare('SELECT count(*) FROM research_idea_plan_versions').pluck().get(), 0);
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(f.create(), saved);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    assert.ok(f.receipts.every(receipt => receipt.capabilityName === 'research.proposals.create'));
    assert.throws(() => f.create({...f.request, rationale: 'Changed retry'}), /research_proposal_request_conflict/u);
    assert.throws(() => f.repository.proposals.create(f.request), /research_proposal_operation_required/u);
    assert.throws(() => f.create({...f.request, origin: saved.snapshot.origin}), /Unrecognized key/u);
  } finally {await f.close();}
});

test('operation identity, lease, live run, project, revocation and manifest each gate creation', async () => {
  for (const failure of ['operation', 'attempt', 'lease', 'tool', 'terminal', 'project', 'fence', 'execution_path', 'manifest', 'scope', 'effect']) {
    const f = scene();
    try {
      const context = {...f.context};
      if (failure === 'operation') context.operationId = 'invented';
      if (failure === 'attempt') context.attemptId = 'expired';
      if (failure === 'lease') context.leaseGeneration++;
      if (failure === 'tool') context.toolName = 'other-tool';
      if (failure === 'terminal') f.agentDb.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(f.runId);
      if (failure === 'project') f.agentDb.prepare("UPDATE agent_threads SET research_project_id='other' WHERE id=?").run(f.threadId);
      if (failure === 'fence') new api.ExecutionGrantBroker(f.agentDb).revokeRun(f.runId);
      if (failure === 'execution_path') f.agentDb.prepare("UPDATE agent_tool_effects SET execution_path='subagent/reader' WHERE run_id=?").run(f.runId);
      if (['manifest', 'scope', 'effect'].includes(failure)) {
        const changed = structuredClone(f.snapshot), {manifestHash: _hash, ...body} = changed.capabilityManifest;
        body.tools = body.tools.flatMap(tool => tool.modelVisibleName !== f.context.toolName ? [tool] : failure === 'manifest' ? [] :
          [{...tool, ...(failure === 'scope' ? {executionScopes: ['subagent']} : {effectClass: 'none'})}]);
        changed.capabilityManifest = {...body, manifestHash: digest(body)};
        changed.frozenInputs.manifestHash = changed.capabilityManifest.manifestHash;
        f.agentDb.prepare('UPDATE agent_runs SET snapshot_json=? WHERE id=?').run(JSON.stringify(changed), f.runId);
      }
      assert.throws(() => f.create(f.request, context), /research_(proposal|dispatch)_/u, failure);
      assert.equal(f.db.prepare('SELECT count(*) FROM research_proposals').pluck().get(), 0);
    } finally {await f.close();}
  }
});

test('strict domain contracts reject stale baselines, wrong kinds, targets, parents and cross-project basis', async () => {
  const f = scene();
  try {
    const payload = f.request.proposal.payload;
    for (const invalid of [
      {...f.request, expectedArtifactVersion: 'f'.repeat(64)},
      {...f.request, proposal: {...f.request.proposal, payload: {...payload, artifactId: 'other'}}},
      {...f.request, proposal: {...f.request.proposal, payload: {...payload, parent: {versionId: 'invented', versionHash: 'a'.repeat(64)}, revisionReason: 'Changed'}}},
      {...f.request, proposal: {...f.request.proposal, payload: {...payload, revisionReason: 'No parent'}}}
    ]) assert.throws(() => f.create(invalid));
    const other = f.repository.createProject({title: 'Other', description: '', workspacePath: '/tmp/other-proposal-project'});
    const source = f.repository.createArtifact({projectId: other.id, stage: 'discovery', kind: 'search_strategy', title: 'Other', path: null});
    assert.throws(() => f.create({...f.request, basis: [{artifactId: source.id, expectedVersion: 'a'.repeat(64)}]}), /project_mismatch/u);
    f.db.prepare("UPDATE research_projects SET current_stage='reading' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='reading'").run(f.project.id);
    const wrongKind = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes', title: 'Wrong kind', path: null});
    const wrongRequest = {...f.request, artifactId: wrongKind.id, proposal: {...f.request.proposal, payload: {...payload, artifactId: wrongKind.id}}};
    assert.throws(() => f.create(wrongRequest), /artifact_kind_mismatch/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_proposals').pluck().get(), 0);
  } finally {await f.close();}
});

test('domain saves stale proposals instead of rebasing them; rejection requires exact human identity and hash', async () => {
  const f = scene();
  try {
    const saved = f.create();
    const reject = {projectId: f.project.id, proposalId: saved.snapshot.id, expectedHash: saved.snapshotHash, requestId: 'reject-1', reason: 'Wrong design'};
    assert.throws(() => f.repository.proposals.reject(reject), /research_human_required/u);
    assert.throws(() => f.human(() => f.repository.proposals.reject({...reject, expectedHash: 'f'.repeat(64)})), /hash_mismatch/u);
    api.withResearchHumanContext({projectId: f.project.id, windowId: 72, capability: 'research.ideaPlans.save'}, () =>
      f.repository.ideaPlans.save({...saved.snapshot.request.proposal.payload, projectId: f.project.id, requestId: 'actual-human-plan'}));
    const stale = f.repository.proposals.get({projectId: f.project.id, proposalId: saved.snapshot.id});
    assert.equal(stale.freshness, 'stale'); assert.equal(stale.status, 'pending');
    assert.ok(stale.staleReasons.some(item => item.reason === 'research_proposal_parent_changed'));
    const rejected = f.human(() => f.repository.proposals.reject(reject));
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.rejection.actor.id, 'window:72');
    assert.deepEqual(f.human(() => f.repository.proposals.reject(reject)), rejected);
    assert.throws(() => f.human(() => f.repository.proposals.reject({...reject, reason: 'Changed'})), /request_conflict/u);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_idea_plan_versions').pluck().get(), 1);
  } finally {await f.close();}
});

test('pages filter exact kind/status, archive stays read-only, and corrupted receipts fail closed', async () => {
  const f = scene();
  try {
    const first = f.create(), secondOperation = f.operation(), second = f.create(secondOperation.request, secondOperation.context);
    const request = {projectId: f.project.id, kind: 'idea_plan', artifactId: f.artifact.id, status: 'pending', offset: 0, limit: 1};
    const page = f.repository.proposals.list(request);
    assert.equal(page.total, 2); assert.equal(page.items[0].snapshot.id, second.snapshot.id);
    assert.equal(f.repository.proposals.list({...request, offset: 1}).items[0].snapshot.id, first.snapshot.id);
    assert.equal(f.repository.proposals.list({...request, kind: 'citation_review'}).total, 0);
    assert.throws(() => f.repository.proposals.get({projectId: 'missing', proposalId: first.snapshot.id}), /project_not_found/u);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.equal(f.repository.proposals.get({projectId: f.project.id, proposalId: first.snapshot.id}).freshness, 'stale');
    assert.throws(() => f.create(), /project_archived/u);
    f.db.prepare("UPDATE research_proposals SET snapshot_hash=? WHERE id=?").run('f'.repeat(64), first.snapshot.id);
    assert.throws(() => f.repository.proposals.get({projectId: f.project.id, proposalId: first.snapshot.id}), /snapshot_invalid/u);
  } finally {await f.close();}
});
