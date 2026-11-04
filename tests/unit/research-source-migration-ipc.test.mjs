import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-11-04T00:00:00.000Z';
const block = (id, page, text = 'Retained synthetic paragraph.') => ({
  id, kind: 'paragraph', label: 'Synthetic paragraph', text, locator: `page:${page}`, imageAssetId: null,
  locations: [{page, bbox: [1, 2, 30, 40], coordinateOrigin: 'TOPLEFT'}]
});

function scene({targets = [block('first', 1), block('second', 3)]} = {}) {
  const f = createResearchFixture(api, 'reading');
  f.document = f.repository.documents.import({id: 'decision-document', libraryItemId: null, projectId: f.project.id,
    filename: 'decision.pdf', mediaType: 'pdf', sourcePath: 'documents/decision.pdf', sourceHash: hash('synthetic PDF'), size: 13,
    entry: {metadata: {id: 'decision-literature', source: 'local', externalId: 'decision-fixture', doi: null,
      title: 'Decision fixture', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null,
      url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp},
      bibliography: {citationKey: 'decision2026', entryType: 'article', fields: {title: 'Decision fixture'}, preambles: [],
        csl: null, title: 'Decision fixture', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
  f.publish = (parseId, blocks = targets) => {
    f.repository.documents.begin(f.document.id, parseId);
    f.repository.documents.complete(f.document.id, parseId, {outputPath: '/tmp/synthetic-decision-output', files: {}, content: {
      contractVersion: 4, engine: 'paddleocr.js', engineVersion: 'synthetic-decision-test', parserVersion: 'roc-research-parser/2',
      parserFingerprint: hash('synthetic parser'), modelManifest: '', runtime: {node: 'synthetic'}, tier: 'compact',
      parseMode: 'native-text', device: 'cpu', sourceHash: f.document.sourceHash, pageCount: 4,
      content: blocks.map(block => block.text).join('\n\n'), blocks, assets: [],
      artifacts: {middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json'},
      warnings: []
    }}, null);
  };
  f.publish('decision-old', [block('old', 2)]);
  f.old = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:decision-old:chunk:0'});
  f.artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes', title: 'Claim', path: null});
  f.claim = f.repository.evidence.createClaim({projectId: f.project.id, artifactId: f.artifact.id,
    subjectType: 'claim', content: 'An explicitly synthetic claim.', status: 'supported', evidenceIds: [f.old.id]});
  const proposed = f.repository.evidence.relations.propose({projectId: f.project.id, claimId: f.claim.id,
    expectedClaimVersion: f.claim.version, evidenceId: f.old.id,
    expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.old.id, f.project.id)),
    kind: 'supports', condition: null, supersedesRelationId: null}, {kind: 'user', id: 'synthetic-review-before-reparse'});
  f.review = f.repository.evidence.relations.review({projectId: f.project.id, relationId: proposed.id,
    expectedVersion: proposed.version, expectedClaimVersion: f.claim.version, expectedSourceDigest: proposed.sourceDigest,
    decision: 'confirm', note: null}, {kind: 'user', id: 'synthetic-review-before-reparse'});
  f.publish('decision-new');
  [f.inspection] = f.repository.evidence.sourceMigrations.list({projectId: f.project.id, evidenceId: f.old.id});
  f.registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchEvidenceCapabilities) f.registry.declare('research', descriptor);
  api.registerResearchEvidenceCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.evidence);
  f.adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => f.registry.invoke(name, input)});
  f.request = {projectId: f.project.id, proposalId: f.inspection.proposal.id, requestId: 'explicit-decision-1',
    expectedProposalHash: f.inspection.proposalHash, expectedSourceDigest: f.inspection.proposal.sourceDigest,
    expectedTargetParseHash: f.inspection.proposal.targetParseHash, note: 'Selected the second actual target.'};
  f.capture = {...f.request, action: 'capture', chunkId: 'document:decision-new:chunk:1'};
  f.reject = {...f.request, action: 'reject'};
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.original = () => ({
    evidence: f.repository.evidence.inspectEvidence(f.old.id, f.project.id),
    claim: f.repository.evidence.getClaim(f.claim.id),
    history: f.repository.evidence.claimHistory(f.claim.id),
    relations: f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id}),
    reviews: f.repository.evidence.relations.history(f.review.id, f.project.id),
    proposal: f.db.prepare('SELECT * FROM research_source_migration_proposals WHERE id=?').get(f.inspection.proposal.id)
  });
  return f;
}

