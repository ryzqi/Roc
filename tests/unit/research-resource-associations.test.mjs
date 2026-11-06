import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = 'a'.repeat(64);
const timestamp = '2026-11-06T00:00:00.000Z';
async function scene(ok = true) {
  const f = createResearchFixture(api, 'experiment');
  const metadata = {id: 'association-paper', source: 'local', externalId: 'association-paper', doi: '10.1234/article',
    title: 'Synthetic article', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
  f.item = f.repository.library.import([{metadata, bibliography: {
    citationKey: 'synthetic2026', entryType: 'article', fields: {title: metadata.title}, preambles: [], csl: null,
    title: metadata.title, authors: metadata.authors, doi: metadata.doi, publishedYear: 2026, abstract: null, url: null
  }}], f.project.id).items[0];
  f.resources = new api.ResearchResourceRepository(f.db, f.repository);
  f.transport = new api.LiteratureSearchService(async () => ok ? Response.json({data: {
    id: '10.1234/resource', type: 'dois', attributes: {doi: '10.1234/resource', state: 'findable',
      types: {resourceTypeGeneral: 'Dataset'}, titles: [{title: 'Synthetic resource'}]}
  }}) : new Response(null, {status: 404}));
  f.service = new api.ResearchResourceService(f.resources, f.transport, () => timestamp);
  f.resource = await f.service.capture({projectId: f.project.id, requestId: 'capture', doi: '10.1234/resource'});
  f.associations = new api.ResearchResourceAssociationRepository(f.db, f.repository, f.resources, () => timestamp);
  f.targets = kind => f.associations.targets({projectId: f.project.id, kind, offset: 0, limit: 50});
  f.request = {projectId: f.project.id, requestId: 'link', resourceId: f.resource.id, resourceHash: f.resource.contentHash,
    target: f.targets('literature').records[0].target, rationale: 'User declares this resource relevant; no byte-use claim.'};
  f.save = request => api.withResearchHumanContext({capability: 'research.resourceAssociations.save',
    projectId: f.project.id, windowId: 71}, () => f.associations.save(request ?? f.request));
  f.read = saved => f.associations.read({projectId: f.project.id, associationId: saved.association.id});
  f.history = overrides => f.associations.history({projectId: f.project.id, resourceId: null, target: null,
    offset: 0, limit: 1, ...overrides});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}
function execution(f, completed = true) {
  const request = {projectId: f.project.id, ownerRunId: null, requestId: 'execution', engine: 'typescript',
    runtime: {kind: 'bundled-node'}, sourceVersion: 1, label: 'Synthetic managed execution',
    sourcePath: 'analysis.mts', inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled'};
  const run = f.repository.experiments.create(request, f.project.workspacePath, f.project.workspacePath, '/tmp/association-runs');
  if (!completed) return run;
  const environment = {runtime: request.runtime, executable: '/usr/bin/true', prefix: '/usr/bin', basePrefix: '/usr/bin',
    version: 'synthetic', platform: 'darwin', architecture: 'arm64', toolchainHash: hash, metadataHash: hash,
    packages: [], lockFiles: [], hash};
  f.repository.experiments.start(f.project.id, run.id, environment, [], hash);
  return f.repository.experiments.finish(f.project.id, run.id, {status: 'completed', files: [], exitCode: 0, error: null});
}
function mutateExecution(f, run, change) {
  const value = structuredClone(f.repository.experiments.get(f.project.id, run.id));
  change(value);
  f.db.prepare('UPDATE research_experiment_executions SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(value), run.id);
}

test('explicit literature association binds server-supplied identity and main actor without changing approvals', async () => {
  const f = await scene();
  try {
    const before = f.repository.getWorkflow(f.project.id), item = f.repository.library.get(f.item.id);
    const saved = f.save();
    assert.equal(saved.currentState, 'current');
    assert.equal(saved.association.verification, 'user_declared_context');
    assert.deepEqual(saved.association.actor, {kind: 'user', id: 'window:71'});
    assert.equal(saved.association.resourceTitle, 'Synthetic resource');
    assert.equal(saved.association.targetTitle, item.metadata.title);
    assert.equal(saved.association.request.target.expectedMetadataHash,
      api.resourceContentHash({id: item.id, revision: item.revision, metadata: item.metadata, bibliography: item.bibliography}));
    assert.deepEqual(f.read(saved), saved);
    assert.deepEqual(f.repository.getWorkflow(f.project.id), before);
    assert.deepEqual(f.repository.library.get(f.item.id), item);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_resource_observations').pluck().get(), 1);
  } finally {await f.dispose();}
});

test('every declared literature identity dimension must match and project membership is real', async () => {
  const f = await scene();
  try {
    for (const changes of [{expectedRevision: 2}, {expectedDoi: null}, {expectedMetadataHash: 'b'.repeat(64)}]) {
      assert.throws(() => f.save({...f.request, target: {...f.request.target, ...changes}}), /research_resource_target_changed/);
    }
    const foreign = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/foreign'});
    const other = {...f.request, projectId: foreign.id};
    assert.throws(() => api.withResearchHumanContext({capability: 'research.resourceAssociations.save',
      projectId: foreign.id, windowId: 71}, () => f.associations.save(other)));
    f.repository.library.link(f.item.id, f.project.id, false, {notify: false});
    assert.equal(f.targets('literature').total, 0);
    assert.throws(() => f.save(), /research_resource_target_unavailable/);
    assert.equal(f.history().total, 0);
  } finally {await f.dispose();}
});

test('exact requests replay without writes, conflicts refuse and history paginates and filters', async () => {
  const f = await scene();
  try {
    const first = f.save(), second = f.save({...f.request, requestId: 'second'});
    const writes = f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(f.save(), first);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), writes);
    assert.throws(() => f.save({...f.request, rationale: 'changed'}), /research_resource_association_request_conflict/);
    const page = f.history();
    assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
    assert.deepEqual(page.records, [second]);
    assert.deepEqual(f.history({offset: page.nextOffset}).records, [first]);
    assert.equal(f.history({offset: 1}).nextOffset, null);
    assert.equal(f.history({resourceId: f.resource.id, target: {kind: 'literature', id: f.item.id}}).total, 2);
    assert.equal(f.history({target: {kind: 'experiment', id: f.item.id}}).total, 0);
  } finally {await f.dispose();}
});

test('saved literature history keeps captured versions and reports changed or unavailable targets', async () => {
  const f = await scene();
  try {
    const saved = f.save();
    f.db.prepare('UPDATE research_library SET revision=revision+1 WHERE id=?').run(f.item.id);
    assert.equal(f.read(saved).currentState, 'target_changed');
    assert.deepEqual(f.read(saved).association, saved.association);
    f.repository.library.link(f.item.id, f.project.id, false, {notify: false});
    assert.equal(f.read(saved).currentState, 'target_unavailable');
    assert.equal(f.save().currentState, 'target_unavailable');
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    assert.equal(f.history().total, 1);
    assert.equal(f.save().currentState, 'target_unavailable');
    assert.throws(() => f.save({...f.request, requestId: 'new'}), /research_project_archived/);
  } finally {await f.dispose();}
});

test('completed managed experiment association binds inputs, environment and full execution; publish makes drift explicit', async () => {
  const f = await scene();
  try {
    const run = execution(f), target = f.targets('experiment').records[0].target;
    assert.deepEqual(target, {kind: 'experiment', runId: run.id, expectedInputHash: run.inputHash,
      expectedEnvironmentHash: run.environment.hash, expectedExecutionHash: api.resourceContentHash(run)});
    for (const key of ['expectedInputHash', 'expectedEnvironmentHash', 'expectedExecutionHash']) {
      assert.throws(() => f.save({...f.request, target: {...target, [key]: 'b'.repeat(64)}}), /research_resource_target_changed/);
    }
    const saved = f.save({...f.request, target});
    assert.equal(saved.currentState, 'current');
    const unchanged = f.repository.experiments.finish(f.project.id, run.id, {status: 'failed', files: [], exitCode: 1, error: 'late'});
    assert.deepEqual(unchanged, run);
    assert.equal(f.read(saved).currentState, 'current');
    const published = f.repository.experiments.publish(f.project.id, run.id);
    assert.notEqual(published.artifactId, null);
    assert.equal(f.read(saved).currentState, 'target_changed');
    assert.deepEqual(f.read(saved).association.request.target, target);
  } finally {await f.dispose();}
});

test('preparing runs and hand-recorded runs never become completed managed candidates', async () => {
  const f = await scene();
  try {
    const run = execution(f, false);
    const target = {kind: 'experiment', runId: run.id, expectedInputHash: hash,
      expectedEnvironmentHash: hash, expectedExecutionHash: hash};
    assert.equal(f.targets('experiment').total, 0);
    assert.throws(() => f.save({...f.request, target}), /research_resource_target_unavailable/);
    f.repository.experiments.record({id: 'manual', projectId: f.project.id, label: 'manual', command: 'manual',
      parameters: {}, environment: {}, status: 'completed', outputs: [], startedAt: timestamp, endedAt: timestamp});
    assert.equal(f.targets('experiment').total, 0);
    assert.throws(() => f.save({...f.request, target: {...target, runId: 'manual'}}), /research_experiment_not_found/);
  } finally {await f.dispose();}
});

test('invalid completed execution fields are errors, never unavailable fallbacks', async () => {
  for (const change of [run => run.inputHash = null, run => run.environment = null,
    run => run.exitCode = 1, run => run.error = 'failure', run => run.endedAt = null]) {
    const f = await scene();
    try {
      const run = execution(f), target = f.targets('experiment').records[0].target;
      mutateExecution(f, run, change);
      assert.throws(() => f.targets('experiment'), /research_resource_target_unavailable/);
      assert.throws(() => f.save({...f.request, target}), /research_resource_target_unavailable/);
    } finally {await f.dispose();}
  }
});

test('managed execution reads validate physical identity, project, request and status', async () => {
  for (const change of [run => run.id = 'forged', run => run.projectId = 'forged',
    run => run.request.projectId = 'forged', run => run.request.requestId = 'forged', run => run.status = 'failed']) {
    const f = await scene();
    try {
      const run = execution(f);
      mutateExecution(f, run, change);
      assert.throws(() => f.repository.experiments.get(f.project.id, run.id), /research_experiment_(snapshot_invalid|project_mismatch)/);
      assert.throws(() => f.targets('experiment'));
    } finally {await f.dispose();}
  }
});

test('human authority is scoped to capability/project and cannot be supplied by wire arguments', async () => {
  const f = await scene(), registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchResourceAssociationCapabilities) registry.declare('fixture', descriptor);
    api.registerResearchResourceAssociationCapabilities({pluginId: 'fixture', capabilities: registry}, f.associations);
    await assert.rejects(registry.invoke('research.resourceAssociations.save', f.request), {code: 'research_human_required'});
    assert.throws(() => api.withResearchHumanContext({capability: 'research.relations.review', projectId: f.project.id, windowId: 71},
      () => f.associations.save(f.request)), /research_human_required/);
    assert.throws(() => api.withResearchHumanContext({capability: 'research.resourceAssociations.save', projectId: 'other', windowId: 71},
      () => f.associations.save(f.request)), /research_human_project_mismatch/);
    for (const extra of [{actor: {kind: 'user', id: 'forged'}}, {approved: true}]) {
      assert.throws(() => api.parseIpcRequestArgs('roc:research:resource-associate', [{...f.request, ...extra}]));
    }
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    const noSender = await bridge.invoke('research.associateResource', [f.request]);
    assert.equal(noSender.ok, false); assert.equal(noSender.error.code, 'research_sender_required');
    const saved = await bridge.invoke('research.associateResource', [f.request], 72);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.data.association.actor, {kind: 'user', id: 'window:72'});
    const read = await bridge.invoke('research.getResourceAssociation', [{
      projectId: f.project.id, associationId: saved.data.association.id
    }], 72);
    assert.deepEqual(read.data, saved.data);
  } finally {await f.dispose();}
});

