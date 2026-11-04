import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {createReviewScreeningPlanFixture, reviewScreeningActorFixture as actor} from './fixtures/research-review-screening.mjs';
import {createReviewFullTextScreeningFixture, fullTextInclude as include} from './fixtures/research-review-fulltext-screening.mjs';
import {createReviewQualityFixture} from './fixtures/research-review-quality.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function connect(f, signal = new AbortController().signal) {
  const registry = new api.CapabilityRegistry();
  const context = {pluginId: 'research', capabilities: registry};
  const register = (descriptors, run) => {
    for (const descriptor of descriptors) registry.declare('research', descriptor);
    run();
  };
  register(api.researchSystematicReviewCapabilities, () => api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews));
  register(api.researchReviewSearchCapabilities, () => api.registerResearchReviewSearchCapabilities(context, f.reviews));
  register(api.researchReviewCorpusCapabilities, () => api.registerResearchReviewCorpusCapabilities(context, f.corpora));
  register(api.researchReviewScreeningCapabilities, () =>
    api.registerResearchReviewScreeningCapabilities(context, f.screening, f.decisions, f.arbitration, f.freezing));
  if (f.fulltexts) register(api.researchReviewFullTextCapabilities, () =>
    api.registerResearchReviewFullTextCapabilities(context, f.fulltexts));
  if (f.fullScreening) register(api.researchReviewFullTextScreeningCapabilities, () =>
    api.registerResearchReviewFullTextScreeningCapabilities(context, f.fullScreening, f.fullArbitration, f.fullFreezing));
  if (f.extractions) register(api.researchReviewExtractionCapabilities, () =>
    api.registerResearchReviewExtractionCapabilities(context, f.extractions));
  if (f.qualityPlans) register(api.researchReviewQualityCapabilities, () =>
    api.registerResearchReviewQualityCapabilities(context, f.qualityPlans, f.assessments));
  if (f.studies) register(api.researchReviewStudiesCapabilities, () => api.registerResearchReviewStudiesCapabilities(context, f.studies));
  if (f.reports) register([api.researchReviewReportCapability], () => api.registerResearchReviewReportCapability(context, f.reports));
  const tools = api.createResearchTools({
    capabilities: registry, projectId: f.project.id, signal,
    dispatchStage: async () => assert.fail('review tools cannot dispatch a research stage')
  });
  return {
    registry, tools, read: tools.find(value => value.name === 'research_review_read'),
    title: tools.find(value => value.name === 'research_review_suggest_title'),
    fulltext: tools.find(value => value.name === 'research_review_suggest_fulltext')
  };
}

async function titleScene() {
  const f = await createReviewScreeningPlanFixture(api);
  f.plan = f.screening.createPlan(f.input, actor);
  f.phase = {...f.get, phase: 'title_abstract'};
  f.target = {corpusId: f.corpus.snapshot.id, expectedPlanHash: f.plan.snapshotHash, hitId: f.corpus.snapshot.hits[0].id, outcome: include};
  return f;
}

function operation(toolName, key = 'review-tool-exact-operation', attemptId = 'attempt-1', receipts = []) {
  return api.createCapabilityOperationContext({
    operationId: key, idempotencyKey: key, toolCallId: `call:${key}`, toolName,
    canonicalToolIdentity: `builtin:${toolName}`, toolVersion: '1', attemptId, leaseGeneration: 1,
    recordReceipt: value => receipts.push(value)
  });
}

const run = (context, tool, input) => api.runWithCapabilityOperationContext(context, () => tool.invoke(input));
const pageTarget = (f, kind, offset = 0, limit = 2) => ({kind, corpusId: f.corpus.snapshot.id, offset, limit});

function reports(f) {
  f.studies = new api.ResearchReviewStudiesRepository(f.db, f.repository, f.fullFreezing, f.fulltexts, () => f.time);
  f.assessments = new api.ResearchReviewQualityAssessmentRepository(f.db, f.repository, f.qualityPlans, f.extractions, f.fullFreezing, () => f.time);
  f.reports = new api.ResearchReviewReportService(f.db, f.repository, f.corpora, f.reviews, f.dedup,
    f.freezing, f.fullFreezing, f.studies, f.extractions, f.qualityPlans, f.assessments);
  return f;
}

