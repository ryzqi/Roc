import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-11-04T00:00:00.000Z';

function bridge(f) {
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchEvidenceCapabilities) registry.declare('research', descriptor);
  api.registerResearchEvidenceCapabilities({pluginId: 'research', capabilities: registry}, f.repository.evidence);
  f.registry = registry;
  f.adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  return f;
}
function document(f, id, {libraryItemId = null, text = 'Original synthetic scientific text.'} = {}) {
  const imported = f.repository.documents.import({id, libraryItemId, projectId: f.project.id,
    filename: `${id}.pdf`, mediaType: 'pdf', sourcePath: `documents/${id}.pdf`, sourceHash: hash(id), size: id.length,
    entry: libraryItemId !== null ? null : {metadata: {id: `${id}-literature`, source: 'local', externalId: id, doi: null,
      title: 'Shared attachment parent', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null,
      url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp},
      bibliography: {citationKey: id, entryType: 'article', fields: {title: 'Shared attachment parent'}, preambles: [], csl: null,
        title: 'Shared attachment parent', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
  const parseId = `${id}-parse`;
  f.repository.documents.begin(id, parseId);
  f.repository.documents.complete(id, parseId, {outputPath: `/tmp/synthetic-${id}-parse`, files: {}, content: {
    contractVersion: 4, engine: 'paddleocr.js', engineVersion: 'synthetic-replacement-test', parserVersion: 'roc-research-parser/2',
    parserFingerprint: hash('synthetic replacement parser'), modelManifest: '', runtime: {node: 'synthetic'}, tier: 'compact',
    parseMode: 'native-text', device: 'cpu', sourceHash: imported.sourceHash, pageCount: 2, content: text,
    blocks: [{id: `${id}-block`, kind: 'paragraph', label: 'Synthetic paragraph', text, locator: 'page:2', imageAssetId: null,
      locations: [{page: 2, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]}], assets: [],
    artifacts: {middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json'}, warnings: []
  }});
  return {document: imported, evidence: f.repository.evidence.capture({projectId: f.project.id, chunkId: `document:${parseId}:chunk:0`})};
}
function scientificClaim(f, evidence) {
  f.artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes', title: 'Original claim', path: null});
  f.claim = f.repository.evidence.createClaim({projectId: f.project.id, artifactId: f.artifact.id,
    subjectType: 'claim', content: 'An originally reviewed synthetic claim.', status: 'supported', evidenceIds: [evidence.id]});
  const proposal = f.repository.evidence.relations.propose({projectId: f.project.id, claimId: f.claim.id,
    expectedClaimVersion: f.claim.version, evidenceId: evidence.id,
    expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(evidence.id, f.project.id)),
    kind: 'supports', condition: null, supersedesRelationId: null}, {kind: 'user', id: 'synthetic-before-replacement'});
  f.review = f.repository.evidence.relations.review({projectId: f.project.id, relationId: proposal.id,
    expectedVersion: proposal.version, expectedClaimVersion: f.claim.version, expectedSourceDigest: proposal.sourceDigest,
    decision: 'confirm', note: null}, {kind: 'user', id: 'synthetic-before-replacement'});
}
function scene() {
  const f = bridge(createResearchFixture(api, 'reading'));
  f.old = document(f, 'replacement-old');
  scientificClaim(f, f.old.evidence);
  f.target = document(f, 'replacement-new', {libraryItemId: f.old.document.libraryItemId, text: 'A changed scientific statement.'});
  f.source = f.repository.evidence.inspectEvidence(f.old.evidence.id, f.project.id);
  f.targetSource = f.repository.evidence.inspectEvidence(f.target.evidence.id, f.project.id);
  f.request = {projectId: f.project.id, requestId: 'explicit-document-replacement', kind: 'document_replacement',
    evidenceId: f.old.evidence.id, targetEvidenceId: f.target.evidence.id,
    expectedSourceDigest: api.relationSourceDigest(f.source), expectedTargetDigest: api.relationSourceDigest(f.targetSource),
    note: 'Explicitly selected this separate attachment; scientific content needs a new review.'};
  return f;
}

test('a same-parent attachment is independent until a trusted explicit source selection invalidates the old review', async () => {
  const f = scene();
  try {
    assert.equal(f.old.document.libraryItemId, f.target.document.libraryItemId);
    assert.equal(f.source.referenceStatus, 'recorded');
    assert.equal(f.repository.evidence.relations.get(f.review.id, f.project.id).status, 'confirmed');
    const other = f.repository.createProject({title: 'Other reference to shared document', description: '', workspacePath: '/tmp/shared-source-other'});
    const foreign = f.repository.evidence.capture({projectId: other.id, chunkId: f.old.evidence.chunkId});
    const before = f.changes();
    assert.deepEqual((await f.adapter.invoke('research.listSourceReplacements', [{projectId: f.project.id, evidenceId: f.old.evidence.id}], 31)).data, []);
    assert.equal(f.changes(), before);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:source-replacements-replace', [f.request]), [f.request]);
    const result = await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31);
    assert.equal(result.ok, true, JSON.stringify(result));
    const record = result.data;
    assert.deepEqual(record.actor, {kind: 'user', id: 'window:31'});
    assert.deepEqual(record.source, f.source);
    assert.deepEqual(record.target, f.targetSource);
    assert.equal(record.supersededSource.referenceStatus, 'superseded');
    assert.deepEqual(record.supersededSource.evidence, f.source.evidence);
    assert.deepEqual(record.supersededSource.sourceLocator, f.source.sourceLocator);
    assert.equal(record.scientificReviewAtSelection, 'needs_review');
    assert.equal(record.experimentLineage, null);
    assert.equal(f.repository.evidence.inspectEvidence(foreign.id, other.id).referenceStatus, 'recorded');
    assert.deepEqual(f.repository.evidence.getClaim(f.claim.id), f.claim);
    assert.deepEqual(f.repository.evidence.claimHistory(f.claim.id), [f.claim]);
    const history = f.repository.evidence.relations.history(f.review.id, f.project.id);
    assert.deepEqual(history[1].relation, f.review);
    assert.equal(history.at(-1).relation.status, 'invalidated');
    assert.throws(() => f.repository.evidence.assertReviewedSupport(f.claim), /research_evidence_reference_superseded/u);
    const after = f.changes();
    const replay = await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31);
    assert.deepEqual(replay.data, record);
    const read = (await f.adapter.invoke('research.getSourceReplacement', [{projectId: f.project.id, replacementId: record.id}], 31)).data;
    assert.deepEqual(read.replacement, record);
    assert.equal(read.replacementHash, hash(JSON.stringify(record)));
    assert.equal(read.targetReferenceStatus, 'recorded');
    assert.equal(f.changes(), after);
  } finally {f.close();}
});

test('direct calls and forged identities have no replacement authority; stale endpoints and request conflicts have no writes', async () => {
  const f = scene();
  try {
    const before = f.changes();
    await assert.rejects(f.registry.invoke('research.sourceReplacements.replace', f.request),
      error => error.code === 'research_human_required' && error.category === 'permission');
    for (const key of ['actor', 'source', 'target', 'experimentLineage', 'windowId']) {
      const forged = {...f.request, [key]: {kind: 'user', id: 'forged'}};
      assert.throws(() => api.parseIpcRequestArgs('roc:research:source-replacements-replace', [forged]));
      assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [forged], 31)).ok, false);
    }
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [f.request])).error.code, 'research_sender_required');
    await assert.rejects(api.withResearchHumanContext({capability: 'research.sourceMigrations.capture', projectId: f.project.id, windowId: 31},
      () => f.registry.invoke('research.sourceReplacements.replace', f.request)), error => error.code === 'research_human_required');
    for (const [override, code] of [
      [{expectedSourceDigest: 'a'.repeat(64)}, 'research_source_replacement_source_changed'],
      [{expectedTargetDigest: 'a'.repeat(64)}, 'research_source_replacement_target_changed'],
      [{targetEvidenceId: f.old.evidence.id, expectedTargetDigest: f.request.expectedSourceDigest}, 'research_source_replacement_same_source'],
      [{kind: 'experiment_rerun'}, 'research_source_replacement_executions_required'],
      [{targetEvidenceId: 'missing'}, 'research_evidence_not_found']
    ]) assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [{...f.request, ...override}], 31)).error.code, code);
    assert.equal(f.changes(), before);
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).ok, true);
    const after = f.changes();
    for (const [request, window] of [[f.request, 42], [{...f.request, note: 'Changed'}, 31], [{...f.request, kind: 'experiment_rerun'}, 31]]) {
      assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [request], window)).error.code, 'research_source_replacement_request_conflict');
    }
    const refreshed = {...f.request, requestId: 'another-request',
      expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.old.evidence.id, f.project.id))};
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [refreshed], 31)).error.code, 'research_source_replacement_already_linked');
    assert.equal(f.changes(), after);
  } finally {f.close();}
});

