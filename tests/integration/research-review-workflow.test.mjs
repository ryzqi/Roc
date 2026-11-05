import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {awaitReviewSearchFixture} from '../unit/fixtures/research-review-search.mjs';
import {createReviewFullTextScreeningFixture, fullTextInclude} from '../unit/fixtures/research-review-fulltext-screening.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function mainHarness(f) {
  const runId = 'review-workflow-chat', threadId = 'review-workflow-thread', time = new Date().toISOString();
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: f.project.id
  }).manifest;
  const snapshot = api.createRunExecutionSnapshot({runId, threadId, inputMessageId: 'review-workflow-message', snapshot: {
    schemaVersion: 9, submissionHash: 'a'.repeat(64),
    taskContract: {contractVersion: 1, objective: 'Execute frozen review queries', constraints: [], kind: 'reply',
      criteria: [{id: 'query', description: 'Read exact query receipts', check: {kind: 'response'}}]},
    runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture'}, mode: 'run', workspace: null,
    capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
    researchProjectId: f.project.id, budget: api.createRunBudget({contextBudgetTokens: null, startedAt: time})
  }});
  f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Review workflow','Review workflow','active',?,?,?)`).run(threadId, f.project.id, time, time);
  f.agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Review workflow','running',?,'{}','chat',?,9)`).run(runId, threadId, time, JSON.stringify(snapshot));
  const registry = new api.CapabilityRegistry(), context = {pluginId: 'research', capabilities: registry};
  const broker = new api.ExecutionGrantBroker(f.agentDb);
  const register = (descriptors, install) => {
    for (const descriptor of descriptors) registry.declare('research', descriptor);
    install();
  };
  f.extractions = new api.ResearchReviewExtractionRepository(f.db, f.repository, f.fullFreezing, f.fulltexts, f.service, () => f.time);
  f.qualityPlans = new api.ResearchReviewQualityPlanRepository(f.db, f.repository, f.extractions, f.fullFreezing, () => f.time);
  f.assessments = new api.ResearchReviewQualityAssessmentRepository(f.db, f.repository, f.qualityPlans, f.extractions, f.fullFreezing, () => f.time);
  f.studies = new api.ResearchReviewStudiesRepository(f.db, f.repository, f.fullFreezing, f.fulltexts, () => f.time);
  f.reports = new api.ResearchReviewReportService(f.db, f.repository, f.corpora, f.reviews, f.dedup, f.freezing,
    f.fullFreezing, f.studies, f.extractions, f.qualityPlans, f.assessments);
  register(api.researchSystematicReviewCapabilities, () => api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews));
  register(api.researchReviewSearchCapabilities, () => api.registerResearchReviewSearchCapabilities(context, f.reviews));
  register(api.researchOwnedReviewSearchCapabilities, () => api.registerResearchOwnedReviewSearchCapabilities(context, f.reviews, broker));
  register(api.researchReviewCorpusCapabilities, () => api.registerResearchReviewCorpusCapabilities(context, f.corpora));
  register(api.researchReviewDeduplicationCapabilities, () => api.registerResearchReviewDeduplicationCapabilities(context, f.dedup));
  register(api.researchReviewScreeningCapabilities, () =>
    api.registerResearchReviewScreeningCapabilities(context, f.screening, f.decisions, f.arbitration, f.freezing));
  register(api.researchReviewFullTextCapabilities, () => api.registerResearchReviewFullTextCapabilities(context, f.fulltexts));
  register(api.researchReviewFullTextScreeningCapabilities, () =>
    api.registerResearchReviewFullTextScreeningCapabilities(context, f.fullScreening, f.fullArbitration, f.fullFreezing));
  register(api.researchReviewExtractionCapabilities, () => api.registerResearchReviewExtractionCapabilities(context, f.extractions));
  register(api.researchReviewQualityCapabilities, () => api.registerResearchReviewQualityCapabilities(context, f.qualityPlans, f.assessments));
  register(api.researchReviewStudiesCapabilities, () => api.registerResearchReviewStudiesCapabilities(context, f.studies));
  register([api.researchReviewReportCapability], () => api.registerResearchReviewReportCapability(context, f.reports));
  const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, request) => registry.invoke(name, request)});
  const tools = api.createManifestAuthorizedResearchTools({
    researchProjectId: f.project.id, runId, threadId, capabilityManifest: manifest,
    executionGrantBroker: broker, capabilities: registry, abortSignal: new AbortController().signal
  });
  return {runId, threadId, registry, bridge, tools};
}