test('review tools and frozen manifest share the same descriptors and only proposals have effects', async () => {
  const f = await titleScene();
  try {
    const {tools} = connect(f);
    assert.deepEqual(tools.map(value => value.name).sort(), api.RESEARCH_TOOL_DESCRIPTORS.map(value => value.name).sort());
    const descriptors = api.RESEARCH_TOOL_DESCRIPTORS.filter(value => value.name.startsWith('research_review_'));
    assert.deepEqual(descriptors.map(value => [value.name, value.effectClass, value.executionScopes]), [
      ['research_review_read', 'none', ['main', 'subagent']],
      ['research_review_suggest_title', 'external_call', ['main']],
      ['research_review_suggest_fulltext', 'external_call', ['main']]
    ]);
    for (const name of ['research_review_suggest_title', 'research_review_suggest_fulltext']) {
      const shape = tools.find(value => value.name === name).schema.shape;
      for (const forbidden of ['projectId', 'requestId', 'actor', 'reviewerId', 'origin']) assert.equal(forbidden in shape, false);
    }
    assert.equal(tools.some(value => /research_review_(save|freeze|adjudicate|approve)/u.test(value.name)), false);
  } finally {await f.dispose();}
});

test('assistant reads real protocol/query/corpus/hit and pending screening pages without mutation or new retrieval', async () => {
  const f = await titleScene();
  try {
    const {read} = connect(f), before = f.changes(), network = f.calls.length;
    const protocols = await read.invoke({kind: 'protocols', limit: 1});
    assert.equal(protocols.capped, true); assert.deepEqual(protocols.items, [f.protocol]);
    assert.deepEqual(await read.invoke({kind: 'protocol', versionId: f.protocol.version.id}), f.protocol);
    const searches = await read.invoke({kind: 'searches', versionId: f.protocol.version.id, limit: 1});
    assert.equal(searches.items.length, 1); assert.equal(searches.capped, true);
    const id = searches.items[0].snapshot.id;
    assert.deepEqual(await read.invoke({kind: 'search', reviewSearchId: id}), searches.items[0]);
    const pool = await read.invoke({kind: 'search_pool', reviewSearchId: id, offset: 1, limit: 2});
    assert.deepEqual(pool, f.reviews.readPool({projectId: f.project.id, reviewSearchId: id, offset: 1, limit: 2}));
    const corpora = await read.invoke({kind: 'corpora', versionId: f.protocol.version.id, limit: 1});
    assert.equal(corpora.capped, true); assert.equal(corpora.items[0].snapshotHash, f.corpus.snapshotHash);
    assert.equal(corpora.items[0].identifiedRecords, 8);
    const corpus = await read.invoke(pageTarget(f, 'corpus', 2));
    assert.equal(corpus.snapshotHash, f.corpus.snapshotHash); assert.equal(corpus.page.total, 8);
    assert.equal(corpus.page.hasMore, true); assert.deepEqual(corpus.page.items, f.corpus.snapshot.hits.slice(2, 4));
    assert.equal('hits' in corpus.basis, false);
    const hitId = corpus.page.items[0].id;
    assert.deepEqual(await read.invoke({kind: 'hit', corpusId: f.get.corpusId, hitId}), f.corpora.getHit({...f.get, hitId}));
    assert.deepEqual(await read.invoke({kind: 'screening_plan', corpusId: f.get.corpusId}), f.plan);
    const phase = await read.invoke(pageTarget(f, 'title_phase'));
    assert.equal(phase.counts.pending, 8); assert.equal(phase.page.total, 8);
    assert.equal(phase.freezeHash, null); assert.equal(phase.frozenAuthorityPage, null);
    assert.deepEqual(phase.page.items, f.freezing.getPhase(f.phase).items.slice(0, 2));
    assert.equal(f.changes(), before); assert.equal(f.calls.length, network);
  } finally {await f.dispose();}
});