test('failed resource observations and wrong hashes refuse links', async () => {
  for (const ok of [true, false]) {
    const f = await scene(ok);
    try {
      assert.throws(() => f.save({...f.request, resourceHash: 'b'.repeat(64)}), /research_resource_association_source_invalid/);
      if (!ok) assert.throws(() => f.save(), /research_resource_association_source_invalid/);
      assert.equal(f.history().total, 0);
    } finally {await f.dispose();}
  }
});

test('source drift or archive caused by insertion rolls back association and source mutation', async () => {
  for (const sql of [
    'UPDATE research_library SET revision=revision+1;',
    "UPDATE research_projects SET status='archived';",
    "UPDATE research_resource_observations SET snapshot_json=json_set(snapshot_json,'$.contentHash','corrupted');"
  ]) {
    const f = await scene();
    try {
      const before = f.repository.library.get(f.item.id);
      const resourceBefore = f.resources.get(f.project.id, f.resource.id);
      f.db.exec(`CREATE TRIGGER association_drift AFTER INSERT ON research_resource_associations BEGIN ${sql} END;`);
      assert.throws(() => f.save());
      assert.equal(f.history().total, 0);
      assert.deepEqual(f.repository.library.get(f.item.id), before);
      assert.equal(f.repository.getProject(f.project.id).status, 'active');
      assert.deepEqual(f.resources.get(f.project.id, f.resource.id), resourceBefore);
    } finally {await f.dispose();}
  }
});

