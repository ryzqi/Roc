import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
import {unknownExperiment, loadResearchTestApi, createResearchFixture} from './fixtures/research-test-kit.mjs';

const api = await loadResearchTestApi();
after(() => api.dispose());

function unavailableKey() {
  return new api.RocDomainError({code: 'research_embedding_key_unavailable',
    message: '无法读取嵌入模型密钥，请在「设置 → 向量与 RAG」重新录入密钥并保存。',
    category: 'validation', retryable: false});
}

test('author receives an explicit failed knowledge search and can report the limitation', async () => {
  const f = createResearchFixture(api, 'writing');
  const output = {title: 'Limited engineering draft', markdown: 'Knowledge search was unavailable; no new sources were examined.',
    claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Additional knowledge search was unavailable.', status: 'pending', evidenceIds: []}],
    sections: [{title: 'Limitations', claimIndexes: [0]}], verdict: 'uncertain'};
  let responseName, calls = 0, searches = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'knowledge-search-error-boundary'; }
    bindTools(tools) {
      const response = tools.find(entry => (entry.function?.name ?? entry.name) !== 'search_knowledge');
      responseName = response.function?.name ?? response.name;
      return this;
    }
    async _generate(messages) {
      assert.ok(++calls <= 2, 'credential failure must not cause automatic search retries');
      if (calls === 2) {
        const result = messages.find(message => message.tool_call_id === 'knowledge-search');
        assert.equal(result?.status, 'error');
        assert.match(String(result.content), /research_embedding_key_unavailable/);
        assert.match(String(result.content), /设置.*向量与 RAG/);
        assert.match(String(result.content), /No search results/);
      }
      const call = calls === 1
        ? {id: 'knowledge-search', name: 'search_knowledge', args: {query: 'AgentPoison', limit: 3}}
        : {id: 'limited-output', name: responseName, args: output};
      return {generations: [{text: '', message: new AIMessage({content: '',
        tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const signal = new AbortController().signal, context = f.repository.runs.getContext(f.run.id);
    const tools = f.withWorker(() => api.createResearchRoleTools({run: f.run, context,
      repository: f.repository, signal, capabilities: {invoke: async name => {
        assert.equal(name, 'research.knowledge.search'); searches++;
        throw unavailableKey();
      }}})).filter(tool => tool.name === 'search_knowledge');
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture', modelId: 'fixture', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'},
      api.createRunModelConfig({contextWindowTokens: 200000, maxOutputTokens: 16000}));
    const result = await f.withWorker(() => prepared.execute({run: f.run, context, tools, signal,
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(searches, 1);
    assert.equal(calls, 2);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    assert.equal(f.repository.runs.get(f.run.id, f.project.id).outputArtifactIds.length, 0);
  } finally {f.close();}
});

test('knowledge search keeps cancellation and unexpected failures fatal', async () => {
  for (const cancelled of [false, true]) {
    const f = createResearchFixture(api, 'writing'), controller = new AbortController();
    const failure = new Error(cancelled ? 'research_run_cancelled' : 'unexpected_provider_failure');
    try {
      const context = f.repository.runs.getContext(f.run.id);
      const search = f.withWorker(() => api.createResearchRoleTools({run: f.run, context,
        repository: f.repository, signal: controller.signal, capabilities: {invoke: async () => {
          if (cancelled) {controller.abort(failure); throw unavailableKey();}
          throw failure;
        }}})).find(tool => tool.name === 'search_knowledge');
      await assert.rejects(f.withWorker(() => search.invoke({query: 'AgentPoison', limit: 3})),
        error => error === failure);
    } finally {f.close();}
  }
});