test('strict tool inputs cannot select project/actor/request identities and foreign or missing receipts fail', async () => {
  const f = await titleScene();
  try {
    const {read, title} = connect(f), other = f.repository.createProject({title: 'Foreign', description: 'Synthetic', workspacePath: '/tmp/review-tool-foreign'});
    const before = f.changes();
    for (const extra of [{projectId: other.id}, {actor}, {requestId: 'chosen'}, {origin: 'chosen'}, {reviewerId: 'chosen'}]) {
      await assert.rejects(title.invoke({...f.target, ...extra}));
    }
    await assert.rejects(read.invoke({...pageTarget(f, 'corpus'), projectId: other.id}));
    await assert.rejects(read.invoke({...pageTarget(f, 'corpus'), limit: 31}));
    await assert.rejects(read.invoke({kind: 'quality_plan', corpusId: f.get.corpusId}));
    const otherTools = connect({...f, project: other});
    await assert.rejects(otherTools.read.invoke(pageTarget(f, 'corpus')), error => error.code === 'research_review_project_mismatch');
    await assert.rejects(read.invoke({kind: 'protocol', versionId: 'absent'}), error => error.code === 'research_review_protocol_not_found');
    assert.equal(f.changes(), before);
  } finally {await f.dispose();}
});

test('title proposal records trusted operation, replays exact retry and never creates a human decision', async () => {
  const f = await titleScene();
  try {
    const {title, read} = connect(f), receipts = [], context = operation(title.name, 'title-proposal-key', 'attempt-1', receipts);
    const first = await run(context, title, f.target);
    assert.equal(first.snapshot.request.projectId, f.project.id);
    assert.equal(first.snapshot.request.requestId, context.idempotencyKey);
    assert.equal(first.snapshot.origin.toolCallId, context.toolCallId);
    assert.equal(first.snapshot.origin.canonicalToolIdentity, context.canonicalToolIdentity);
    assert.equal(first.snapshot.origin.capabilityName, 'research.reviewScreening.suggest');
    assert.equal(receipts[0].idempotencyKey, context.idempotencyKey);
    const before = f.changes();
    assert.deepEqual(await run(operation(title.name, context.idempotencyKey, 'attempt-2'), title, f.target), first);
    await assert.rejects(run(operation(title.name, context.idempotencyKey), title,
      {...f.target, outcome: {decision: 'uncertain', reason: 'Another actual judgement'}}), error => error.code === 'research_review_request_conflict');
    assert.equal(f.changes(), before);
    const phase = await read.invoke(pageTarget(f, 'title_phase'));
    assert.equal(phase.counts.pending, 8); assert.equal(phase.counts.included, 0); assert.equal(phase.page.items[0].suggestionCount, 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions').pluck().get(), 0);
    assert.deepEqual(await read.invoke({kind: 'title_suggestions', corpusId: f.get.corpusId, hitId: f.target.hitId, offset: 0, limit: 2}), [first]);
  } finally {await f.dispose();}
});

test('proposal without matching harness context, stale plan or undeclared criterion is rejected before scientific write', async () => {
  const f = await titleScene();
  try {
    const {title} = connect(f), before = f.changes();
    await assert.rejects(title.invoke(f.target), /research_review_screening_tool_context_required/u);
    await assert.rejects(run(operation('another_tool'), title, f.target), /research_review_screening_tool_context_required/u);
    await assert.rejects(run(operation(title.name), title, {...f.target, expectedPlanHash: 'a'.repeat(64)}),
      error => error.code === 'research_review_screening_version_conflict');
    await assert.rejects(run(operation(title.name), title,
      {...f.target, outcome: {...include, inclusionCriterionIds: ['fabricated']}}),
    error => error.code === 'research_review_screening_criterion_not_declared');
    assert.equal(f.changes(), before);
  } finally {await f.dispose();}
});

test('fulltext tool reads exact title authority and explicit source, records proposal and rejects actual original-byte drift', async () => {
  const f = await createReviewFullTextScreeningFixture(api);
  try {
    const binding = await f.bind(), {read, title, fulltext} = connect(f);
    const phase = await read.invoke(pageTarget(f, 'fulltext_phase'));
    assert.equal(phase.titleFreezeHash, f.title.freezeHash); assert.equal(phase.page.total, 7);
    assert.deepEqual(phase.page.items[0].binding, binding); assert.equal(phase.counts.included, 0);
    const frozenTitle = await read.invoke(pageTarget(f, 'title_phase', 2));
    assert.equal(frozenTitle.freezeHash, f.title.freezeHash);
    assert.deepEqual(frozenTitle.frozenAuthorityPage.items, f.title.freeze.authority.items.slice(2, 4));
    assert.deepEqual(await read.invoke({kind: 'fulltext_binding', corpusId: f.get.corpusId, bindingId: binding.snapshot.id}), binding);
    const {projectId, phase: ignored, requestId, ...target} = f.target(0, 'discard-model-request');
    const suggestion = await run(operation(fulltext.name, 'fulltext-key'), fulltext, {...target, outcome: include});
    assert.equal(suggestion.snapshot.origin.capabilityName, 'research.reviewFullTextScreening.suggest');
    assert.equal(suggestion.snapshot.request.requestId, 'fulltext-key'); assert.equal(suggestion.sourceCurrent, true);
    assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.pending, 1);
    assert.deepEqual(await read.invoke({kind: 'fulltext_suggestions', corpusId: f.get.corpusId, hitId: target.hitId, offset: 0, limit: 2}), [suggestion]);
    await assert.rejects(run(operation(title.name), title, {
      corpusId: f.get.corpusId, hitId: target.hitId, expectedPlanHash: f.plan.snapshotHash, outcome: include
    }), error => error.code === 'research_review_screening_already_frozen');
    const {writeFile} = await import('node:fs/promises');
    await writeFile(f.sourcePath, 'changed actual original bytes');
    const before = f.changes();
    await assert.rejects(run(operation(fulltext.name, 'drifted-source-key'), fulltext, {...target, outcome: include}),
      error => ['research_document_source_changed', 'research_review_fulltext_source_changed'].includes(error.code));
    assert.equal(f.changes(), before); assert.equal(f.fullScreening.getPhase(f.fullPhase).counts.included, 0);
  } finally {await f.cleanup();}
});

