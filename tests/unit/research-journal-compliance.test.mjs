import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm, symlink, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {unknownExperiment, withResearchTestWorker, createResearchFixture, loadResearchTestApi, captureResearchArtifactVersions} from './fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from './fixtures/research-production-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rule = (id, options) => ({id, label: id, sourceUrl: 'https://example.org/synthetic-journal/rules',
  excerpt: 'Synthetic engineering rule, not a real journal requirement.', authority: 'required', ...options});
const selection = () => ({
  profile: {journal: 'Synthetic engineering journal', articleType: 'Synthetic article', submissionStage: 'initial',
    version: 'test-1', revisionDate: '2026-11-06', dateAuthority: 'human_transcription',
    retrievedAt: '2026-11-06T00:00:00.000Z', rules: [
      rule('sections', {kind: 'sections', titles: ['Results', 'Methods']}),
      rule('references', {kind: 'reference_count', maximum: 0}),
      rule('metadata', {kind: 'reference_fields', fields: ['doi']}),
      rule('supplement', {kind: 'supplements', paths: ['supplement.txt']}),
      rule('judgement', {kind: 'manual', area: 'structure'})
    ]},
  figureIds: [], supplementPaths: [], manualReviews: []
});

async function scene(withBibliography = false) {
  const root = await mkdtemp(join(tmpdir(), 'roc-journal-'));
  const f = createResearchFixture(api, 'writing', root);
  if (withBibliography) {
    f.item = f.repository.library.import([{metadata: {id: 'journal-literature', source: 'local', externalId: 'journal-fixture',
      doi: null, title: 'Synthetic bibliography', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
      citationCount: null, url: null, openAccessUrl: null, importedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z'},
      bibliography: {citationKey: 'synthetic2026', entryType: 'article', fields: {title: 'Synthetic bibliography'}, preambles: [],
        csl: null, title: 'Synthetic bibliography', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}
    }], f.project.id).items[0];
  }
  f.repository.knowledge.upsertFromSource({id: 'journal-source', projectId: f.project.id, sourceType: withBibliography ? 'literature' : 'file',
    sourceId: withBibliography ? f.item.id : 'synthetic.md', title: 'Synthetic measurement', content: 'Measured difference was -4 ms.',
    chunks: [{content: 'Measured difference was -4 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'journal-source:chunk:0'});
  f.artifactId = withResearchTestWorker(api, f.repository, f.run.id, f.project.id, workerRunId => f.repository.runs.complete(workerRunId, f.project.id, {title: 'Synthetic manuscript', markdown: 'Synthetic draft',
    claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Measured difference was -4 ms.', status: 'supported', evidenceIds: [f.source.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.service = new api.ResearchJournalComplianceService(f.repository, {verify: async () => assert.fail('no figure selected')});
  f.inspect = (selected = null, expectedHash = null) => f.service.inspect({
    projectId: f.project.id, artifactId: f.artifactId, selection: selected, expectedHash
  });
  f.request = async (selected = selection(), overrides = {}) => {
    const {report} = await f.inspect(selected);
    return {projectId: f.project.id, artifactId: f.artifactId, requestId: 'journal-1',
      expectedArtifactVersion: report.artifactVersion, expectedMaterialHash: report.materialHash,
      parent: null, rationale: 'Human selected synthetic rules', selection: selected, ...overrides};
  };
  f.save = (request, windowId = 77) => api.withResearchHumanContext({
    capability: 'research.journalCompliance.save', projectId: request.projectId, windowId}, () => f.service.save(request));
  f.history = (offset = 0, limit = 100) => f.repository.journalCompliance.history({
    projectId: f.project.id, artifactId: f.artifactId, offset, limit});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.dispose = async () => {f.close(); await rm(root, {recursive: true, force: true});};
  f.root = root;
  return f;
}

test('explicit dated rules preserve failures guidance and separate manual judgement without accepting the manuscript', async () => {
  const f = await scene();
  try {
    const empty = await f.inspect();
    assert.equal(empty.report.selection, null);
    assert.equal(empty.report.material, null);
    assert.deepEqual(empty.report.checks, []);
    const selected = selection();
    selected.profile.rules[0].authority = 'guidance';
    selected.manualReviews.push({ruleId: 'judgement', decision: 'pass', rationale: 'Human inspected synthetic structure'});
    const request = await f.request(selected), receipt = await f.save(request), before = f.changes();
    assert.deepEqual(receipt.snapshot.checks.map(check => check.status), ['fail', 'fail', 'manual', 'fail', 'manual']);
    assert.deepEqual(receipt.snapshot.checks[0].subjectIds, ['Methods']);
    assert.equal(receipt.snapshot.request.selection.profile.rules[0].authority, 'guidance');
    assert.equal(receipt.snapshot.actor.id, 'window:77');
    assert.equal(receipt.snapshotHash, digest(receipt.snapshot));
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
    assert.deepEqual(await f.save(request), receipt);
    assert.equal(f.changes(), before);
    assert.equal((await f.inspect()).report.reviewCurrent, true);
    assert.equal(f.history().verification, 'stored_receipt');
    assert.deepEqual(f.history().items, [receipt]);
  } finally {await f.dispose();}
});

test('human IPC refuses forged authority duplicate rules missing dates and automatic verdict overrides with zero writes', async () => {
  const f = await scene();
  try {
    const request = await f.request(), before = f.changes();
    for (const invalid of [
      {...request, actor: {kind: 'user', id: 'forged'}},
      {...request, selection: {...request.selection, profile: {...request.selection.profile, revisionDate: ''}}},
      {...request, selection: {...request.selection, profile: {...request.selection.profile, version: ''}}},
      {...request, selection: {...request.selection, profile: {...request.selection.profile,
        rules: [request.selection.profile.rules[0], request.selection.profile.rules[0]]}}},
      {...request, selection: {...request.selection, manualReviews: [{ruleId: 'sections', decision: 'pass', rationale: 'override'}]}},
      {...request, selection: {...request.selection, supplementPaths: ['../outside']}},
      {...request, checks: []}
    ]) assert.equal(api.researchJournalSaveSchema.safeParse(invalid).success, false);
    await assert.rejects(() => f.service.save(request), /research_human_required/u);
    const handlers = new Map();
    api.registerResearchJournalComplianceCapabilities({pluginId: 'fixture', capabilities: {
      register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
    }}, f.service, f.repository.journalCompliance);
    const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
    assert.equal((await bridge.invoke('research.saveJournalCompliance', [request])).error.code, 'research_sender_required');
    assert.equal(f.changes(), before);
    const saved = await bridge.invoke('research.saveJournalCompliance', [request], 77);
    assert.equal(saved.ok, true);
    assert.equal(saved.data.snapshot.actor.id, 'window:77');
    assert.equal((await bridge.invoke('research.saveJournalCompliance', [request], 78)).error.code, 'research_journal_request_conflict');
  } finally {await f.dispose();}
});

test('real supplements bind exact bytes and preview hash; missing links directories and changed bytes never become success', async () => {
  const f = await scene();
  try {
    await writeFile(join(f.root, 'supplement.txt'), 'Original synthetic supplementary material.');
    const selected = selection(); selected.supplementPaths = ['supplement.txt'];
    const request = await f.request(selected);
    const saved = await f.save(request);
    assert.equal(saved.snapshot.checks[3].status, 'pass');
    assert.equal(saved.snapshot.material.supplements[0].size, 42);
    await writeFile(join(f.root, 'supplement.txt'), 'Changed bytes.');
    await assert.rejects(() => f.service.verify(saved), /research_journal_source_changed/u);
    await assert.rejects(() => f.save(request), /research_journal_source_changed/u);
    assert.equal((await f.inspect()).report.reviewCurrent, false);
    assert.deepEqual(f.history().items, [saved]);
    await symlink(join(f.root, 'supplement.txt'), join(f.root, 'linked.txt'));
    await assert.rejects(() => f.inspect({...selected, supplementPaths: ['linked.txt']}), /research_path_symlink/u);
    await assert.rejects(() => f.inspect({...selected, supplementPaths: ['missing.txt']}), /ENOENT/u);
    await mkdir(join(f.root, 'directory'));
    await assert.rejects(() => f.inspect({...selected, supplementPaths: ['directory']}), /research_file_size_invalid/u);
  } finally {await f.dispose();}
});

test('real bibliography fields and revisions remain source bound rather than inferring complete citations from file titles', async () => {
  const f = await scene(true);
  try {
    const selected = selection();
    selected.profile.rules = [rule('metadata', {kind: 'reference_fields', fields: ['title', 'authors', 'publishedYear']}),
      rule('doi', {kind: 'reference_fields', fields: ['doi']}), rule('count', {kind: 'reference_count', maximum: 1})];
    const receipt = await f.save(await f.request(selected));
    assert.deepEqual(receipt.snapshot.checks.map(check => check.status), ['pass', 'fail', 'pass']);
    assert.equal(receipt.snapshot.material.sources[0].bibliography.itemId, f.item.id);
    f.repository.library.setCitationKey(f.item.id, f.item.revision, 'changed2026');
    assert.equal((await f.inspect()).report.reviewCurrent, false);
    await assert.rejects(() => f.service.verify(receipt), /research_journal_source_changed/u);
    assert.deepEqual(f.history().items, [receipt]);
  } finally {await f.dispose();}
});

test('new parents source edits project scopes approved and archived state refuse mutation while stored history remains readable', async () => {
  const f = await scene(), foreign = await scene();
  try {
    const firstRequest = await f.request(), first = await f.save(firstRequest);
    const nextRequest = await f.request(selection(), {requestId: 'journal-2',
      parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}, rationale: 'Explicit revision'});
    const second = await f.save(nextRequest);
    await assert.rejects(() => f.save({...firstRequest, requestId: 'old-parent'}), /research_journal_version_conflict/u);
    await assert.rejects(() => f.save({...nextRequest, rationale: 'Conflicting retry'}), /research_journal_request_conflict/u);
    await assert.rejects(() => f.service.inspect({projectId: foreign.project.id, artifactId: f.artifactId,
      selection: null, expectedHash: null}), /research_project_not_found|research_journal_project_mismatch/u);
    f.repository.evidence.invalidateChunksOf(f.source.documentId);
    await assert.rejects(() => f.service.verify(second), /research_manuscript_stale|research_evidence_reference_superseded/u);
    assert.deepEqual(f.history().items, [second, first]);
    const otherRequest = await foreign.request();
    foreign.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(foreign.artifactId);
    await assert.rejects(() => foreign.save(otherRequest), /research_artifact_immutable/u);
    foreign.db.prepare("UPDATE research_artifacts SET status='draft' WHERE id=?").run(foreign.artifactId);
    foreign.repository.updateProject({id: foreign.project.id, status: 'archived'});
    await assert.rejects(() => foreign.save(otherRequest), /research_project_archived/u);
  } finally {await f.dispose(); await foreign.dispose();}
});

test('complete paged rule revision history verifies replay checks and detects damaged derived results and parent chains', async () => {
  const f = await scene();
  try {
    let latest = null;
    for (let version = 1; version <= 102; version++) {
      const selected = selection(); selected.profile.version = `synthetic-${version}`;
      const request = await f.request(selected, {requestId: `journal-${version}`,
        parent: latest === null ? null : {reviewId: latest.snapshot.id, reviewHash: latest.snapshotHash}});
      latest = await f.save(request);
    }
    assert.equal(f.history().total, 102);
    assert.equal(f.history().items.length, 100);
    assert.deepEqual(f.history(100).items.map(item => item.snapshot.version), [2, 1]);
    const exported = api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]).journalCompliance[0];
    assert.deepEqual(exported.current, latest);
    assert.equal(exported.supplementDelivery, 'metadata_only');
    assert.equal(exported.history.verification, 'stored_receipt');
    assert.deepEqual(exported.history.items.map(item => item.snapshot.version),
      Array.from({length: 102}, (_, index) => 102 - index));
    const history = f.repository.journalCompliance.history.bind(f.repository.journalCompliance);
    f.repository.journalCompliance.history = request => request.offset === 0 ? history(request) :
      {verification: 'stored_receipt', items: [], total: 102};
    assert.throws(() => api.captureExportArtifactReviews(f.repository, f.project.id, [f.artifactId]),
      /research_export_review_history_changed/u);
    f.repository.journalCompliance.history = history;
    const damaged = structuredClone(latest.snapshot);
    damaged.checks[0].status = 'pass';
    f.db.prepare('UPDATE research_journal_compliance SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(JSON.stringify(damaged), digest(damaged), latest.snapshot.id);
    assert.throws(() => f.history(), /research_journal_snapshot_invalid/u);
    f.db.prepare('UPDATE research_journal_compliance SET snapshot_json=?,snapshot_hash=? WHERE id=?')
      .run(JSON.stringify(latest.snapshot), latest.snapshotHash, latest.snapshot.id);
    f.db.prepare("UPDATE research_journal_compliance SET snapshot_hash=? WHERE version=101").run('0'.repeat(64));
    assert.throws(() => f.repository.journalCompliance.latest(f.project.id, f.artifactId), /research_journal_snapshot_invalid/u);
  } finally {await f.dispose();}
});

test('journal-only human checks bind inspector and task proofs, require real verification and revoke earlier approval versions', async () => {
  const f = await scene();
  try {
    const inspect = expectedVersion => f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion});
    const initial = inspect(null).snapshot;
    assert.equal(initial.journalCompliance, null);
    const first = await f.save(await f.request());
    const current = inspect(initial.version);
    assert.equal(current.status, 'stale');
    assert.deepEqual(current.snapshot.journalCompliance, {reviewId: first.snapshot.id, reviewHash: first.snapshotHash,
      version: 1, recordedAt: first.snapshot.recordedAt});
    assert.deepEqual(current.snapshot.claims, initial.claims);
    const before = f.changes();
    assert.deepEqual(api.currentArtifactScientificReviews(f.repository, f.project.id, f.artifactId).journal, first);
    const missing = api.createResearchHumanGate({repository: f.repository});
    await assert.rejects(missing.complete({projectId: f.project.id, expectedStage: 'writing', action: 'complete'}),
      /research_scientific_review_verify_unavailable/u);
    assert.equal(f.changes(), before);
    let reads = 0;
    const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository, {
      evidence: async request => {assert.equal(request.evidenceId, f.source.id); reads++; return null;}
    }, {verify: async () => assert.fail('no selected figures')});
    const gate = api.createResearchHumanGate({repository: f.repository, scientificReviews});
    await gate.complete({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
    assert.equal(reads, 1);
    const prior = captureResearchArtifactVersions(f.repository, f.project.id);
    const proof = f.repository.verifyStageForTaskAcceptance(f.project.id, 'writing');
    assert.deepEqual(proof.refs, [{path: `research-artifact:${f.artifactId}`, sha256: prior[0].version}]);
    const revised = selection(); revised.profile.version = 'test-2';
    await f.save(await f.request(revised, {requestId: 'journal-2', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}}));
    assert.notDeepEqual(f.repository.verifyStageForTaskAcceptance(f.project.id, 'writing').refs, proof.refs);
    const changes = f.changes();
    await assert.rejects(gate.approve({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: prior}), /research_artifact_review_changed/u);
    assert.equal(f.changes(), changes);
    const claim = initial.claims[0];
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm',
      note: 'Human reviewed synthetic source support'}, {kind: 'user', id: 'window:77'});
    await gate.approve({projectId: f.project.id, expectedStage: 'writing', action: 'approve',
      expectedArtifactVersions: captureResearchArtifactVersions(f.repository, f.project.id)});
    assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
    assert.deepEqual(f.history().items.at(-1), first);
  } finally {await f.dispose();}
});

test('shared journal verification rejects source, project, rule and supplement changes across awaits', async () => {
  for (const mutation of ['source', 'project', 'rules', 'supplement']) {
    const f = await scene();
    try {
      await writeFile(join(f.root, 'supplement.txt'), 'Initial supplementary bytes');
      const selected = selection(); selected.supplementPaths = ['supplement.txt'];
      const first = await f.save(await f.request(selected));
      const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository, {
        evidence: async () => {
          if (mutation === 'source') f.repository.evidence.invalidateChunksOf(f.source.documentId);
          if (mutation === 'project') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
          if (mutation === 'supplement') await writeFile(join(f.root, 'supplement.txt'), 'Changed supplementary bytes');
          if (mutation === 'rules') {
            const revised = structuredClone(selected); revised.profile.version = 'changed-during-await';
            await f.save(await f.request(revised, {requestId: 'during-await',
              parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}}));
          }
          return null;
        }
      }, {verify: async () => assert.fail('no selected figures')});
      await assert.rejects(scientificReviews.verifyArtifacts(f.project.id, [f.artifactId]),
        /research_evidence_reference_superseded|research_manuscript_stale|research_journal_source_changed|research_artifact_review_changed/u);
      assert.deepEqual(f.history().items.at(-1), first);
    } finally {await f.dispose();}
  }
});