test('association snapshots validate hash and physical-row identity even after rehashing a forged body', async () => {
  for (const change of [value => value.id = 'forged', value => value.projectId = 'forged',
    value => value.request.requestId = 'forged', value => value.request.resourceId = 'forged',
    value => value.request.target.itemId = 'forged']) {
    const f = await scene();
    try {
      const saved = f.save(), value = structuredClone(saved.association);
      change(value);
      const {contentHash: _hash, ...body} = value;
      value.contentHash = api.resourceContentHash(body);
      f.db.prepare('UPDATE research_resource_associations SET snapshot_json=? WHERE id=?').run(JSON.stringify(value), saved.association.id);
      assert.throws(() => f.read(saved), /research_resource_association_snapshot_invalid/);
      assert.throws(() => f.history(), /research_resource_association_snapshot_invalid/);
    } finally {await f.dispose();}
  }
});

test('experiment version changes caused by insertion roll back the new association and execution mutation', async () => {
  const f = await scene();
  try {
    const run = execution(f), target = f.targets('experiment').records[0].target;
    f.db.exec(`CREATE TRIGGER association_execution_drift AFTER INSERT ON research_resource_associations BEGIN
      UPDATE research_experiment_executions SET snapshot_json=json_set(snapshot_json,'$.inputHash','${'b'.repeat(64)}');
    END;`);
    assert.throws(() => f.save({...f.request, target}), /research_resource_target_changed/);
    assert.equal(f.history().total, 0);
    assert.deepEqual(f.repository.experiments.get(f.project.id, run.id), run);
  } finally {await f.dispose();}
});