test('report and evidence pages retain real conserved counts, null study/quality state and exact original extraction', async () => {
  const f = reports(await createReviewQualityFixture(api));
  try {
    const {read} = connect(f), before = f.changes(), network = f.calls.length, report = f.reports.get(f.get);
    const extraction = await read.invoke({kind: 'extraction', corpusId: f.get.corpusId, extractionId: f.extraction.snapshot.id});
    assert.deepEqual(extraction, f.extraction);
    assert.equal(await read.invoke({kind: 'quality_plan', corpusId: f.get.corpusId, extractionId: f.extraction.snapshot.id}), null);
    assert.equal(await read.invoke({kind: 'studies', corpusId: f.get.corpusId}), null);
    const counts = await read.invoke({...pageTarget(f, 'report'), section: 'counts'});
    assert.deepEqual(counts.counts, report.body.counts); assert.equal(counts.counts.includedStudies, null);
    assert.equal(counts.bodyHash, report.bodyHash); assert.deepEqual(counts.basis, report.body.basis);
    for (const [section, items] of [['queries', report.body.queries], ['records', report.body.records], ['exclusions', report.body.exclusions]]) {
      const result = await read.invoke({...pageTarget(f, 'report', 0, 1), section});
      assert.equal(result.page.total, items.length); assert.deepEqual(result.page.items, items.slice(0, 1));
      assert.equal(result.bodyHash, report.bodyHash);
    }
    const evidence = await read.invoke({...pageTarget(f, 'report', 0, 1), section: 'evidence'});
    assert.deepEqual(evidence.page.items[0], {...report.body.evidenceTable[0], referenceStatus: report.evidenceStatus[0]});
    assert.equal(evidence.page.items[0].qualityPlan, null); assert.equal(evidence.page.items[0].assessment, null);
    const beyond = await read.invoke({...pageTarget(f, 'report', 100, 1), section: 'records'});
    assert.deepEqual(beyond.page.items, []); assert.equal(beyond.page.total, report.body.records.length); assert.equal(beyond.page.hasMore, false);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, network);
  } finally {await f.cleanup();}
});

