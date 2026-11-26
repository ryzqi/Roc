import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api, exposure;
before(async () => {
  [api, exposure] = await Promise.all([
    importTypeScriptModule('src/main/plugins/agent/writing-tools.ts', {platform: 'node', external: ['@langchain/core/tools'], tempDir: '.runtime/tmp'}),
    importTypeScriptModule('src/main/services/deep-agent/model-tool-exposure.ts', {platform: 'node', external: ['langchain', '@langchain/core/messages'], tempDir: '.runtime/tmp'})
  ]);
});

test('writing tools bind project and artifact, reject forged output and preserve cancellation', async () => {
  const controller = new AbortController(), calls = [];
  const result = {contextId: 'context', basisDigest: 'a'.repeat(64), projectId: 'project', artifactId: 'draft',
    sourcePapers: [], relevantFacts: [], originalEvidenceIds: [], supportingClaims: [], counterEvidence: [],
    knowledgeGaps: ['human review missing'], limitations: [], status: 'incomplete'};
  const tools = api.createWritingTools({projectId: 'project', signal: controller.signal,
    capabilities: {invoke: async (name, request, signal) => {calls.push({name, request, signal}); return result;}}});
  const prepare = tools.find(tool => tool.name === 'research_prepare_writing_context');
  const request = {artifactId: 'draft', sectionTitle: 'Related work', sectionGoal: 'Compare assumptions'};
  assert.equal((await prepare.invoke(request)).status, 'incomplete');
  assert.equal(calls[0].name, 'research.writing.prepareContext');
  assert.equal(calls[0].request.projectId, 'project');
  assert.equal(calls[0].signal, controller.signal);
  await assert.rejects(prepare.invoke({...request, projectId: 'other'}));
  result.artifactId = 'different';
  await assert.rejects(prepare.invoke(request), /binding_invalid/);
  controller.abort();
  await assert.rejects(prepare.invoke(request));
  assert.equal(calls.length, 2);
  assert.deepEqual(tools.map(tool => tool.name).sort(), api.WRITING_TOOL_DESCRIPTORS.map(tool => tool.name).sort());
});

test('writing inspections reject results for another durable context', async () => {
  for (const [name, fields] of [
    ['research_check_draft_grounding', {status: 'ready', issues: [], checkedClaimIds: []}],
    ['research_review_writing_impact', {status: 'current', impacts: [], requiresHumanRevision: false}]
  ]) {
    const result = {projectId: 'project', artifactId: 'draft', contextId: 'wrong-context', basisDigest: 'a'.repeat(64), ...fields};
    const tools = api.createWritingTools({projectId: 'project', signal: new AbortController().signal,
      capabilities: {invoke: async () => result}});
    const inspection = tools.find(tool => tool.name === name);
    const request = {artifactId: 'draft', contextId: 'expected-context'};
    await assert.rejects(inspection.invoke(request), /binding_invalid/);
    result.contextId = request.contextId;
    assert.equal((await inspection.invoke(request)).contextId, request.contextId);
  }
});

test('plan mode permits writing inspections but blocks preparation and deep generation before dispatch', async () => {
  const tools = api.createWritingTools({projectId: 'project', signal: new AbortController().signal, capabilities: {}});
  assert.deepEqual(exposure.filterPlanModeModelTools(tools).map(tool => tool.name).sort(),
    ['research_check_draft_grounding', 'research_review_writing_impact']);
  const guard = exposure.createRocPlanRuntimeToolGuardMiddleware();
  for (const name of ['research_prepare_writing_context', 'research_request_paper_deep_knowledge']) {
    let dispatched = false;
    const result = await guard.wrapToolCall({toolCall: {id: 'call', name, args: {}}}, async () => {dispatched = true;});
    assert.equal(result.status, 'error'); assert.equal(dispatched, false);
  }
});