test('generated user capture selects an actual ambiguous target and records authority without restoring scientific review', async () => {
  const f = scene();
  try {
    const original = f.original(), before = f.changes();
    const listed = await f.adapter.invoke('research.listSourceMigrations', [{projectId: f.project.id, evidenceId: f.old.id}], 31);
    const read = await f.adapter.invoke('research.getSourceMigration', [{projectId: f.project.id, proposalId: f.request.proposalId}], 31);
    assert.deepEqual(listed.data, [read.data]);
    assert.equal(read.data.proposal.match, 'ambiguous');
    assert.equal(read.data.decision, null);
    assert.equal(read.data.capturedReferenceStatus, null);
    assert.equal(f.changes(), before);
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:source-migrations-capture', [f.capture]), [f.capture]);
    const result = await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31);
    assert.equal(result.ok, true);
    const decision = result.data;
    assert.deepEqual(decision.actor, {kind: 'user', id: 'window:31'});
    assert.deepEqual(decision.request, f.capture);
    assert.equal(decision.requestHash, hash(JSON.stringify(f.capture)));
    assert.equal(decision.capturedSourceDigest, api.relationSourceDigest(decision.capturedSource));
    assert.equal(decision.capturedSource.sourceLocator.parseId, 'decision-new');
    assert.equal(decision.capturedSource.sourceLocator.blockId, 'second');
    assert.equal(decision.capturedSource.sourceLocator.locations[0].page, 3);
    assert.notEqual(decision.capturedSource.evidence.id, f.old.id);
    assert.equal(f.repository.evidence.list(f.project.id).length, 2);
    assert.deepEqual(f.original(), original);
    assert.equal(original.relations[0].status, 'invalidated');
    assert.deepEqual(original.reviews[1].relation, f.review);
    assert.throws(() => f.repository.evidence.assertReviewedSupport(f.claim), /research_evidence_reference_superseded/u);
    const after = f.changes();
    const replay = await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31);
    assert.deepEqual(replay.data, decision);
    assert.equal(f.changes(), after);
    const current = (await f.adapter.invoke('research.getSourceMigration', [{projectId: f.project.id, proposalId: f.request.proposalId}], 31)).data;
    assert.deepEqual(current.decision, decision);
    assert.equal(current.capturedReferenceStatus, 'recorded');
    assert.equal(f.changes(), after);
  } finally {f.close();}
});

test('rejection is fixed, idempotent, and produces no evidence even for a stale or unmatched target', async () => {
  for (const targets of [[block('changed', 4, 'Different scientific statement.')], [block('same', 1)]]) {
    const f = scene({targets});
    try {
      if (targets[0].id === 'same') f.publish('decision-later');
      const original = f.original();
      const result = await f.adapter.invoke('research.rejectSourceMigration', [f.reject], 42);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data.actor, {kind: 'user', id: 'window:42'});
      assert.equal(result.data.capturedSource, null);
      assert.equal(result.data.capturedSourceDigest, null);
      assert.equal(f.repository.evidence.list(f.project.id).length, 1);
      assert.deepEqual(f.original(), original);
      const after = f.changes();
      assert.deepEqual((await f.adapter.invoke('research.rejectSourceMigration', [f.reject], 42)).data, result.data);
      assert.equal(f.changes(), after);
      const conflict = await f.adapter.invoke('research.captureSourceMigration', [{...f.capture, requestId: 'different-request'}], 42);
      assert.equal(conflict.error.code, 'research_source_migration_already_decided');
      assert.equal(f.changes(), after);
    } finally {f.close();}
  }
});