test('foreign target evidence, obsolete document parse and altered current chunk cannot replace a source', async () => {
  const f = scene();
  try {
    const other = f.repository.createProject({title: 'Foreign endpoint', description: '', workspacePath: '/tmp/replacement-other'});
    const foreign = f.repository.evidence.capture({projectId: other.id, chunkId: f.target.evidence.chunkId});
    const before = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [{...f.request, targetEvidenceId: foreign.id}], 31)).error.code,
      'research_evidence_project_mismatch');
    assert.equal(f.changes(), before);
    f.db.prepare('UPDATE research_documents SET source_hash=? WHERE id=?').run(hash('changed actual source'), f.target.document.id);
    const changed = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).error.code, 'research_source_replacement_target_changed');
    assert.equal(f.changes(), changed);
    f.db.prepare('UPDATE research_documents SET source_hash=? WHERE id=?').run(f.target.document.sourceHash, f.target.document.id);
    f.db.prepare('UPDATE research_knowledge_chunks SET content=? WHERE id=?').run('Forged block', f.target.evidence.chunkId);
    const chunk = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).error.code, 'research_source_replacement_target_changed');
    assert.equal(f.changes(), chunk);
    assert.equal(f.repository.evidence.inspectEvidence(f.old.evidence.id, f.project.id).referenceStatus, 'recorded');
  } finally {f.close();}
});