async function sdk(tool, args, key) {
  const invoke = () => tool.invoke({type: 'tool_call', id: key, name: tool.name, args});
  const operation = api.createCapabilityOperationContext({
    operationId: key, idempotencyKey: key, toolCallId: key, toolName: tool.name,
    canonicalToolIdentity: `research:${tool.name}`, toolVersion: 'roc-research-tool-v1',
    attemptId: 'attempt-1', leaseGeneration: 1, recordReceipt: () => {}
  });
  const message = tool.name === 'research_review_read' ? await invoke() :
    await api.runWithCapabilityOperationContext(operation, invoke);
  return JSON.parse(message.content);
}

test('owned SDK queries feed generated human review APIs through original PDF evidence to a conserved immutable report', async () => {
  const f = await createReviewFullTextScreeningFixture(api), harness = mainHarness(f), windowId = 901;
  const human = async (method, request) => {
    const result = await harness.bridge.invoke(`research.${method}`, [request], windowId);
    assert.equal(result.ok, true, JSON.stringify({method, result}));
    return result.data;
  };
  try {
    const libraryBefore = f.db.prepare('SELECT * FROM research_library ORDER BY id').all();
    // The source fixture already executed its own queries. Start a distinct,
    // explicitly frozen review instead of replaying a completed query as new.
    const draft = await human('saveReviewProtocol', {
      projectId: f.project.id, requestId: 'workflow-protocol', protocolId: null,
      expectedVersionId: null, expectedVersionHash: null, body: f.protocol.version.body, deviationReason: null
    });
    const protocol = await human('freezeReviewProtocol', {
      projectId: f.project.id, requestId: 'workflow-protocol-freeze', versionId: draft.version.id,
      expectedVersionHash: draft.versionHash, reviewNote: 'Human confirms the separate controlled workflow protocol.'
    });
    const start = harness.tools.find(tool => tool.name === 'research_review_execute_query');
    const read = harness.tools.find(tool => tool.name === 'research_review_read');
    const searches = [];
    for (let queryIndex = 0; queryIndex < 2; queryIndex++) {
      const started = await sdk(start, {
        versionId: protocol.version.id, expectedFreezeHash: protocol.freezeHash,
        databaseIndex: 0, queryIndex, retryOf: null, expectedRetrySnapshotHash: null
      }, `workflow-query-${queryIndex}`);
      searches.push(await awaitReviewSearchFixture(f, started.search));
    }
    const task = f.tasks.taskForChat(harness.runId);
    assert.ok(task); assert.notEqual(task.id, f.run.taskId);
    const queryExecutions = f.tasks.executions(task.id, f.project.id).filter(execution => execution.kind === 'review_search');
    assert.deepEqual(queryExecutions.map(execution => execution.executionId).sort(), searches.map(search => search.snapshot.id).sort());
    assert.ok(queryExecutions.every(execution => execution.parentKind === 'chat' && execution.parentExecutionId === harness.runId));
    const corpus = await human('createReviewCorpus', {
      projectId: f.project.id, requestId: 'workflow-corpus', versionId: protocol.version.id,
      expectedFreezeHash: protocol.freezeHash, searches: searches.map(search => ({
        reviewSearchId: search.snapshot.id, expectedSnapshotHash: search.snapshotHash, expectedReceiptHash: search.receiptHash
      }))
    });
    const target = {projectId: f.project.id, corpusId: corpus.snapshot.id};
    const dedup = await human('freezeReviewDeduplication', {
      ...target, requestId: 'workflow-dedup', expectedCorpusHash: corpus.snapshotHash, decisions: [],
      reviewNote: 'Controlled fixture explicitly reviews all original records and removes no duplicate.'
    });
    const plan = await human('createReviewScreeningPlan', {
      ...f.plan.snapshot.request, ...target, requestId: 'workflow-plan',
      expectedCorpusHash: corpus.snapshotHash, expectedDedupFreezeHash: dedup.freezeHash
    });
    const titleTarget = {...target, phase: 'title_abstract'};
    const reviewers = plan.snapshot.request.titleAbstractReviewers;
    for (const [index, hit] of corpus.snapshot.hits.entries()) {
      for (const reviewer of reviewers) await human('saveReviewScreeningDecision', {
        ...titleTarget, hitId: hit.id, expectedPlanHash: plan.snapshotHash, requestId: `workflow-title-${index}-${reviewer.id}`,
        reviewerId: reviewer.id, outcome: index === 1 ?
          {decision: 'exclude', exclusionCriterionId: 'no-outcome', reason: 'Controlled human primary exclusion.'} :
          {decision: 'include', inclusionCriterionIds: ['controlled'], reason: 'Controlled human title review.'},
        consideredSuggestion: null, parentDecisionId: null, expectedParentHash: null, revisionReason: null
      });
    }
    const title = await human('freezeReviewScreeningPhase', {
      ...titleTarget, requestId: 'workflow-title-freeze', expectedReviewHash: f.freezing.getPhase(titleTarget).reviewHash,
      reviewNote: 'Both declared human reviewers confirm all original title decisions.'
    });
    const includedHit = corpus.snapshot.hits[0];
    const binding = await human('saveReviewFullTextBinding', {
      ...target, hitId: includedHit.id, requestId: 'workflow-binding', expectedTitleFreezeHash: title.freezeHash,
      outcome: {kind: 'retrieved', selection: f.selection, relationNote: 'Human explicitly binds the controlled original PDF to this report.'},
      parentBindingId: null, expectedParentHash: null, revisionReason: null
    });
    const fullTarget = {...target, phase: 'full_text'};
    const reviewerId = plan.snapshot.request.fullTextReviewers[0].id;
    for (const reviewer of plan.snapshot.request.fullTextReviewers) await human('saveReviewFullTextDecision', {
      ...fullTarget, expectedPlanHash: plan.snapshotHash, expectedTitleFreezeHash: title.freezeHash,
      hitId: includedHit.id, requestId: `workflow-full-${reviewer.id}`, reviewerId: reviewer.id,
      bindingId: binding.snapshot.id, expectedBindingHash: binding.snapshotHash, outcome: fullTextInclude,
      consideredSuggestion: null, parentDecisionId: null, expectedParentHash: null, revisionReason: null
    });
    for (let index = 2; index < corpus.snapshot.hits.length; index++) await human('saveReviewFullTextBinding', {
      ...target, hitId: corpus.snapshot.hits[index].id, requestId: `workflow-unretrieved-${index}`,
      expectedTitleFreezeHash: title.freezeHash, outcome: {kind: 'not_retrieved', reason: 'Explicit controlled retrieval gap.'},
      parentBindingId: null, expectedParentHash: null, revisionReason: null
    });
    const full = await human('freezeReviewFullTextScreening', {
      ...fullTarget, requestId: 'workflow-full-freeze', expectedReviewHash: f.fullFreezing.getPhase(fullTarget).reviewHash,
      reviewNote: 'Human confirms one included bound report and six explicit retrieval gaps.'
    });
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: `document:${f.selection.parseId}:chunk:0`});
    const source = f.repository.evidence.inspectEvidence(evidence.id, f.project.id);
    const reference = {id: evidence.id, expectedHash: digest({evidence: source.evidence, sourceLocator: source.sourceLocator})};
    const extraction = await human('saveReviewExtraction', {
      ...target, hitId: includedHit.id, requestId: 'workflow-extraction', expectedFullFreezeHash: full.freezeHash,
      bindingId: binding.snapshot.id, expectedBindingHash: binding.snapshotHash, reviewerId,
      reviewNote: 'Controlled source-bound values test engineering provenance.',
      studyDesign: {value: {kind: 'text', text: f.protocol.version.body.qualityAssessment[0].studyDesign}, evidence: [reference]},
      fields: [{fieldId: f.protocol.version.body.extractionFields[0].id, unit: f.protocol.version.body.extractionFields[0].unit,
        value: {kind: 'number', number: 1}, evidence: [reference]}],
      parentExtractionId: null, expectedParentHash: null, revisionReason: null
    });
    const quality = await human('createReviewQualityPlan', {
      ...target, hitId: includedHit.id, requestId: 'workflow-quality-plan', extractionId: extraction.snapshot.id,
      expectedExtractionHash: extraction.snapshotHash, framework: f.protocol.version.body.qualityAssessment[0],
      definition: {origin: 'user_declared', documentationNote: 'Controlled engineering quality categories.',
        domains: [{id: 'method', label: 'Declared method', question: 'Can this controlled method be judged?',
          judgements: ['adequate', 'unclear']}], overallJudgements: ['reviewed', 'concerns']},
      reviewerId, reviewNote: 'Human explicitly selects this controlled framework.'
    });
    const assessment = await human('saveReviewQualityAssessment', {
      ...target, extractionId: extraction.snapshot.id, qualityPlanId: quality.snapshot.id, requestId: 'workflow-quality',
      expectedPlanHash: quality.snapshotHash, expectedExtractionHash: extraction.snapshotHash,
      domains: [{domainId: 'method', value: {kind: 'judged', judgement: 'adequate', reason: 'Controlled human domain judgment.'},
        evidence: [reference]}],
      overall: {value: {kind: 'judged', judgement: 'concerns', reason: 'Controlled overall judgment is explicitly separate.'}, evidence: [reference]},
      reviewerId, reviewNote: 'Explicit human judgment preserves exact evidence.', parentAssessmentId: null, expectedParentHash: null, revisionReason: null
    });
    const studies = await human('saveReviewStudies', {
      ...target, requestId: 'workflow-studies', expectedFullFreezeHash: full.freezeHash,
      groups: [{studyId: 'controlled-study', label: 'Controlled study', reason: 'Explicit human identity declaration.',
        reports: [{hitId: includedHit.id, expectedBindingHash: binding.snapshotHash, sourceNote: 'Exact included original PDF report.'}]}],
      reviewerId, reviewNote: 'Human confirms complete report membership.', parentGroupingId: null, expectedParentHash: null, revisionReason: null
    });
    const report = await human('getReviewReport', target);
    assert.deepEqual(report.body.counts, {
      identifiedRecords: 8, removedDuplicates: 0, recordsScreened: 8, recordsExcluded: 1, reportsSought: 7,
      reportsNotRetrieved: 6, reportsAssessed: 1, reportsExcluded: 0, includedReports: 1, includedStudies: 1
    });
    assert.deepEqual(report.body.queries.map(query => query.source.reviewSearchId).sort(), queryExecutions.map(execution => execution.executionId).sort());
    assert.ok(report.body.queries.every(query => query.search.snapshot.actor.kind === 'agent' && query.search.snapshot.actor.id === harness.runId));
    assert.equal(report.body.evidenceTable[0].extraction.snapshotHash, extraction.snapshotHash);
    assert.equal(report.body.evidenceTable[0].assessment.snapshotHash, assessment.snapshotHash);
    assert.equal(report.body.studyGrouping.snapshotHash, studies.snapshotHash);
    for (const saved of [corpus, plan, binding, extraction, quality, assessment, studies]) {
      assert.deepEqual(saved.snapshot.actor, {kind: 'user', id: `window:${windowId}`});
    }
    const before = f.changes(), network = f.calls.length;
    const assistantReport = await sdk(read, {kind: 'report', corpusId: target.corpusId, section: 'counts', offset: 0, limit: 10}, 'workflow-report-read');
    assert.equal(assistantReport.bodyHash, report.bodyHash); assert.deepEqual(assistantReport.counts, report.body.counts);
    assert.equal(f.changes(), before); assert.equal(f.calls.length, network);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_library ORDER BY id').all(), libraryBefore);
    f.reparse();
    const historical = await human('getReviewReport', target);
    assert.equal(historical.bodyHash, report.bodyHash); assert.equal(historical.sourcesCurrent, false);
    assert.deepEqual(historical.body.counts, report.body.counts);
    const directory = join(process.cwd(), '.artifacts/research-optimization/pr09-closure');
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, 'owned-query-to-review.json'), JSON.stringify({
      scope: 'deterministic engineering integration with controlled human declarations and original PDF',
      task, queryExecutions, sourceHash: f.document.sourceHash, sourceLocator: source.sourceLocator,
      report, historicalReferenceState: {bodyHash: historical.bodyHash, sourcesCurrent: historical.sourcesCurrent},
      events: f.tasks.events({projectId: f.project.id, taskId: task.id, afterSequence: 0, limit: 200}).events
    }, null, 2));
    assert.equal(f.errors.length, 0);
  } finally {await f.cleanup();}
});