test('the final synchronous review pass catches a first manuscript changed while the second is verified', async () => {
  const f = await scene();
  try {
    const first = await f.save(await f.request());
    const second = f.repository.createArtifact({projectId: f.project.id, stage: 'writing', kind: 'manuscript',
      title: 'Second manuscript', path: null});
    const claim = f.repository.evidence.createClaim({experiment: {...unknownExperiment}, projectId: f.project.id, artifactId: second.id, subjectType: 'paragraph',
      content: 'Another synthetic observation', status: 'supported', evidenceIds: [f.source.id]});
    f.repository.manuscripts.saveManuscript({artifactId: second.id, sections: [{title: 'Results', claimIds: [claim.id]}]});
    const preview = await f.service.inspect({projectId: f.project.id, artifactId: second.id, selection: selection(), expectedHash: null});
    await f.save({projectId: f.project.id, artifactId: second.id, selection: selection(), requestId: 'second',
      expectedArtifactVersion: preview.report.artifactVersion, expectedMaterialHash: preview.report.materialHash,
      parent: null, rationale: 'Second synthetic rules'});
    let reads = 0;
    const scientificReviews = new api.ResearchArtifactScientificReviewService(f.repository, {evidence: async () => {
      if (++reads === 2) {
        const revised = selection(); revised.profile.version = 'first-changed';
        await f.save(await f.request(revised, {requestId: 'changed-first',
          parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}}));
      }
      return null;
    }}, {verify: async () => assert.fail('no selected figures')});
    await assert.rejects(scientificReviews.verifyArtifacts(f.project.id, [f.artifactId, second.id]),
      /research_artifact_review_changed/u);
    assert.equal(reads, 2);
  } finally {await f.dispose();}
});