test('replacement-insert failure rolls back old reference and full human review history with no new source or claim writes', async () => {
  const f = scene();
  try {
    const tables = ['research_evidence', 'research_evidence_source_locators', 'research_claims', 'research_claim_revisions',
      'research_evidence_relations', 'research_evidence_relation_revisions', 'research_provenance'];
    const original = tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    f.db.exec(`CREATE TRIGGER reject_source_replacement BEFORE INSERT ON research_source_replacements
      BEGIN SELECT RAISE(ABORT,'synthetic_source_replacement_insert_failed'); END`);
    await assert.rejects(api.withResearchHumanContext({capability: 'research.sourceReplacements.replace', projectId: f.project.id, windowId: 31},
      () => f.registry.invoke('research.sourceReplacements.replace', f.request)), /synthetic_source_replacement_insert_failed/u);
    for (const [index, table] of tables.entries()) assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), original[index]);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_source_replacements').pluck().get(), 0);
    assert.equal(f.repository.evidence.relations.get(f.review.id, f.project.id).status, 'confirmed');
  } finally {f.close();}
});

test('subsequent target invalidation preserves selected replacement and hash; current status, integrity and archive refusal stay explicit', async () => {
  const f = scene();
  try {
    const record = (await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).data;
    f.repository.evidence.invalidateEvidence(f.target.evidence.id, f.project.id);
    const before = f.changes();
    const read = (await f.adapter.invoke('research.getSourceReplacement', [{projectId: f.project.id, replacementId: record.id}], 31)).data;
    assert.deepEqual(read.replacement, record);
    assert.equal(read.targetReferenceStatus, 'superseded');
    assert.equal(record.target.referenceStatus, 'recorded');
    assert.deepEqual((await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).data, record);
    assert.equal(f.changes(), before);
    f.db.prepare("UPDATE research_source_replacements SET snapshot_json=json_set(snapshot_json,'$.actor.id','forged') WHERE id=?").run(record.id);
    const damaged = f.changes();
    assert.equal((await f.adapter.invoke('research.getSourceReplacement', [{projectId: f.project.id, replacementId: record.id}], 31)).error.code,
      'research_source_replacement_snapshot_invalid');
    assert.equal(f.changes(), damaged);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [f.request], 31)).error.code, 'research_project_archived');
    assert.equal(f.changes(), archived);
  } finally {f.close();}
});

function completedExperiment(f, label, requestId, text) {
  const execution = f.repository.experiments.create({projectId: f.project.id, requestId, label, engine: 'typescript',
    runtime: {kind: 'bundled-node'}, sourceVersion: 1, sourcePath: 'experiment.mts', inputPaths: ['input.csv'],
    parameters: {seed: requestId}, timeoutMs: 1000, network: 'disabled'},
  f.project.workspacePath, f.project.workspacePath, '/tmp/synthetic-rerun-storage');
  const environment = {runtime: {kind: 'bundled-node'}, executable: '/synthetic/node', prefix: '/synthetic', basePrefix: '/synthetic',
    version: 'synthetic-runtime', platform: 'synthetic', architecture: 'synthetic', toolchainHash: hash('toolchain'), metadataHash: hash('environment'),
    packages: [], lockFiles: [], hash: hash('frozen synthetic environment')};
  const input = {area: 'input', path: 'input.csv', sha256: hash(requestId), size: requestId.length};
  f.repository.experiments.start(f.project.id, execution.id, environment, [input], hash(`input:${requestId}`));
  const finished = f.repository.experiments.finish(f.project.id, execution.id, {status: 'completed',
    files: [input, {area: 'output', path: 'results.csv', sha256: hash(text), size: text.length}], exitCode: 0, error: null},
  [{id: `experiment:${execution.id}:result`, title: label, content: text, chunks: [{content: text, locator: 'output/results.csv:row:2'}],
    metadata: {path: 'results.csv', sha256: hash(text)}}]);
  const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: `experiment:${execution.id}:result:chunk:0`});
  return {execution: finished, evidence};
}