test('quality definitions, missing assessment and archived source status stay readable without reinterpretation or new suggestions', async () => {
  const f = reports(await createReviewQualityFixture(api));
  try {
    const plan = await f.qualityPlans.create(f.qualityInput(), actor), {read, fulltext} = connect(f);
    assert.deepEqual(await read.invoke({kind: 'quality_plan', corpusId: f.get.corpusId, extractionId: f.extraction.snapshot.id}), plan);
    assert.equal(await read.invoke({kind: 'quality_assessment', corpusId: f.get.corpusId,
      extractionId: f.extraction.snapshot.id, qualityPlanId: plan.snapshot.id}), null);
    const original = await read.invoke({...pageTarget(f, 'report'), section: 'evidence'});
    f.reparse();
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    const before = f.changes(), old = await read.invoke({...pageTarget(f, 'report'), section: 'evidence'});
    assert.equal(old.bodyHash, original.bodyHash); assert.deepEqual(old.counts, original.counts);
    assert.equal(old.sourcesCurrent, false); assert.equal(old.page.items[0].referenceStatus.extraction.referenceStatus, 'superseded');
    assert.deepEqual(old.page.items[0].extraction, original.page.items[0].extraction);
    const {projectId, phase, requestId, ...target} = f.target(0, 'ignored-request', f.bound.get(0));
    await assert.rejects(run(operation(fulltext.name), fulltext, {...target, outcome: include}),
      error => error.code === 'research_project_archived');
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('aborted tools send no write and cancellation while reading does not acknowledge a late result', async () => {
  const f = await titleScene();
  try {
    const controller = new AbortController(), {title, read} = connect(f, controller.signal), before = f.changes();
    controller.abort(new Error('explicit-cancel'));
    await assert.rejects(run(operation(title.name), title, f.target), /explicit-cancel/u);
    await assert.rejects(read.invoke({kind: 'protocol', versionId: f.protocol.version.id}), /explicit-cancel/u);
    assert.equal(f.changes(), before);
    const delayed = new AbortController();
    const tools = api.createResearchTools({
      projectId: f.project.id, signal: delayed.signal, dispatchStage: async () => assert.fail('no dispatch'),
      capabilities: {invoke: async (name, request) => {
        assert.equal(name, 'research.reviewProtocol.get'); assert.equal(request.projectId, f.project.id);
        delayed.abort(new Error('cancel-during-read')); return f.protocol;
      }}
    });
    await assert.rejects(tools.find(value => value.name === read.name).invoke({kind: 'protocol', versionId: f.protocol.version.id}), /cancel-during-read/u);
    assert.equal(f.changes(), before);
  } finally {await f.dispose();}
});

test('cancellation after a real proposal commit preserves the receipt and exact operation retry returns it once', async () => {
  const f = await titleScene();
  try {
    const {registry, title} = connect(f), controller = new AbortController(), key = 'lost-proposal-response';
    const interrupted = api.createResearchTools({
      projectId: f.project.id, signal: controller.signal, dispatchStage: async () => assert.fail('no dispatch'),
      capabilities: {invoke: async (name, request) => {
        const result = await registry.invoke(name, request);
        controller.abort(new Error('cancel-after-persist')); return result;
      }}
    }).find(value => value.name === title.name);
    await assert.rejects(run(operation(title.name, key), interrupted, f.target), /cancel-after-persist/u);
    const saved = f.decisions.listSuggestions({...f.phase, hitId: f.target.hitId, offset: 0, limit: 2});
    assert.equal(saved.length, 1); assert.equal(saved[0].snapshot.request.requestId, key);
    const before = f.changes();
    assert.deepEqual(await run(operation(title.name, key, 'attempt-2'), title, f.target), saved[0]);
    assert.equal(f.changes(), before); assert.equal(f.decisions.getPhase(f.phase).counts.included, 0);
  } finally {await f.dispose();}
});