test('wire actors, missing sender, direct capabilities and different human contexts cannot authorize source decisions', async () => {
  const f = scene();
  try {
    const before = f.changes();
    for (const [capability, method, channel, request] of [
      ['research.sourceMigrations.capture', 'research.captureSourceMigration', 'roc:research:source-migrations-capture', f.capture],
      ['research.sourceMigrations.reject', 'research.rejectSourceMigration', 'roc:research:source-migrations-reject', f.reject]
    ]) {
      await assert.rejects(f.registry.invoke(capability, request), error => error.code === 'research_human_required' && error.category === 'permission');
      for (const key of ['actor', 'reviewer', 'windowId', 'source', 'capturedSource']) {
        const forged = {...request, [key]: {kind: 'user', id: 'forged'}};
        assert.throws(() => api.parseIpcRequestArgs(channel, [forged]));
        assert.equal((await f.adapter.invoke(method, [forged], 31)).ok, false);
      }
      assert.throws(() => api.parseIpcRequestArgs(channel, [request, 31]));
      assert.equal((await f.adapter.invoke(method, [request])).error.code, 'research_sender_required');
      await assert.rejects(api.withResearchHumanContext({capability: 'research.relations.review',
        projectId: f.project.id, windowId: 31}, () => f.registry.invoke(capability, request)),
      error => error.code === 'research_human_required');
      await assert.rejects(api.withResearchHumanContext({capability, projectId: 'foreign', windowId: 31},
        () => f.registry.invoke(capability, request)), error => error.code === 'research_human_project_mismatch');
    }
    assert.throws(() => api.parseIpcRequestArgs('roc:research:source-migrations-capture', [{...f.request, action: 'capture'}]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:source-migrations-reject', [{...f.reject, chunkId: f.capture.chunkId}]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:source-migrations-reject', [{...f.request}]));
    assert.equal(f.changes(), before);
    assert.equal(f.repository.evidence.list(f.project.id).length, 1);
  } finally {f.close();}
});

test('stale hashes, unproposed blocks, foreign projects and request conflicts refuse without writes', async () => {
  const f = scene();
  try {
    const before = f.changes();
    for (const [override, code] of [
      [{expectedProposalHash: 'a'.repeat(64)}, 'research_source_migration_proposal_changed'],
      [{expectedSourceDigest: 'a'.repeat(64)}, 'research_source_migration_source_changed'],
      [{expectedTargetParseHash: 'a'.repeat(64)}, 'research_source_migration_target_changed'],
      [{chunkId: 'document:decision-old:chunk:0'}, 'research_source_migration_target_not_proposed'],
      [{proposalId: 'missing'}, 'research_source_migration_not_found']
    ]) {
      const result = await f.adapter.invoke('research.captureSourceMigration', [{...f.capture, ...override}], 31);
      assert.equal(result.error.code, code);
      assert.equal(result.error.category, code.endsWith('not_found') ? 'not_found' : 'conflict');
    }
    assert.equal(f.changes(), before);
    const other = f.repository.createProject({title: 'Foreign decision scope', description: '', workspacePath: '/tmp/decision-other'});
    const afterOther = f.changes();
    for (const method of ['research.getSourceMigration', 'research.captureSourceMigration']) {
      const request = method.endsWith('getSourceMigration') ? {projectId: other.id, proposalId: f.request.proposalId} : {...f.capture, projectId: other.id};
      assert.equal((await f.adapter.invoke(method, [request], 31)).error.code, 'research_source_migration_project_mismatch');
    }
    assert.equal(f.changes(), afterOther);
    assert.equal((await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31)).ok, true);
    const after = f.changes();
    for (const [request, window] of [[f.capture, 42], [{...f.capture, note: 'Changed'}, 31],
      [{...f.capture, chunkId: 'document:decision-new:chunk:0'}, 31], [f.reject, 31]]) {
      assert.equal((await f.adapter.invoke(request.action === 'capture' ? 'research.captureSourceMigration' : 'research.rejectSourceMigration',
        [request], window)).error.code, 'research_source_migration_request_conflict');
    }
    assert.equal(f.changes(), after);
  } finally {f.close();}
});

test('decision failure rolls back the actual new evidence and locator; corrupt chunks cannot be captured', async () => {
  const f = scene();
  try {
    const original = f.original();
    f.db.exec(`CREATE TRIGGER reject_decision BEFORE INSERT ON research_source_migration_decisions
      BEGIN SELECT RAISE(ABORT,'synthetic_decision_insert_failed'); END`);
    await assert.rejects(api.withResearchHumanContext({
      capability: 'research.sourceMigrations.capture', projectId: f.project.id, windowId: 31
    }, () => f.registry.invoke('research.sourceMigrations.capture', f.capture)), /synthetic_decision_insert_failed/u);
    assert.equal(f.repository.evidence.list(f.project.id).length, 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(), 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_source_migration_decisions').pluck().get(), 0);
    assert.deepEqual(f.original(), original);
    f.db.exec('DROP TRIGGER reject_decision');
    f.db.prepare('UPDATE research_knowledge_chunks SET content=?,content_hash=? WHERE id=?')
      .run('Forged indexed text', hash('Forged indexed text'), f.capture.chunkId);
    const after = f.changes();
    const result = await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31);
    assert.equal(result.error.code, 'research_source_migration_index_changed');
    assert.equal(result.error.category, 'degraded');
    assert.equal(f.repository.evidence.list(f.project.id).length, 1);
    assert.equal(f.changes(), after);
  } finally {f.close();}
});

