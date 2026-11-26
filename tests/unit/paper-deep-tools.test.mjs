import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/agent/paper-deep-tools.ts',
  {platform: 'node', external: ['@langchain/core/tools'], tempDir: '.runtime/tmp'});});

test('deep-reading tools pin the project, propagate cancellation and restrict generation to main agent', async () => {
  const controller = new AbortController(), calls = [];
  const tools = api.createPaperDeepTools({projectId: 'project', signal: controller.signal,
    capabilities: {invoke: async (name, request, signal) => {calls.push({name, request, signal}); return {id: 'job'};}}});
  const generate = tools.find(tool => tool.name === 'research_request_paper_deep_knowledge');
  const request = {documentId: 'paper', purpose: 'writing', question: 'Explain the method assumptions',
    dimensions: ['method'], sectionIds: [], objectIds: []};
  await generate.invoke(request);
  assert.equal(calls[0].name, 'research.knowledge.deepRequest');
  assert.equal(calls[0].request.projectId, 'project');
  assert.equal(calls[0].signal, controller.signal);
  await assert.rejects(generate.invoke({...request, projectId: 'other'}));
  controller.abort();
  await assert.rejects(generate.invoke(request));
  assert.equal(calls.length, 1);
  assert.deepEqual(tools.map(tool => tool.name).sort(), api.PAPER_DEEP_TOOL_DESCRIPTORS.map(tool => tool.name).sort());
  assert.deepEqual(api.PAPER_DEEP_TOOL_DESCRIPTORS.find(tool => tool.name === generate.name).executionScopes, ['main']);
});