test('schema5 seals carry full dated journal receipts and metadata-only supplements and refuse revisions or missing arrays', async () => {
  const f = await scene();
  try {
    const claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
    const relation = f.repository.evidence.relations.list({projectId: f.project.id, claimId: claim.id})[0];
    f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id, expectedVersion: relation.version,
      expectedClaimVersion: claim.version, expectedSourceDigest: relation.sourceDigest, decision: 'confirm',
      note: 'Synthetic human support review'}, {kind: 'user', id: 'window:77'});
    await writeFile(join(f.root, 'supplement.txt'), 'Supplement bytes are checked, not delivered');
    const selected = selection(); selected.supplementPaths = ['supplement.txt'];
    const first = await f.save(await f.request(selected));
    const sources = {project: f.project, manuscriptArtifact: f.repository.getArtifact(f.artifactId),
      figures: [], claims: [claim], evidence: [f.source], experimentResults: [], ideaOutcomes: []};
    const review = api.captureExportScientificReview(f.repository, sources), bytes = api.serializeExportScientificReview(review);
    const publicBytes = api.serializePublicExportScientificReview(review);
    assert.equal(review.schemaVersion, 5);
    assert.deepEqual(review.journalCompliance, [{artifactId: f.artifactId, current: first,
      history: {verification: 'stored_receipt', items: [first], total: 1}, supplementDelivery: 'metadata_only'}]);
    assert.equal(bytes.includes(f.root), false);
    assert.equal(api.researchExportScientificReviewSchema.safeParse({...review, schemaVersion: 4}).success, false);
    assert.equal(api.researchExportScientificReviewSchema.safeParse({...review, journalCompliance: undefined}).success, false);
    assert.equal(api.researchExportScientificReviewSchema.safeParse({...review, journalCompliance: [{
      ...review.journalCompliance[0], supplementDelivery: 'bundled'}]}).success, false);
    const record = {sources, sourceHash: review.sourceHash, files: [{path: api.exportScientificReviewPath,
      size: Buffer.byteLength(publicBytes), sha256: createHash('sha256').update(publicBytes).digest('hex')}]};
    api.assertCurrentExportScientificReview(f.repository, record);
    const revised = structuredClone(selected); revised.profile.version = 'new-date';
    await f.save(await f.request(revised, {requestId: 'journal-2', parent: {reviewId: first.snapshot.id, reviewHash: first.snapshotHash}}));
    assert.throws(() => api.assertCurrentExportScientificReview(f.repository, record),
      error => error.code === 'research_export_semantic_snapshot_changed');
    assert.equal(api.serializeExportScientificReview(review), bytes);
  } finally {await f.dispose();}
});