test('corrupt saved association or resource fails over IPC with degraded identity rather than unavailable', async () => {
  const f = await scene(), registry = new api.CapabilityRegistry();
  try {
    for (const descriptor of api.researchResourceAssociationCapabilities) registry.declare('fixture', descriptor);
    api.registerResearchResourceAssociationCapabilities({pluginId: 'fixture', capabilities: registry}, f.associations);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    const saved = f.save(), request = {projectId: f.project.id, associationId: saved.association.id};
    f.db.prepare('UPDATE research_resource_associations SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify({...saved.association, targetTitle: 'Forged'}), saved.association.id);
    const corruptLink = await bridge.invoke('research.getResourceAssociation', [request], 71);
    assert.equal(corruptLink.ok, false);
    assert.equal(corruptLink.error.code, 'research_resource_association_snapshot_invalid');
    assert.equal(corruptLink.error.category, 'degraded');
    f.db.prepare('UPDATE research_resource_associations SET snapshot_json=? WHERE id=?')
      .run(JSON.stringify(saved.association), saved.association.id);
    f.db.prepare("UPDATE research_resource_observations SET snapshot_json=json_set(snapshot_json,'$.endpoint','https://example.org/forged') WHERE id=?")
      .run(f.resource.id);
    const corruptResource = await bridge.invoke('research.getResourceAssociation', [request], 71);
    assert.equal(corruptResource.ok, false);
    assert.equal(corruptResource.error.code, 'research_resource_snapshot_invalid');
    assert.equal(corruptResource.error.category, 'degraded');
  } finally {await f.dispose();}
});

test('target pagination and local strict schema limits reject unbounded or incomplete requests', async () => {
  const f = await scene();
  try {
    const page = f.associations.targets({projectId: f.project.id, kind: 'literature', offset: 0, limit: 1});
    assert.equal(page.total, 1); assert.equal(page.nextOffset, null);
    for (const limit of [0, 51]) assert.throws(() => f.history({limit}));
    assert.throws(() => f.save({...f.request, rationale: ''}));
    assert.throws(() => f.save({...f.request, target: {kind: 'literature', itemId: f.item.id}}));
    assert.throws(() => f.associations.read({projectId: 'missing', associationId: 'missing'}));
  } finally {await f.dispose();}
});

test('migration54 preserves earlier ledgers and never infers resource associations', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(row => row.version <= 53)});
    const prior = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(row => row.version <= 54)});
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=53 ORDER BY version').all(), prior);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 54);
    assert.equal(db.prepare('SELECT COUNT(*) FROM research_resource_associations').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {db.close();}
});