test('later parses preserve the original human capture and replay while reporting its current invalidation', async () => {
  const f = scene();
  try {
    const decision = (await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31)).data;
    f.publish('decision-third');
    const after = f.changes();
    const inspection = (await f.adapter.invoke('research.getSourceMigration', [{projectId: f.project.id, proposalId: f.request.proposalId}], 31)).data;
    assert.equal(inspection.targetStatus, 'stale');
    assert.equal(inspection.capturedReferenceStatus, 'superseded');
    assert.deepEqual(inspection.proposal, f.inspection.proposal);
    assert.deepEqual(inspection.decision, decision);
    assert.equal(decision.capturedSource.referenceStatus, 'recorded');
    assert.deepEqual((await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31)).data, decision);
    assert.equal(f.changes(), after);
    f.db.prepare("UPDATE research_source_migration_decisions SET snapshot_json=json_set(snapshot_json,'$.actor.id','forged') WHERE id=?").run(decision.id);
    const damaged = f.changes();
    for (const [method, request] of [
      ['research.getSourceMigration', {projectId: f.project.id, proposalId: f.request.proposalId}],
      ['research.captureSourceMigration', f.capture]
    ]) {
      const result = await f.adapter.invoke(method, [request], 31);
      assert.equal(result.error.code, 'research_source_migration_snapshot_invalid');
      assert.equal(result.error.category, 'degraded');
    }
    assert.equal(f.changes(), damaged);
  } finally {f.close();}
});

test('stale targets and archived projects refuse capture, and changed target parsing refuses rejection', async () => {
  const f = scene();
  try {
    f.db.prepare("UPDATE research_document_parses SET data_json=json_set(data_json,'$.content.blocks[0].text','Changed same parse') WHERE id='decision-new'").run();
    const after = f.changes();
    assert.equal((await f.adapter.invoke('research.rejectSourceMigration', [f.reject], 31)).error.code, 'research_source_migration_target_changed');
    assert.equal(f.changes(), after);
    f.publish('decision-third');
    const stale = f.changes();
    assert.equal((await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31)).error.code, 'research_source_migration_target_stale');
    assert.equal(f.changes(), stale);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const archived = f.changes();
    assert.equal((await f.adapter.invoke('research.rejectSourceMigration', [f.reject], 31)).error.code, 'research_project_archived');
    assert.equal(f.changes(), archived);
  } finally {f.close();}
});

test('active role reads actual candidate selection history and stale target facts without deciding or restoring support', async () => {
  const f = scene();
  try {
    const decision = (await f.adapter.invoke('research.captureSourceMigration', [f.capture], 31)).data;
    const tools = api.createResearchRoleTools({run: f.run, context: f.repository.runs.getContext(f.run.id),
      repository: f.repository, capabilities: {}, signal: new AbortController().signal});
    const read = tools.find(tool => tool.name === 'read_source_migrations');
    assert.ok(read);
    const before = f.changes();
    const fullRead = async () => {
      let text = '', offset = 0;
      do {
        const part = await read.invoke({evidenceId: f.old.id, offset, limit: 500});
        text += part.content; offset = part.nextOffset;
      } while (offset !== null);
      return JSON.parse(text);
    };
    const [current] = await fullRead();
    assert.deepEqual(current.proposal, f.inspection.proposal);
    assert.equal(current.proposalHash, f.inspection.proposalHash);
    assert.deepEqual(current.decision, decision);
    assert.equal(current.targetStatus, 'current');
    assert.equal(current.capturedReferenceStatus, 'recorded');
    assert.equal(f.changes(), before);
    f.publish('decision-later');
    const after = f.changes();
    const [stale] = await fullRead();
    assert.deepEqual(stale.proposal, current.proposal);
    assert.deepEqual(stale.decision, decision);
    assert.equal(stale.targetStatus, 'stale');
    assert.equal(stale.capturedReferenceStatus, 'superseded');
    assert.equal(f.repository.evidence.relations.get(f.review.id, f.project.id).status, 'invalidated');
    assert.equal(f.changes(), after);
  } finally {f.close();}
});