test('actual figure file dimensions and bytes obey explicit raster rules; vector DPI and absent figures require honest handling', async () => {
  const f = await createPublishedFigureFixture(api);
  try {
    const claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
    f.db.prepare("UPDATE research_projects SET current_stage='writing' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(f.project.id);
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'writing', kind: 'manuscript',
      title: 'Synthetic figure companion', path: null});
    f.repository.evidence.createClaim({experiment: {...unknownExperiment}, projectId: f.project.id, artifactId: artifact.id, subjectType: 'paragraph',
      content: claim.content, status: 'supported', evidenceIds: claim.evidenceIds});
    const manuscriptClaim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: artifact.id})[0];
    f.repository.manuscripts.saveManuscript({artifactId: artifact.id,
      sections: [{title: 'Results', claimIds: [manuscriptClaim.id]}]});
    const service = new api.ResearchJournalComplianceService(f.repository, f.figureService), selected = selection();
    selected.figureIds = [f.figureId];
    selected.profile.rules = [rule('figure', {kind: 'figure_files', format: 'png', maximumBytes: 64 * 1024 * 1024,
      minimumDpi: 72, maximumWidthPoints: 216, maximumHeightPoints: 144})];
    const inspect = value => service.inspect({projectId: f.project.id, artifactId: artifact.id, selection: value, expectedHash: null});
    const current = await inspect(selected);
    assert.equal(current.report.checks[0].status, 'pass');
    assert.equal(current.report.material.figures[0].validation.widthPixels, 216);
    const failing = structuredClone(selected); failing.profile.rules[0].minimumDpi = 300;
    assert.equal((await inspect(failing)).report.checks[0].status, 'fail');
    assert.equal((await inspect({...selected, figureIds: []})).report.checks[0].status, 'manual');
    const bytesRule = structuredClone(selected); bytesRule.profile.rules[0].maximumBytes = 1;
    assert.equal((await inspect(bytesRule)).report.checks[0].status, 'fail');
    const vector = structuredClone(selected); vector.profile.rules[0].format = 'pdf';
    const vectorRequest = {projectId: f.project.id, artifactId: artifact.id, requestId: 'vector',
      expectedArtifactVersion: current.report.artifactVersion, expectedMaterialHash: current.report.materialHash,
      parent: null, rationale: 'Vector format cannot have raster DPI', selection: vector};
    assert.equal(api.researchJournalSaveSchema.safeParse(vectorRequest).success, false);
    const mutating = new api.ResearchJournalComplianceService(f.repository, {verify: async (...args) => {
      const result = await f.figureService.verify(...args);
      f.db.prepare('UPDATE research_artifacts SET title=? WHERE id=?').run('Changed during figure verification', artifact.id);
      return result;
    }});
    await assert.rejects(() => mutating.inspect({projectId: f.project.id, artifactId: artifact.id, selection: selected, expectedHash: null}),
      /research_journal_artifact_changed/u);
    const output = f.productionRun.files.find(file => file.area === 'output' && file.path === 'figure.png');
    await writeFile(join(f.repository.figureRuns.root(f.project.id, f.productionRun.id), 'output', output.path), 'changed figure');
    await assert.rejects(() => inspect(selected), /research_figure_snapshot_changed/u);
  } finally {await f.dispose();}
});