test('experiment rerun lineage requires two real completed executions and captures their full input environment output snapshots', async () => {
  const f = bridge(createResearchFixture(api, 'reading'));
  try {
    const previous = completedExperiment(f, 'Same synthetic label', 'first-seed', 'mean,2');
    scientificClaim(f, previous.evidence);
    const current = completedExperiment(f, 'Same synthetic label', 'different-seed', 'mean,3');
    const request = {projectId: f.project.id, requestId: 'explicit-rerun-lineage', kind: 'experiment_rerun',
      evidenceId: previous.evidence.id, targetEvidenceId: current.evidence.id,
      expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(previous.evidence.id, f.project.id)),
      expectedTargetDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(current.evidence.id, f.project.id)),
      note: 'Explicit predecessor selection; changed seed and output require scientific review.'};
    const before = f.changes();
    assert.equal(f.repository.evidence.inspectEvidence(previous.evidence.id, f.project.id).referenceStatus, 'recorded');
    assert.deepEqual(f.repository.evidence.sourceReplacements.list({projectId: f.project.id, evidenceId: previous.evidence.id}), []);
    assert.equal(f.changes(), before);
    const originalExecutions = f.db.prepare('SELECT * FROM research_experiment_executions ORDER BY rowid').all();
    const originalRuns = f.db.prepare('SELECT * FROM research_experiment_runs ORDER BY rowid').all();
    const result = await f.adapter.invoke('research.replaceEvidenceSource', [request], 72);
    assert.equal(result.ok, true, JSON.stringify(result));
    const lineage = result.data.experimentLineage;
    assert.deepEqual(lineage.previous, previous.execution);
    assert.deepEqual(lineage.current, current.execution);
    assert.equal(lineage.previousHash, hash(JSON.stringify(previous.execution)));
    assert.equal(lineage.currentHash, hash(JSON.stringify(current.execution)));
    assert.notEqual(lineage.previous.inputHash, lineage.current.inputHash);
    assert.notEqual(lineage.previous.files.at(-1).sha256, lineage.current.files.at(-1).sha256);
    assert.equal(result.data.scientificReviewAtSelection, 'needs_review');
    assert.deepEqual(result.data.actor, {kind: 'user', id: 'window:72'});
    assert.deepEqual(f.db.prepare('SELECT * FROM research_experiment_executions ORDER BY rowid').all(), originalExecutions);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_experiment_runs ORDER BY rowid').all(), originalRuns);
    assert.deepEqual(f.repository.evidence.getClaim(f.claim.id), f.claim);
    assert.equal(f.repository.evidence.relations.get(f.review.id, f.project.id).status, 'invalidated');
    assert.throws(() => f.repository.evidence.assertReviewedSupport(f.claim), /research_evidence_reference_superseded/u);
  } finally {f.close();}
});

test('unmanaged experiment records or noncompleted managed snapshots cannot masquerade as completed rerun lineage', async () => {
  const f = bridge(createResearchFixture(api, 'reading'));
  try {
    const previous = completedExperiment(f, 'Synthetic previous', 'previous', 'mean,2');
    const current = completedExperiment(f, 'Synthetic current', 'current', 'mean,3');
    const request = {projectId: f.project.id, requestId: 'bad-rerun', kind: 'experiment_rerun',
      evidenceId: previous.evidence.id, targetEvidenceId: current.evidence.id,
      expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(previous.evidence.id, f.project.id)),
      expectedTargetDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(current.evidence.id, f.project.id)), note: null};
    f.db.prepare("UPDATE research_experiment_executions SET status='running',snapshot_json=json_set(snapshot_json,'$.status','running') WHERE run_id=?")
      .run(current.execution.id);
    const before = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [request], 31)).error.code, 'research_source_replacement_execution_not_completed');
    assert.equal(f.changes(), before);
    f.repository.knowledge.upsertFromSource({id: 'unmanaged-similar-label', projectId: f.project.id, sourceType: 'experiment',
      sourceId: 'unmanaged', title: 'Synthetic previous', content: 'mean,3', chunks: [{content: 'mean,3', locator: 'results.csv'}], embeddingPolicy: 'none'});
    const unmanaged = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'unmanaged-similar-label:chunk:0'});
    const after = f.changes();
    assert.equal((await f.adapter.invoke('research.replaceEvidenceSource', [{...request, targetEvidenceId: unmanaged.id,
      expectedTargetDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(unmanaged.id, f.project.id))}], 31)).error.code,
    'research_source_replacement_executions_required');
    assert.equal(f.changes(), after);
    assert.equal(f.repository.evidence.inspectEvidence(previous.evidence.id, f.project.id).referenceStatus, 'recorded');
  } finally {f.close();}
});
